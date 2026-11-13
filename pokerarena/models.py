"""Plain data types shared by the engine, bots and storage."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

STREETS = ["preflop", "flop", "turn", "river"]

_EARLY_NAMES = {
    1: ["CO"],
    2: ["HJ", "CO"],
    3: ["UTG", "HJ", "CO"],
    4: ["UTG", "MP", "HJ", "CO"],
    5: ["UTG", "UTG+1", "MP", "HJ", "CO"],
    6: ["UTG", "UTG+1", "MP", "LJ", "HJ", "CO"],
}


def position_names(n: int) -> list[str]:
    """Names indexed by ``pos_idx`` = seats clockwise from the button (0 = BTN)."""
    if n == 2:
        return ["BTN", "BB"]  # heads-up: the button is also the small blind
    return ["BTN", "SB", "BB"] + _EARLY_NAMES[n - 3]


# --------------------------------------------------------------------------- actions
@dataclass(frozen=True)
class Action:
    """What a bot returns. ``amount`` is only used for ``raise`` and means *raise to*
    (the total you want to have bet on this street), like most poker UIs."""

    kind: str  # "fold" | "check" | "call" | "raise"
    amount: int = 0

    @staticmethod
    def fold() -> "Action":
        return Action("fold")

    @staticmethod
    def check() -> "Action":
        return Action("check")

    @staticmethod
    def call() -> "Action":
        return Action("call")

    @staticmethod
    def raise_to(amount: int) -> "Action":
        return Action("raise", int(amount))


@dataclass
class ActionEvent:
    """One row of the hand history. Includes the blind posts (kind 'sb' / 'bb')."""

    seq: int
    street: int  # 0 preflop, 1 flop, 2 turn, 3 river
    seat: int
    kind: str  # sb bb fold check call bet raise
    amount: int  # chips moved into the pot by this action
    to_total: int  # the seat's total bet on this street after the action
    pot_before: int
    to_call: int
    stack_before: int
    min_raise_to: int
    max_raise_to: int
    num_active: int  # players still in the hand before this action
    all_in: int = 0
    corrected: int = 0  # 0 ok, 1 illegal/clamped action was fixed, 2 bot crashed
    think_ms: float = 0.0


# ----------------------------------------------------------------------- observations
@dataclass(frozen=True)
class PlayerView:
    seat: int
    name: str
    stack: int
    bet: int  # bet on the current street
    folded: bool
    all_in: bool
    position: str


@dataclass
class Observation:
    """Everything a bot may know when it has to act. All chip values are integers."""

    hand_no: int
    seat: int
    n_players: int
    button: int
    position: str
    pos_idx: int
    street: int
    hole: tuple
    board: tuple
    pot: int
    to_call: int
    stack: int
    bet: int  # your bet on this street so far
    can_raise: bool
    min_raise_to: int
    max_raise_to: int  # == your all-in
    small_blind: int
    big_blind: int
    players: tuple  # tuple[PlayerView, ...], indexed by seat
    history: tuple  # tuple[ActionEvent, ...] for this hand so far

    @property
    def can_check(self) -> bool:
        return self.to_call == 0

    @property
    def pot_odds(self) -> float:
        """Fraction of the final pot you must put in to call (0 if checking is free)."""
        return self.to_call / (self.pot + self.to_call) if self.to_call else 0.0

    @property
    def num_active(self) -> int:
        return sum(1 for p in self.players if not p.folded)

    @property
    def num_opponents_live(self) -> int:
        return self.num_active - 1


@dataclass
class MatchInfo:
    """Handed to ``Bot.on_match_start``."""

    seat: int
    names: tuple
    n_players: int
    small_blind: int
    big_blind: int
    starting_stack: int
    n_hands: int


@dataclass
class HandSummary:
    """Handed to ``Bot.on_hand_end``. Hole cards are only revealed for showdown players."""

    hand_no: int
    board: tuple
    net: tuple  # chips won/lost per seat
    revealed: dict  # seat -> hole cards (only those who reached showdown)
    events: tuple
    showdown: bool


# ---------------------------------------------------------------------------- results
@dataclass
class SeatResult:
    seat: int
    hole: tuple
    start_stack: int
    final_stack: int
    net: int
    pos_idx: int
    position: str
    vpip: int = 0
    pfr: int = 0
    saw_flop: int = 0
    showdown: int = 0
    won_showdown: int = 0
    folded_street: int = -1  # street the player folded on, -1 if never
    hand_score: int = -1  # evaluator score at showdown, -1 otherwise


@dataclass
class HandResult:
    hand_no: int
    button: int
    board: list
    events: list
    seats: list
    pot_total: int
    showdown: bool


@dataclass
class MatchResult:
    seed: int
    names: list  # bot name per seat
    config: dict
    hands: list = field(default_factory=list)
    errors: list = field(default_factory=list)  # (seat, message)
    error_counts: list = field(default_factory=list)  # per seat
    duration_s: float = 0.0

    @property
    def net_by_seat(self) -> list:
        totals = [0] * len(self.names)
        for h in self.hands:
            for s in h.seats:
                totals[s.seat] += s.net
        return totals
