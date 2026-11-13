"""Fast pure-Python hand evaluator for 5-7 cards (also works for partial boards).

``evaluate(cards)`` returns an int; a larger int is a better hand. The top bits hold the
category (0=high card ... 8=straight flush), the low 20 bits hold up to five 4-bit
tie-break ranks, most significant first.
"""

from __future__ import annotations

CATEGORY_NAMES = [
    "high card",
    "pair",
    "two pair",
    "three of a kind",
    "straight",
    "flush",
    "full house",
    "four of a kind",
    "straight flush",
]


def _pack(cat: int, ranks) -> int:
    score = cat << 20
    shift = 16
    for r in ranks[:5]:
        score |= r << shift
        shift -= 4
    return score


def _straight_high(mask: int) -> int:
    """Highest rank of a straight contained in a 13-bit rank mask, or -1."""
    m = (mask << 1) | ((mask >> 12) & 1)  # bit0 = ace-low
    for i in range(13, 3, -1):
        if (m >> (i - 4)) & 0b11111 == 0b11111:
            return i - 1
    return -1


def evaluate(cards) -> int:
    counts = [0] * 13
    by_suit = ([], [], [], [])
    mask = 0
    for c in cards:
        r = c >> 2
        counts[r] += 1
        by_suit[c & 3].append(r)
        mask |= 1 << r

    for ranks in by_suit:
        if len(ranks) >= 5:
            fmask = 0
            for r in ranks:
                fmask |= 1 << r
            sf = _straight_high(fmask)
            if sf >= 0:
                return _pack(8, [sf])
            ranks.sort(reverse=True)
            return _pack(5, ranks)

    quads, trips, pairs, singles = [], [], [], []
    for r in range(12, -1, -1):
        n = counts[r]
        if n == 4:
            quads.append(r)
        elif n == 3:
            trips.append(r)
        elif n == 2:
            pairs.append(r)
        elif n == 1:
            singles.append(r)

    if quads:
        q = quads[0]
        kick = max((r for r in range(13) if counts[r] and r != q), default=0)
        return _pack(7, [q, kick])
    if trips and (len(trips) > 1 or pairs):
        pair_rank = max(pairs[0] if pairs else -1, trips[1] if len(trips) > 1 else -1)
        return _pack(6, [trips[0], pair_rank])
    st = _straight_high(mask)
    if st >= 0:
        return _pack(4, [st])
    if trips:
        return _pack(3, [trips[0]] + singles[:2])
    if len(pairs) >= 2:
        rest = sorted(pairs[2:] + singles, reverse=True)
        return _pack(2, [pairs[0], pairs[1]] + rest[:1])
    if pairs:
        return _pack(1, [pairs[0]] + singles[:3])
    return _pack(0, singles)


def category(score: int) -> int:
    return score >> 20


def describe(score: int) -> str:
    return CATEGORY_NAMES[score >> 20]
