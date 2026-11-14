"""JSON API and static site host.

    python -m pokerarena serve --db arena.db --port 8787

That one process serves the website in ``public/`` and the API below. The same
routes are what the Vercel Python function calls, so the deployed site and the
local site behave the same.

    GET  /api/health
    GET  /api/leaderboard?min_hands=0
    GET  /api/bots
    GET  /api/bots/<id>
    GET  /api/matches?limit=40
    GET  /api/hands?limit=30&bot=&match_id=
    GET  /api/hands/<id>
    GET  /api/connect
    GET  /api/live?table=0     the action the shared broadcast is on right now
"""

from __future__ import annotations

import json
import mimetypes
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .bots import BUILTIN, builtin_specs
from .cards import card_str
from .engine import Table
from .evaluator import CATEGORY_NAMES, category
from .models import STREETS
from .storage import Store

MAX_BODY = 64_000


def _jsonable(row) -> dict:
    return {k: row[k] for k in row.keys()}


def leaderboard_payload(store: Store, min_hands: int = 0) -> dict:
    rows = store.leaderboard(min_hands)
    for i, row in enumerate(rows, 1):
        row["rank"] = i
        row["elo"] = round(row["elo"], 1)
        row["bb100"] = round(row["bb100"], 2)
        row["stderr"] = round(row["stderr"], 2)
        row["vpip"] = round(row["vpip"], 1)
        row["pfr"] = round(row["pfr"], 1)
        row["af"] = round(row["af"], 2)
        row["saw_flop"] = round(row.get("saw_flop", 0.0), 1)
        row["showdown"] = round(row.get("showdown", 0.0), 1)
        row["ci95"] = round(1.96 * row["stderr"], 2)
    return {"bots": rows, "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S")}


def bot_detail(store: Store, bot_id: str) -> dict | None:
    b = store.db.execute("SELECT * FROM bots WHERE bot_id=?", (bot_id,)).fetchone()
    if not b:
        return None
    history = [
        {"match_id": r["match_id"], "elo_before": r["elo_before"], "elo_after": r["elo_after"]}
        for r in store.db.execute(
            "SELECT match_id, elo_before, elo_after FROM rating_history WHERE bot_id=? ORDER BY match_id",
            (bot_id,))
    ]
    recent = [
        _jsonable(r) for r in store.db.execute(
            """SELECT mp.match_id, mp.seat, mp.net_chips, mp.bb_per_100, mp.rank, mp.elo_before,
                      mp.elo_after, mp.errors, m.played_at, m.n_hands, m.round_no
               FROM match_players mp JOIN matches m USING(match_id)
               WHERE mp.bot_id=? ORDER BY mp.match_id DESC LIMIT 20""",
            (bot_id,))
    ]
    return {
        "bot": bot_id,
        "elo": b["elo"],
        "matches": b["matches"],
        "hands": b["hands"],
        "description": b["description"],
        "first_seen": b["first_seen"],
        "last_played": b["last_played"],
        "history": history,
        "recent_matches": recent,
    }


def list_matches(store: Store, limit: int = 40) -> list[dict]:
    rows = []
    for m in store.db.execute(
        "SELECT * FROM matches ORDER BY match_id DESC LIMIT ?", (limit,)):
        seats = [
            {"seat": r["seat"], "bot": r["bot_id"], "net": r["net_chips"], "rank": r["rank"],
             "elo_before": r["elo_before"], "elo_after": r["elo_after"]}
            for r in store.db.execute(
                "SELECT seat, bot_id, net_chips, rank, elo_before, elo_after "
                "FROM match_players WHERE match_id=? ORDER BY seat", (m["match_id"],))
        ]
        item = _jsonable(m)
        item["seats"] = seats
        rows.append(item)
    return rows


def list_hands(store: Store, *, limit=30, bot=None, match_id=None) -> list[dict]:
    sql = (
        "SELECT h.hand_id, h.match_id, h.hand_no, h.button, h.board, h.pot_total, h.showdown, "
        "m.big_blind FROM hands h JOIN matches m USING(match_id) WHERE 1=1"
    )
    args: list = []
    if match_id:
        sql += " AND h.match_id=?"
        args.append(match_id)
    if bot:
        sql += " AND h.hand_id IN (SELECT hand_id FROM hand_players WHERE bot_id=?)"
        args.append(bot)
    sql += " ORDER BY h.hand_id DESC LIMIT ?"
    args.append(limit)
    out = []
    for h in store.db.execute(sql, args):
        players = [
            {"seat": p["seat"], "bot": p["bot_id"], "position": p["position"], "net": p["net"]}
            for p in store.db.execute(
                "SELECT seat, bot_id, position, net FROM hand_players WHERE hand_id=? ORDER BY seat",
                (h["hand_id"],))
        ]
        out.append({
            "hand_id": h["hand_id"],
            "match_id": h["match_id"],
            "hand_no": h["hand_no"],
            "button": h["button"],
            "board": h["board"],
            "pot": h["pot_total"],
            "showdown": bool(h["showdown"]),
            "players": players,
        })
    return out


def hand_payload(store: Store, hand_id: int) -> dict | None:
    try:
        raw = store.hand_history(hand_id)
    except KeyError:
        return None
    h = raw["hand"]
    board = (h["board"] or "").split()
    players = []
    for p in raw["players"]:
        cat = p["hand_category"]
        players.append({
            "seat": p["seat"],
            "bot": p["bot_id"],
            "position": p["position"],
            "hole": (p["hole"] or "").split(),
            "stack": p["start_stack"],
            "final_stack": p["final_stack"],
            "net": p["net"],
            "vpip": bool(p["vpip"]),
            "pfr": bool(p["pfr"]),
            "showdown": bool(p["showdown"]),
            "folded_street": p["folded_street"],
            "category": CATEGORY_NAMES[cat] if isinstance(cat, int) and 0 <= cat < len(CATEGORY_NAMES) else None,
        })
    actions = []
    for a in raw["actions"]:
        actions.append({
            "seq": a["seq"],
            "street": a["street"],
            "street_name": STREETS[a["street"]],
            "seat": a["seat"],
            "bot": a["bot_id"],
            "kind": a["kind"],
            "amount": a["amount"],
            "to_total": a["to_total"],
            "pot_before": a["pot_before"],
            "to_call": a["to_call"],
            "all_in": bool(a["all_in"]),
            "corrected": a["corrected"],
        })
    return {
        "hand_id": h["hand_id"],
        "match_id": h["match_id"],
        "hand_no": h["hand_no"],
        "button": h["button"],
        "board": board,
        "pot": h["pot_total"],
        "showdown": bool(h["showdown"]),
        "small_blind": h["small_blind"],
        "big_blind": h["big_blind"],
        "players": players,
        "actions": actions,
    }


CONNECT_GUIDE = {
    "summary": "A bot is a Python class. Drop the file in a folder and the arena loads it. No account, no network protocol.",
    "minimal_bot": '''from pokerarena.bots import Bot
from pokerarena.models import Action, Observation

class MyBot(Bot):
    name = "my_bot_v1"          # this string is your leaderboard identity
    description = "Checks, or calls cheap pots."

    def act(self, obs: Observation) -> Action:
        if obs.can_check:
            return Action.check()
        if obs.pot_odds < 0.25:
            return Action.call()
        return Action.fold()
''',
    "run": [
        "python -m pokerarena run --bot-dir ./my_bots --builtins --rounds 20",
        "python -m pokerarena leaderboard",
        "python -m pokerarena serve --db arena.db",
    ],
    "observation": [
        "obs.hole, obs.board — card ints, rank*4+suit. pokerarena.cards.card_str prints them.",
        "obs.pot, obs.to_call, obs.stack, obs.bet, obs.pot_odds, obs.can_check, obs.can_raise",
        "obs.min_raise_to / obs.max_raise_to — raise amounts are raise-to (total bet this street).",
        "obs.position — BTN, SB, BB, UTG, HJ, CO on a 6-max table.",
        "obs.players — every seat's stack, bet, folded, all-in, name.",
        "obs.history — every action in the hand so far, blinds included.",
    ],
    "hooks": [
        "on_match_start(info) — seat, opponent names, blinds, stack, hand count.",
        "on_hand_end(summary) — your net, the board, and showdown hole cards.",
        "self.rng is seeded by the arena. Use it instead of the global random module.",
        "A crash or an illegal action is corrected and counted. It does not kill the match.",
    ],
    "safety": "Bots run in-process. Only load code you trust. Give each version a new name so Elo stays attached to one strategy.",
}


# ---------------------------------------------------------------- live broadcast
# One shared clock. A visitor never picks a seed, a cursor, or who sits.
# The same UTC second shows the same action to everyone, and the shoe rolls on.
BROADCAST_EPOCH = 1794528000  # 2026-11-13 00:00:00 UTC
BROADCAST_STEP_S = 0.22
# Every shoe occupies the same number of steps, so the clock is a division,
# not a walk back to the epoch. A short shoe holds its last action until the slot ends.
BROADCAST_SLOT = 400
# Shown only when the database has no bots yet. A real field replaces this.
BROADCAST_FALLBACK = [
    "tag", "lag", "nit", "equity", "calling_station", "maniac",
    "equity_lag", "rock", "random",
]
BROADCAST_HANDS = 8
TABLE_SIZE = 6


def seat_tables(names: list[str], size: int = TABLE_SIZE) -> list[list[str]]:
    """Fill as many ``size``-seat tables as the field needs.

    Every bot sits once. A short last table is topped up from earlier tables
    so a spectator still sees a full game. Ten bots is two tables, not one.
    """
    names = list(dict.fromkeys(names))
    if len(names) < 2:
        names = list(BROADCAST_FALLBACK)
    if len(names) < size:
        # Not enough for one full table. Sit them heads-up and up.
        return [names]
    tables = [names[i:i + size] for i in range(0, len(names), size)]
    last = tables[-1]
    if len(last) < size:
        used = {n for n in last}
        extras = [n for n in names if n not in used]
        last.extend(extras[: size - len(last)])
    return tables


def broadcast_lineup(store=None) -> list[list[str]]:
    """Tables for every bot the arena knows, plus the built-ins."""
    names: list[str] = []
    if store is not None:
        try:
            names = [r["bot_id"] for r in store.db.execute(
                "SELECT bot_id FROM bots ORDER BY bot_id")]
        except Exception:
            names = []
    for name in sorted(BUILTIN):
        if name not in names:
            names.append(name)
    return seat_tables(names)


def broadcast_frame(now: float | None = None, table: int = 0, store=None) -> dict:
    """The action the arena is on at ``now``, for one seated table.

    A shoe is ``BROADCAST_HANDS`` hands from a seed derived from the shoe
    number. When it ends, the next shoe starts. The lineup comes from who is
    registered, so another bot opens another table. No request can change the
    seed or the cursor.
    """
    tables = broadcast_lineup(store)
    table = int(table) % len(tables)
    names = tables[table]
    now = time.time() if now is None else float(now)
    elapsed = max(0.0, now - BROADCAST_EPOCH)
    step = int(elapsed / BROADCAST_STEP_S)
    shoe, cursor = divmod(step, BROADCAST_SLOT)
    steps = _shoe_steps(names, shoe)
    total = len(steps)
    holding = cursor >= total - 1
    idx = min(cursor, total - 2)
    frame = {
        "seed": _shoe_seed(names, shoe) % 1_000_000_007,
        "names": names,
        "hands": BROADCAST_HANDS,
        "cursor": idx,
        "total": total,
        "done": False,
        "frame": steps[idx],
    }
    if holding:
        frame["holding"] = True
    frame["broadcast"] = True
    frame["table"] = table
    frame["tables"] = len(tables)
    frame["shoe"] = shoe
    frame["step_s"] = BROADCAST_STEP_S
    frame["server_time"] = now
    return frame


def _shoe_seed(names: list[str], shoe: int) -> int:
    # Stable across processes. Python's hash() is salted per start.
    lineup = ",".join(names)
    folded = 0
    for ch in lineup:
        folded = (folded * 131 + ord(ch)) & 0x7FFFFFFF
    return folded + shoe * 97 + 11


# One replay per (table, shoe). A warm worker answers the next action with a
# lookup instead of playing the shoe again. Vercel reuses the process between
# requests; a cold start still pays for one shoe, then holds it.
_SHOE_CACHE: dict[tuple, list] = {}
_SHOE_LOCK = threading.Lock()


def _shoe_steps(names: list[str], shoe: int) -> list:
    key = (tuple(names), shoe)
    hit = _SHOE_CACHE.get(key)
    if hit is not None:
        return hit
    with _SHOE_LOCK:
        hit = _SHOE_CACHE.get(key)
        if hit is not None:
            return hit
        seed = _shoe_seed(names, shoe) % 1_000_000_007
        specs = builtin_specs(names)
        game = Table([s.build() for s in specs], names, seed=seed)
        steps: list[dict] = []
        for hand_no in range(BROADCAST_HANDS):
            steps.extend(_stream_hand(game, hand_no))
        steps.append({"type": "session_end"})
        if len(_SHOE_CACHE) > 8:
            _SHOE_CACHE.clear()
        _SHOE_CACHE[key] = steps
        return steps


def live_frame(names: list[str] | None, seed: int, hands: int, cursor: int) -> dict:
    """Play ``hands`` deterministically and return the snapshot at ``cursor``.

    Stateless on purpose: Vercel functions do not keep a table between requests,
    and the engine is deterministic for a given seed, so replaying is exact.
    """
    names = list(names or broadcast_lineup()[0])
    unknown = [n for n in names if n not in BUILTIN]
    if unknown:
        raise ValueError(f"unknown bot(s): {unknown}. Built-ins: {sorted(BUILTIN)}")
    if not (2 <= len(names) <= 9):
        raise ValueError("a live table needs 2 to 9 bots")
    if len(set(names)) != len(names):
        raise ValueError("bot names must be unique")
    hands = max(1, min(int(hands), 12))
    cursor = max(0, int(cursor))
    specs = builtin_specs(names)
    table = Table([s.build() for s in specs], names, seed=int(seed) % 1_000_000_007)
    steps: list[dict] = []
    for hand_no in range(hands):
        steps.extend(_stream_hand(table, hand_no))
        if len(steps) > cursor + 1:
            break
    steps.append({"type": "session_end"})
    idx = min(cursor, len(steps) - 1)
    return {
        "seed": int(seed) % 1_000_000_007,
        "names": names,
        "hands": hands,
        "cursor": idx,
        "total": len(steps),
        "done": steps[idx].get("type") == "session_end",
        "frame": steps[idx],
    }


def _stream_hand(table: Table, hand_no: int):
    """Yield table snapshots by driving the same rules as Table.play_hand, one action at a time.

    The engine method is left untouched. This generator mirrors its betting loop and
    then asks the real bots to act, so what you see is what the arena would store.
    Hole cards are always included; the website decides whether to show them.
    """
    from .engine import _coerce

    n = table.n
    bb, sb, rng = table.bb, table.sb, table.rng
    button = hand_no % n
    deck = list(range(52))
    rng.shuffle(deck)
    hole = [(deck[2 * i], deck[2 * i + 1]) for i in range(n)]
    full_board = deck[2 * n: 2 * n + 5]
    board: list[int] = []
    stack = [table.stack0] * n
    bet = [0] * n
    contrib = [0] * n
    pot = 0
    folded = [False] * n
    allin = [False] * n
    pos_idx = [(s - button) % n for s in range(n)]
    pos_name = [table.pos_names[p] for p in pos_idx]

    def snap(phase, *, actor=None, last=None, pot_now=None, reveal=False):
        return {
            "type": "table",
            "phase": phase,
            "hand_no": hand_no,
            "button": button,
            "board": [card_str(c) for c in board],
            "pot": pot if pot_now is None else pot_now,
            "actor": actor,
            "last": last,
            "showdown": reveal and len([s for s in range(n) if not folded[s]]) > 1,
            "seats": [
                {
                    "seat": s,
                    "bot": table.names[s],
                    "position": pos_name[s],
                    "stack": stack[s],
                    "bet": bet[s],
                    "folded": folded[s],
                    "all_in": allin[s],
                    "hole": [card_str(c) for c in hole[s]],
                    "is_button": s == button,
                }
                for s in range(n)
            ],
        }

    def post(seat, amount, kind):
        nonlocal pot
        pot_before = pot
        paid = min(amount, stack[seat])
        stack[seat] -= paid
        bet[seat] += paid
        contrib[seat] += paid
        pot += paid
        if stack[seat] == 0:
            allin[seat] = True
        return {"seat": seat, "bot": table.names[seat], "kind": kind, "amount": paid, "pot_before": pot_before}

    if n == 2:
        sb_seat, bb_seat = button, (button + 1) % 2
    else:
        sb_seat, bb_seat = (button + 1) % n, (button + 2) % n

    yield snap("deal", pot_now=0)
    last = post(sb_seat, sb, "sb")
    yield snap("blind", last=last)
    last = post(bb_seat, bb, "bb")
    yield snap("blind", last=last)

    def betting(street: int):
        nonlocal pot
        current_bet = max(bet)
        last_raise = bb
        acted: set[int] = set()
        cursor = ((bb_seat + 1) % n if n > 2 else button) if street == 0 else (button + 1) % n
        while True:
            if sum(1 for s in range(n) if not folded[s]) == 1:
                return
            pick = None
            for i in range(n):
                s = (cursor + i) % n
                if folded[s] or allin[s]:
                    continue
                if s not in acted or bet[s] < current_bet:
                    pick = s
                    break
            if pick is None:
                return
            others = any(not folded[o] and not allin[o] for o in range(n) if o != pick)
            to_call = current_bet - bet[pick]
            if not others and to_call == 0:
                return
            max_to = bet[pick] + stack[pick]
            min_to = min(current_bet + last_raise, max_to)
            can_raise = pick not in acted and stack[pick] > to_call and others
            yield snap(STREETS[street], actor=pick)

            from .models import Observation, PlayerView
            views = tuple(
                PlayerView(s, table.names[s], stack[s], bet[s], folded[s], allin[s], pos_name[s])
                for s in range(n))
            obs = Observation(
                hand_no=hand_no, seat=pick, n_players=n, button=button, position=pos_name[pick],
                pos_idx=pos_idx[pick], street=street, hole=hole[pick], board=tuple(board),
                pot=pot, to_call=to_call, stack=stack[pick], bet=bet[pick],
                can_raise=can_raise, min_raise_to=min_to, max_raise_to=max_to,
                small_blind=sb, big_blind=bb, players=views, history=())
            corrected = 0
            try:
                raw = table.bots[pick].act(obs)
            except Exception:
                raw = None
                corrected = 2
            parsed = _coerce(raw)
            if parsed is None:
                corrected = corrected or 1
                parsed = ("check" if to_call == 0 else "fold", 0)
            kind, amount = parsed
            if kind == "raise" and not can_raise:
                kind, corrected = "call", corrected or 1
            if kind == "call" and to_call == 0:
                kind = "check"
            elif kind == "check" and to_call > 0:
                kind, corrected = "fold", corrected or 1
            elif kind not in ("fold", "check", "call", "raise"):
                kind, corrected = ("check" if to_call == 0 else "fold"), corrected or 1

            if kind == "raise":
                clamped = max(min_to, min(max_to, amount))
                chips = clamped - bet[pick]
                label = "bet" if current_bet == 0 else "raise"
                if clamped - current_bet >= last_raise:
                    last_raise = clamped - current_bet
                    acted = {pick}
                else:
                    acted.add(pick)
                current_bet = clamped
            elif kind == "call":
                chips = min(to_call, stack[pick])
                label = "call"
                acted.add(pick)
            else:
                chips = 0
                label = kind
                acted.add(pick)
            stack[pick] -= chips
            bet[pick] += chips
            contrib[pick] += chips
            pot += chips
            if stack[pick] == 0 and chips > 0:
                allin[pick] = True
            if label == "fold":
                folded[pick] = True
            last_action = {
                "seat": pick, "bot": table.names[pick], "kind": label,
                "amount": chips, "to_total": bet[pick], "corrected": corrected,
            }
            yield snap(STREETS[street], last=last_action)
            cursor = (pick + 1) % n

    for street in range(4):
        if street == 1:
            board.extend(full_board[0:3])
        elif street == 2:
            board.append(full_board[3])
        elif street == 3:
            board.append(full_board[4])
        if street > 0:
            if sum(1 for s in range(n) if not folded[s]) == 1:
                break
            bet[:] = [0] * n
            yield snap("board")
        yield from betting(street)
        if sum(1 for s in range(n) if not folded[s]) == 1:
            break

    live = [s for s in range(n) if not folded[s]]
    showdown = len(live) > 1
    from .evaluator import evaluate
    scores = {s: evaluate(list(hole[s]) + board) for s in live} if showdown else {}
    winnings = [0] * n
    prev = 0
    for level in sorted({c for c in contrib if c > 0}):
        amount = sum(min(c, level) - min(c, prev) for c in contrib)
        prev = level
        elig = [s for s in live if contrib[s] >= level] or [max(live, key=lambda s: contrib[s])]
        if len(elig) == 1:
            winnings[elig[0]] += amount
            continue
        best = max(scores[s] for s in elig)
        winners = sorted((s for s in elig if scores[s] == best), key=lambda s: (s - button - 1) % n)
        share, rem = divmod(amount, len(winners))
        for i, w in enumerate(winners):
            winnings[w] += share + (1 if i < rem else 0)
    final = [stack[s] + winnings[s] for s in range(n)]
    nets = [final[s] - table.stack0 for s in range(n)]
    result_seats = []
    for s in range(n):
        cat = category(scores[s]) if s in scores else -1
        result_seats.append({
            "seat": s,
            "bot": table.names[s],
            "position": pos_name[s],
            "stack": final[s],
            "bet": 0,
            "folded": folded[s],
            "all_in": allin[s],
            "hole": [card_str(c) for c in hole[s]],
            "is_button": s == button,
            "net": nets[s],
            "category": CATEGORY_NAMES[cat] if 0 <= cat < len(CATEGORY_NAMES) else None,
        })
    yield {
        "type": "table",
        "phase": "result",
        "hand_no": hand_no,
        "button": button,
        "board": [card_str(c) for c in board],
        "pot": pot,
        "actor": None,
        "last": {"kind": "result", "showdown": showdown},
        "showdown": showdown,
        "seats": result_seats,
    }


def make_handler(store: Store):
    db_lock = threading.Lock()
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            return

        def _send(self, code: int, payload, *, cache=0):
            body = json.dumps(payload).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Cache-Control", f"public, max-age={cache}" if cache else "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _read_json(self) -> dict:
            n = int(self.headers.get("Content-Length") or 0)
            if n > MAX_BODY:
                raise ValueError("body too large")
            raw = self.rfile.read(n) if n else b"{}"
            data = json.loads(raw.decode() or "{}")
            if not isinstance(data, dict):
                raise ValueError("JSON body must be an object")
            return data

        def do_OPTIONS(self):
            self._send(204, {})

        def do_GET(self):
            # The broadcast does not touch the database, so it must not wait
            # behind a leaderboard query (and a leaderboard query must not wait
            # behind a broadcast).
            live = urlparse(self.path).path.rstrip("/") == "/api/live"
            try:
                if live:
                    self._route("GET")
                else:
                    with db_lock:
                        self._route("GET")
            except Exception as exc:
                self._send(500, {"error": str(exc), "trace": traceback.format_exc(limit=2)})

        def do_POST(self):
            try:
                with db_lock:
                    self._route("POST")
            except ValueError as exc:
                self._send(400, {"error": str(exc)})
            except Exception as exc:
                self._send(500, {"error": str(exc)})

        def _route(self, method: str):
            parsed = urlparse(self.path)
            path = parsed.path.rstrip("/") or "/"
            qs = parse_qs(parsed.query)
            parts = [p for p in path.split("/") if p]

            if method == "GET" and path in ("/", "/api", "/api/health"):
                self._send(200, {"ok": True, "service": "pokerarena"})
                return
            if method == "GET" and path == "/api/health":
                self._send(200, {"ok": True})
                return
            if method == "GET" and path == "/api/leaderboard":
                min_hands = int(qs.get("min_hands", ["0"])[0])
                self._send(200, leaderboard_payload(store, min_hands), cache=5)
                return
            if method == "GET" and path == "/api/bots":
                rows = []
                for r in store.db.execute("SELECT bot_id, description, elo, matches, hands FROM bots ORDER BY elo DESC"):
                    rows.append({"bot": r["bot_id"], "description": r["description"], "elo": r["elo"],
                                 "matches": r["matches"], "hands": r["hands"]})
                known = {r["bot"] for r in rows}
                for name, cls in BUILTIN.items():
                    if name not in known:
                        rows.append({"bot": name, "description": cls.description, "elo": None,
                                     "matches": 0, "hands": 0, "builtin": True})
                self._send(200, {"bots": rows, "builtins": sorted(BUILTIN)})
                return
            if method == "GET" and len(parts) == 3 and parts[:2] == ["api", "bots"]:
                detail = bot_detail(store, parts[2])
                self._send(200 if detail else 404, detail or {"error": "unknown bot"})
                return
            if method == "GET" and path == "/api/matches":
                limit = min(int(qs.get("limit", ["40"])[0]), 200)
                self._send(200, {"matches": list_matches(store, limit)})
                return
            if method == "GET" and path == "/api/hands":
                limit = min(int(qs.get("limit", ["30"])[0]), 100)
                match_id = int(qs["match_id"][0]) if "match_id" in qs else None
                bot = qs.get("bot", [None])[0]
                self._send(200, {"hands": list_hands(store, limit=limit, bot=bot, match_id=match_id)})
                return
            if method == "GET" and len(parts) == 3 and parts[:2] == ["api", "hands"]:
                payload = hand_payload(store, int(parts[2]))
                self._send(200 if payload else 404, payload or {"error": "unknown hand"})
                return
            if method == "GET" and path == "/api/connect":
                self._send(200, CONNECT_GUIDE)
                return
            if method == "GET" and path == "/api/live":
                table = int(qs.get("table", ["0"])[0])
                self._send(200, broadcast_frame(table=table, store=store))
                return
            self._send(404, {"error": "not found", "path": path})

    return Handler


def _with_static(handler_cls, static_dir: str):
    root = Path(static_dir).resolve()

    class StaticHandler(handler_cls):
        def _route(self, method: str):
            parsed = urlparse(self.path)
            path = parsed.path
            if method == "GET" and not path.startswith("/api"):
                rel = "index.html" if path in ("", "/") else path.lstrip("/")
                target = (root / rel).resolve()
                if root not in target.parents and target != root:
                    self._send(403, {"error": "forbidden"})
                    return
                if target.is_dir():
                    target = target / "index.html"
                if target.is_file():
                    data = target.read_bytes()
                    ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
                    self.send_response(200)
                    self.send_header("Content-Type", ctype)
                    self.send_header("Content-Length", str(len(data)))
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    self.wfile.write(data)
                    return
                # unknown page -> the app shell, so /rankings still loads
                shell = root / "index.html"
                if shell.is_file() and "." not in Path(rel).name:
                    data = shell.read_bytes()
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
            super()._route(method)

    return StaticHandler


def serve(db_path: str, host: str = "127.0.0.1", port: int = 8787, static_dir: str | None = None) -> None:
    store = Store(db_path)
    handler = make_handler(store)
    if static_dir:
        handler = _with_static(handler, static_dir)
    httpd = ThreadingHTTPServer((host, port), handler)
    print(f"pokerarena  http://{host}:{port}   db={db_path}")
    print("  site /    API /api/leaderboard  /api/hands/<id>  /api/live")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        store.close()
