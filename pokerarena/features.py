"""Optional numeric encoding of a decision row (pure Python lists; feed into numpy/torch).

``encode_decision(row)`` -> list[float] of length ``len(FEATURE_NAMES)``
``action_class(row)``    -> int label in ``ACTION_CLASSES``
"""

from __future__ import annotations

from .cards import parse_cards

ACTION_CLASSES = ["fold", "check/call", "raise<=0.5pot", "raise<=1pot", "raise>1pot"]

FEATURE_NAMES = (
    [f"hole_{i}" for i in range(52)]
    + [f"board_{i}" for i in range(52)]
    + [f"street_{i}" for i in range(4)]
    + [f"pos_{i}" for i in range(9)]
    + ["pot_bb/100", "to_call_bb/100", "stack_bb/100", "pot_odds", "num_active/9", "n_players/9", "spr/20"]
)


def encode_decision(row: dict) -> list[float]:
    x = [0.0] * len(FEATURE_NAMES)
    for c in parse_cards(row["hole"]):
        x[c] = 1.0
    for c in parse_cards(row["board"]) if row["board"] else []:
        x[52 + c] = 1.0
    x[104 + row["street"]] = 1.0
    x[108 + row["pos_idx"]] = 1.0
    pot, call, stack = row["pot_bb"], row["to_call_bb"], row["stack_bb"]
    x[117:124] = [
        pot / 100, call / 100, stack / 100,
        call / (pot + call) if call else 0.0,
        row["num_active"] / 9, row["n_players"] / 9,
        min(stack / pot, 20) / 20 if pot else 1.0,
    ]
    return x


def action_class(row: dict) -> int:
    a = row["action"]
    if a == "fold":
        return 0
    if a in ("check", "call"):
        return 1
    f = row["raise_pot_frac"]
    return 2 if f <= 0.5 else 3 if f <= 1.0 else 4
