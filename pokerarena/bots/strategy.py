"""Hand-strength helpers shared by the built-in bots (and handy for your own)."""

from __future__ import annotations

import random

from ..evaluator import evaluate
from ..models import Observation

_CHEN_POINTS = {12: 10, 11: 8, 10: 7, 9: 6, 8: 5, 7: 4.5, 6: 4, 5: 3.5, 4: 3, 3: 2.5, 2: 2, 1: 1.5, 0: 1}


def chen_score(hole) -> float:
    """Chen formula: ~20 for AA, ~1 for 72o. A quick preflop hand-strength heuristic."""
    r1, r2 = sorted((hole[0] >> 2, hole[1] >> 2), reverse=True)
    suited = (hole[0] & 3) == (hole[1] & 3)
    score = _CHEN_POINTS[r1]
    if r1 == r2:
        return max(5.0, score * 2) if r1 else 5.0
    if suited:
        score += 2
    gap = r1 - r2 - 1
    score -= {0: 0, 1: 1, 2: 2, 3: 4}.get(gap, 5)
    if gap <= 1 and r1 < 10:  # both cards below a queen: straight potential bonus
        score += 1
    return float(-(-score // 1))  # round up


def postflop_strength(hole, board) -> float:
    """Rough 0..1 made-hand + draw strength (not a true equity)."""
    cards = list(hole) + list(board)
    score = evaluate(cards)
    cat = score >> 20
    board_only = evaluate(list(board)) if len(board) >= 3 else -1
    if score == board_only:
        return 0.1  # the board plays; no hole card helps
    hole_ranks = {hole[0] >> 2, hole[1] >> 2}
    top_board = max(c >> 2 for c in board)
    if cat == 0:
        s = 0.12 + (0.04 if max(hole_ranks) > top_board else 0.0)
        suits = [c & 3 for c in cards]
        if len(board) < 5:
            if max(suits.count(x) for x in range(4)) >= 4:
                s += 0.2  # flush draw
            ranks = sorted({c >> 2 for c in cards})
            for i in range(len(ranks) - 3):
                if ranks[i + 3] - ranks[i] == 3:
                    s += 0.15  # open-ended-ish draw
                    break
        return min(s, 0.45)
    if cat == 1:
        pair_rank = (score >> 16) & 0xF
        if pair_rank not in hole_ranks:
            return 0.12
        if pair_rank >= top_board:
            return 0.55 + 0.1 * pair_rank / 12
        return 0.38
    return {2: 0.75, 3: 0.82, 4: 0.88, 5: 0.9}.get(cat, 0.97)


def equity_vs_random(hole, board, n_opponents: int, iterations: int, rng: random.Random) -> float:
    """Monte-Carlo win probability (ties count half) against random opponent hands."""
    known = set(hole) | set(board)
    pool = [c for c in range(52) if c not in known]
    need_board = 5 - len(board)
    draw = need_board + 2 * n_opponents
    wins = 0.0
    for _ in range(iterations):
        sample = rng.sample(pool, draw)
        full = list(board) + sample[:need_board]
        mine = evaluate(list(hole) + full)
        best_opp = -1
        for o in range(n_opponents):
            k = need_board + 2 * o
            sc = evaluate(sample[k:k + 2] + full)
            if sc > best_opp:
                best_opp = sc
        if mine > best_opp:
            wins += 1
        elif mine == best_opp:
            wins += 0.5
    return wins / iterations


def clamp_raise(obs: Observation, target: float) -> int:
    return int(max(obs.min_raise_to, min(obs.max_raise_to, round(target))))
