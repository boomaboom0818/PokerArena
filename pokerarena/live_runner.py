"""Tables that keep playing, instead of a clock that replays one shoe.

A background thread deals a fresh hand, asks the bots to act, and parks the
snapshot so a spectator can see it. Every six hands the match is saved and
rated, so the rankings move with the games on screen.
"""

from __future__ import annotations

import json
import random
import threading
import time

from .bots import BUILTIN, BotSpec, builtin_specs
from .elo import EloConfig, table_deltas
from .engine import Table
from .http_api import _stream_hand, playable_bot_names, seat_tables
from .models import MatchInfo
from .storage import Store

HANDS_PER_MATCH = 6
STEP_S = 0.7


class LiveRunner:
    def __init__(self, store: Store):
        self.store = store
        self.lock = threading.Lock()
        self.tables: list[dict] = []
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._run_id: int | None = None
        self._round = 0

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="pokerarena-live", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def snapshot(self, table: int = 0) -> dict:
        with self.lock:
            if not self.tables:
                return {
                    "live": True, "playing": False, "tables": 0, "table": 0,
                    "names": [], "frame": {"type": "session_end", "phase": "deal", "seats": [], "board": [], "pot": 0},
                    "step_s": STEP_S,
                }
            table = int(table) % len(self.tables)
            row = self.tables[table]
            return {
                "live": True,
                "playing": True,
                "broadcast": False,
                "table": table,
                "tables": len(self.tables),
                "names": list(row["names"]),
                "hand_no": row["hand_no"],
                "hands_saved": row["saved"],
                "step_s": STEP_S,
                "server_time": time.time(),
                "frame": row["frame"],
            }

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self._play_one_step()
            except Exception:
                time.sleep(1.0)
            self._stop.wait(STEP_S)

    def _play_one_step(self) -> None:
        with self.lock:
            ready = bool(self.tables) and all(t["gen"] is not None for t in self.tables)
        if not ready or self._field_changed():
            self._seat()
        with self.lock:
            for row in self.tables:
                frame = next(row["gen"], None)
                if frame is None:
                    row["pending"].append(row["table"].play_hand(row["hand_no"]))
                    row["hand_no"] += 1
                    if row["hand_no"] % HANDS_PER_MATCH == 0:
                        self._rate(row)
                        self._open_match(row)
                    row["gen"] = _stream_hand(row["table"], row["hand_no"])
                    frame = next(row["gen"])
                row["frame"] = frame

    def _field_changed(self) -> bool:
        wanted = [tuple(t) for t in self._lineups()]
        with self.lock:
            current = [tuple(t["names"]) for t in self.tables]
        return wanted != current

    def _lineups(self) -> list[list[str]]:
        names = playable_bot_names(self.store)
        return seat_tables(names)

    def _seat(self) -> None:
        lineups = self._lineups()
        tables = []
        for names in lineups:
            specs = self._specs(names)
            seed = random.SystemRandom().randrange(1_000_000_007)
            game = Table([s.build() for s in specs], names, seed=seed)
            row = {
                "names": names,
                "specs": specs,
                "table": game,
                "hand_no": 0,
                "gen": _stream_hand(game, 0),
                "frame": {"type": "table", "phase": "deal", "seats": [], "board": [], "pot": 0},
                "pending": [],
                "saved": 0,
                "started": time.time(),
            }
            tables.append(row)
        with self.lock:
            self.tables = tables
        if self._run_id is None:
            self._run_id = self.store.start_run(json.dumps({"live": True}))
        for row in tables:
            self._open_match(row)

    def _specs(self, names: list[str]) -> list[BotSpec]:
        specs = []
        for name in names:
            if name in BUILTIN:
                specs.append(builtin_specs([name])[0])
                continue
            row = self.store.db.execute(
                "SELECT spec_json FROM bots WHERE bot_id=?", (name,)).fetchone()
            spec = json.loads(row["spec_json"])
            specs.append(BotSpec(
                spec["name"], spec["kind"], spec["target"], spec.get("class_name") or "",
                tuple(tuple(pair) for pair in spec.get("kwargs") or []),
            ))
        return specs

    def _open_match(self, row: dict) -> None:
        for seat, bot in enumerate(row["table"].bots):
            try:
                bot.on_match_start(MatchInfo(
                    seat, tuple(row["names"]), len(row["names"]),
                    row["table"].sb, row["table"].bb, row["table"].stack0, HANDS_PER_MATCH,
                ))
            except Exception:
                pass
        row["pending"] = []
        row["started"] = time.time()

    def _rate(self, row: dict) -> None:
        from .models import MatchResult

        hands = row["pending"]
        if not hands:
            return
        result = MatchResult(
            seed=row["table"].seed, names=list(row["names"]),
            config=dict(n_players=len(row["names"]), small_blind=row["table"].sb,
                        big_blind=row["table"].bb, starting_stack=row["table"].stack0,
                        n_hands=len(hands)),
            hands=hands, error_counts=list(row["table"].error_counts),
            errors=list(row["table"].errors),
            duration_s=time.time() - row["started"],
        )
        ratings = self.store.ratings()
        counts = self.store.match_counts()
        for name in row["names"]:
            ratings.setdefault(name, 1500.0)
            counts.setdefault(name, 0)
        bb = row["table"].bb
        n_hands = max(len(hands), 1)
        profit = {n: result.net_by_seat[i] / bb / n_hands * 100 for i, n in enumerate(row["names"])}
        deltas = table_deltas(
            {n: ratings[n] for n in row["names"]}, profit,
            {n: counts[n] for n in row["names"]}, EloConfig(),
        )
        before = {n: ratings[n] for n in row["names"]}
        after = {n: ratings[n] + deltas[n] for n in row["names"]}
        self._round += 1
        self.store.save_match(self._run_id, self._round, 0, result, before, after)
        row["saved"] += len(hands)
        row["pending"] = []
        row["table"].errors.clear()
        row["table"].error_counts = [0] * len(row["names"])
