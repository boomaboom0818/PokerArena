"""Base class every poker bot inherits from."""

from __future__ import annotations

import random

from ..models import Action, HandSummary, MatchInfo, Observation


class Bot:
    """Subclass this and implement :meth:`act`.

    * A fresh instance is created for every match (one table session), so instance
      attributes persist across the hands of that match - handy for opponent modelling.
    * ``self.rng`` is a ``random.Random`` seeded by the arena: use it (not the global
      ``random``) and matches stay reproducible.
    * ``act`` may return an :class:`Action`, a string (``"fold"``/``"check"``/``"call"``),
      or a ``("raise", amount)`` tuple. Illegal actions are corrected (and flagged in the
      database): a bad check becomes a fold, a raise outside the legal range is clamped.
    """

    #: Name shown on the leaderboard. Defaults to the class name.
    name: str = ""
    description: str = ""

    def __init__(self, **kwargs):
        self.rng = random.Random()
        self.seat = -1

    def on_match_start(self, info: MatchInfo) -> None:
        pass

    def act(self, obs: Observation) -> Action:
        raise NotImplementedError

    def on_hand_end(self, summary: HandSummary) -> None:
        pass
