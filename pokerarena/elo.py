"""Multiplayer Elo.

A table of N bots is treated as N*(N-1)/2 head-to-head games: bot i "beats" bot j if it
finished the match with more chips. Each bot's rating moves by

    K_i / (N - 1) * sum_j (S_ij - E_ij)

so one table moves a rating by at most K_i, and with equal K the update is zero-sum.
Ratings from one round of tables are applied simultaneously (from a snapshot), so the
result does not depend on the order tables finish in.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class EloConfig:
    initial: float = 1500.0
    k: float = 16.0
    k_provisional: float = 32.0  # used while a bot has few matches
    provisional_matches: int = 30
    scale: float = 400.0
    # profits closer than this (in big blinds / 100 hands) count as a draw
    draw_margin_bb100: float = 0.0

    def k_for(self, matches_played: int) -> float:
        return self.k_provisional if matches_played < self.provisional_matches else self.k


def expected(rating_a: float, rating_b: float, scale: float = 400.0) -> float:
    return 1.0 / (1.0 + 10 ** ((rating_b - rating_a) / scale))


def table_deltas(ratings: dict, profit_bb100: dict, matches_played: dict, cfg: EloConfig) -> dict:
    """Rating change per bot for one table. All dicts are keyed by bot name."""
    bots = list(ratings)
    n = len(bots)
    deltas = {b: 0.0 for b in bots}
    if n < 2:
        return deltas
    for i in bots:
        total = 0.0
        for j in bots:
            if i == j:
                continue
            diff = profit_bb100[i] - profit_bb100[j]
            if abs(diff) <= cfg.draw_margin_bb100:
                s = 0.5
            else:
                s = 1.0 if diff > 0 else 0.0
            total += s - expected(ratings[i], ratings[j], cfg.scale)
        deltas[i] = cfg.k_for(matches_played[i]) * total / (n - 1)
    return deltas
