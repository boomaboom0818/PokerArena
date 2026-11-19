"""Matchmaking + parallel tournament runner.

A *round* seats every bot at exactly one 6-handed table (bots left over when the pool size
is not a multiple of the table size are re-used to fill the last table). All tables of a
round run at the same time in separate processes; afterwards results are written to the
database. The leaderboard ranks bots by total chips won.
"""

from __future__ import annotations

import json
import os
import random
from concurrent.futures import ProcessPoolExecutor
from dataclasses import asdict, dataclass
from typing import Callable, Optional

from .bots import BotSpec
from .engine import Table
from .models import MatchResult
from .storage import Store


@dataclass
class ArenaConfig:
    table_size: int = 6
    hands_per_match: int = 600  # rounded up to a multiple of table_size (equal button turns)
    small_blind: int = 50
    big_blind: int = 100
    starting_stack: int = 10_000  # 100 big blinds, reset before every hand
    workers: int = 0  # 0 = number of CPUs
    seed: int = 0

    def normalized_hands(self) -> int:
        n = self.table_size
        return -(-self.hands_per_match // n) * n


def _play_table(task: dict) -> MatchResult:
    """Worker entry point (must be a top-level function so it can be pickled)."""
    bots = [spec.build() for spec in task["specs"]]
    names = [spec.name for spec in task["specs"]]
    cfg = task["cfg"]
    table = Table(bots, names, small_blind=cfg["small_blind"], big_blind=cfg["big_blind"],
                  starting_stack=cfg["starting_stack"], seed=task["seed"])
    return table.run(task["n_hands"])


def make_tables(pool: list, size: int, rng: random.Random) -> list[list]:
    """Partition ``pool`` (list of BotSpec) into tables of ``size`` (every bot plays once)."""
    if len(pool) < size:
        raise ValueError(f"need at least {size} bots, got {len(pool)}")
    order = list(pool)
    rng.shuffle(order)
    tables = [order[i:i + size] for i in range(0, len(order), size)]
    last = tables[-1]
    if len(last) < size:  # top up the last table with bots from elsewhere
        extras = [s for s in pool if s not in last]
        rng.shuffle(extras)
        last.extend(extras[: size - len(last)])
    for t in tables:
        rng.shuffle(t)  # random seats
    return tables


class Arena:
    def __init__(self, store: Store, specs: list[BotSpec], cfg: ArenaConfig):
        names = [s.name for s in specs]
        if len(set(names)) != len(names):
            raise ValueError(f"bot names must be unique: {names}")
        if len(specs) < cfg.table_size:
            raise ValueError(f"need at least {cfg.table_size} bots, got {len(specs)}")
        self.store, self.specs, self.cfg = store, specs, cfg
        self.rng = random.Random(cfg.seed)
        for s in specs:
            cls = s._load_class()
            store.register_bot(s.name, json.dumps(asdict(s), default=str), getattr(cls, "description", ""))
        self.run_id = store.start_run(json.dumps(dict(arena=asdict(cfg), bots=[s.name for s in specs])))
        self.round_no = 0
        self._match_counter = 0

    def run(self, rounds: int, on_round: Optional[Callable[[int, list], None]] = None,
            executor: Optional[ProcessPoolExecutor] = None):
        workers = self.cfg.workers or os.cpu_count() or 1
        own = executor is None
        executor = executor or ProcessPoolExecutor(max_workers=workers)
        try:
            for _ in range(rounds):
                self.play_round(executor)
                if on_round:
                    on_round(self.round_no, self.store.leaderboard())
        finally:
            if own:
                executor.shutdown()

    def play_round(self, executor) -> None:
        cfg = self.cfg
        tables = make_tables(self.specs, cfg.table_size, self.rng)
        n_hands = cfg.normalized_hands()
        cfg_dict = dict(small_blind=cfg.small_blind, big_blind=cfg.big_blind,
                        starting_stack=cfg.starting_stack)
        tasks = []
        for t in tables:
            self._match_counter += 1
            seed = random.Random(f"{cfg.seed}/{self._match_counter}").getrandbits(62)
            tasks.append(dict(specs=t, seed=seed, n_hands=n_hands, cfg=cfg_dict))
        results = list(executor.map(_play_table, tasks))  # ordered -> deterministic DB writes

        self.round_no += 1
        for table_no, res in enumerate(results):
            self.store.save_match(self.run_id, self.round_no, table_no, res)
