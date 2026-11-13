"""Training-data access: turn the database into per-decision rows and per-hand histories.

Typical use::

    from pokerarena.dataset import iter_decisions
    for row in iter_decisions("arena.db", top=3):       # imitate the 3 best bots
        x = encode_decision(row); y = action_class(row)

Every decision row contains the state the acting bot saw, the action it took, and the
eventual outcome of that hand (``hand_net_bb``) so you can do behaviour cloning,
reward-weighted imitation, or offline RL.
"""

from __future__ import annotations

import json
from typing import Iterator, Optional

from .models import STREETS
from .storage import Store

_STREET_LETTER = "pftr"


def _open(db) -> Store:
    return db if isinstance(db, Store) else Store(db)


def _bot_filter(store: Store, bots, top, min_elo, min_bb100=None) -> Optional[list[str]]:
    if bots is None and top is None and min_elo is None and min_bb100 is None:
        return None
    rows = store.leaderboard()
    if bots:
        rows = [r for r in rows if r["bot"] in set(bots)]
    if min_elo is not None:
        rows = [r for r in rows if r["elo"] >= min_elo]
    if min_bb100 is not None:
        rows = [r for r in rows if r["bb100"] >= min_bb100]
    if top is not None:
        rows = sorted(rows, key=lambda r: -r["elo"])[:top]
    return [r["bot"] for r in rows]


def _fmt_bb(chips: int, bb: int) -> str:
    v = chips / bb
    return str(int(v)) if v == int(v) else f"{v:.1f}"


def iter_decisions(db, *, bots=None, top=None, min_elo=None, min_bb100=None, run_id=None,
                   winners_only=False, history=True, limit=None) -> Iterator[dict]:
    """Yield one dict per decision (fold/check/call/bet/raise) from the ``decisions`` view,
    plus derived columns: pot_bb, to_call_bb, stack_bb, raise_to_bb, raise_pot_frac, history."""
    store = _open(db)
    selected = _bot_filter(store, bots, top, min_elo, min_bb100)
    where, params = [], []
    if selected is not None:
        if not selected:
            return
        where.append(f"bot_id IN ({','.join('?' * len(selected))})")
        params += selected
    if run_id is not None:
        where.append("run_id = ?")
        params.append(run_id)
    if winners_only:
        where.append("hand_net > 0")
    sql = "SELECT * FROM decisions" + (" WHERE " + " AND ".join(where) if where else "") + \
          " ORDER BY hand_id, seq"
    if limit:
        sql += f" LIMIT {int(limit)}"
    cur_hand, hist_events, pos_of = None, [], {}
    for r in store.db.execute(sql, params):
        row = dict(r)
        bb = row["big_blind"]
        if history and row["hand_id"] != cur_hand:
            cur_hand = row["hand_id"]
            hist_events = [dict(e) for e in store.db.execute(
                "SELECT seq, seat, street, kind, to_total FROM actions WHERE hand_id=? ORDER BY seq",
                (cur_hand,))]
            pos_of = {p["seat"]: p["position"] for p in store.db.execute(
                "SELECT seat, position FROM hand_players WHERE hand_id=?", (cur_hand,))}
        row["pot_bb"] = row["pot_before"] / bb
        row["to_call_bb"] = row["to_call"] / bb
        row["stack_bb"] = row["stack_before"] / bb
        row["raise_to_bb"] = row["to_total"] / bb if row["action"] in ("bet", "raise") else 0.0
        row["raise_pot_frac"] = (
            (row["amount"] - row["to_call"]) / (row["pot_before"] + row["to_call"])
            if row["action"] in ("bet", "raise") else 0.0)
        if history:
            row["history"] = " ".join(
                f"{_STREET_LETTER[e['street']]}:{pos_of[e['seat']]}:{e['kind']}:{_fmt_bb(e['to_total'], bb)}"
                for e in hist_events if e["seq"] < row["seq"])
        yield row


def iter_hands(db, *, bots=None, top=None, min_elo=None, run_id=None) -> Iterator[dict]:
    """Yield complete hand histories (all hole cards, board, every action) as dicts."""
    store = _open(db)
    selected = _bot_filter(store, bots, top, min_elo)
    where, params = [], []
    if selected is not None:
        if not selected:
            return
        marks = ",".join("?" * len(selected))
        where.append(f"h.hand_id IN (SELECT hand_id FROM hand_players WHERE bot_id IN ({marks}))")
        params += selected
    if run_id is not None:
        where.append("m.run_id = ?")
        params.append(run_id)
    sql = ("SELECT h.hand_id FROM hands h JOIN matches m USING(match_id)"
           + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY h.hand_id")
    for r in store.db.execute(sql, params).fetchall():
        data = store.hand_history(r["hand_id"])
        h = data["hand"]
        yield dict(
            hand_id=h["hand_id"], match_id=h["match_id"], hand_no=h["hand_no"], button=h["button"],
            board=h["board"], big_blind=h["big_blind"], small_blind=h["small_blind"],
            pot_total=h["pot_total"], showdown=h["showdown"],
            players=data["players"], actions=data["actions"])


def export_jsonl(rows, path) -> int:
    n = 0
    with open(path, "w") as f:
        for row in rows:
            f.write(json.dumps(row, separators=(",", ":")) + "\n")
            n += 1
    return n


def export_csv(rows, path) -> int:
    import csv
    n = 0
    with open(path, "w", newline="") as f:
        writer = None
        for row in rows:
            if writer is None:
                writer = csv.DictWriter(f, fieldnames=list(row))
                writer.writeheader()
            writer.writerow(row)
            n += 1
    return n
