"""Matchmaking + parallel tournament runner.

A *round* seats every bot at exactly one 6-handed table (bots left over when the pool size
is not a multiple of the table size are re-used to fill the last table). All tables of a
round run at the same time in separate processes; afterwards results are written to the
database and Elo is updated from a snapshot of the pre-round ratings.
"""

from __future__ import annotations

import json
import os
import random
from concurrent.futures import ProcessPoolExecutor
from dataclasses import asdict, dataclass
from typing import Callable, Optional

from .bots import BotSpec
from .elo import EloConfig, table_deltas
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
    matchmaking: str = "random"  # "random" or "elo" (similar ratings sit together)
    elo_noise: float = 150.0  # rating jitter used by "elo" matchmaking
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


def make_tables(pool: list, ratings: dict, size: int, mode: str, rng: random.Random,
                noise: float = 150.0) -> list[list]:
    """Partition ``pool`` (list of BotSpec) into tables of ``size`` (every bot plays once)."""
    if len(pool) < size:
        raise ValueError(f"need at least {size} bots, got {len(pool)}")
    order = list(pool)
    rng.shuffle(order)
    if mode == "elo":
        order.sort(key=lambda s: -(ratings.get(s.name, 1500.0) + rng.gauss(0, noise)))
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
    def __init__(self, store: Store, specs: list[BotSpec], cfg: ArenaConfig, elo: EloConfig = EloConfig()):
        names = [s.name for s in specs]
        if len(set(names)) != len(names):
            raise ValueError(f"bot names must be unique: {names}")
        if len(specs) < cfg.table_size:
            raise ValueError(f"need at least {cfg.table_size} bots, got {len(specs)}")
        self.store, self.specs, self.cfg, self.elo = store, specs, cfg, elo
        self.rng = random.Random(cfg.seed)
        for s in specs:
            cls = s._load_class()
            store.register_bot(s.name, json.dumps(asdict(s), default=str), getattr(cls, "description", ""),
                               elo.initial)
        self.run_id = store.start_run(json.dumps(dict(arena=asdict(cfg), elo=asdict(elo),
                                                      bots=[s.name for s in specs])))
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
        ratings = self.store.ratings()
        counts = self.store.match_counts()
        tables = make_tables(self.specs, ratings, cfg.table_size, cfg.matchmaking, self.rng, cfg.elo_noise)
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
        # all tables are rated against the same pre-round snapshot
        deltas_by_table = []
        for res in results:
            nets = res.net_by_seat
            profit = {n: nets[s] / cfg.big_blind / n_hands * 100 for s, n in enumerate(res.names)}
            deltas_by_table.append(table_deltas(
                {n: ratings[n] for n in res.names}, profit, {n: counts[n] for n in res.names}, self.elo))
        running = dict(ratings)
        for table_no, (res, deltas) in enumerate(zip(results, deltas_by_table)):
            before = {n: running[n] for n in res.names}
            after = {n: running[n] + deltas[n] for n in res.names}
            self.store.save_match(self.run_id, self.round_no, table_no, res, before, after)
            running.update(after)
