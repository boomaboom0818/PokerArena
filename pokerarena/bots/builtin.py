"""Built-in opponents of varying skill, so the arena works out of the box and new bots
have something to be measured against."""

from __future__ import annotations

from ..models import Action, Observation
from .base import Bot
from .strategy import chen_score, clamp_raise, equity_vs_random, postflop_strength


class RandomBot(Bot):
    name = "random"
    description = "Uniformly random legal action."

    def act(self, obs: Observation) -> Action:
        options = ["check" if obs.can_check else "fold", "call"]
        if obs.can_raise:
            options.append("raise")
        pick = self.rng.choice(options)
        if pick == "raise":
            return Action.raise_to(self.rng.randint(obs.min_raise_to, obs.max_raise_to))
        return Action(pick)


class CallingStation(Bot):
    name = "calling_station"
    description = "Never folds, never raises."

    def act(self, obs: Observation) -> Action:
        return Action.call()


class Maniac(Bot):
    name = "maniac"
    description = "Raises almost every pot with a big size, shoves sometimes."

    def act(self, obs: Observation) -> Action:
        if obs.can_raise and self.rng.random() < 0.8:
            if self.rng.random() < 0.12:
                return Action.raise_to(obs.max_raise_to)
            return Action.raise_to(clamp_raise(obs, max(obs.min_raise_to, obs.bet + 0.9 * obs.pot + obs.to_call)))
        return Action.call() if obs.to_call <= obs.stack * 0.3 else Action.fold()


class HeuristicBot(Bot):
    """Chen-formula preflop + made-hand strength postflop, parameterised by style."""

    name = "heuristic"
    # preflop thresholds on the Chen score
    open_thr = 7.0
    threebet_thr = 10.5
    call_thr = 8.0
    open_size = 3.0  # x big blind
    # postflop
    bet_thr = 0.55
    raise_thr = 0.8
    bluff = 0.1
    aggression = 0.7
    pot_frac = 0.65
    call_base = 0.3
    call_slope = 0.8

    _POS_ADJ = {"BTN": -1.5, "CO": -1.0, "HJ": 0.0, "LJ": 0.3, "MP": 0.5, "UTG+1": 0.8, "UTG": 1.0,
                "SB": 0.0, "BB": 0.0}

    def __init__(self, **overrides):
        super().__init__()
        for k, v in overrides.items():
            setattr(self, k, v)

    def strength(self, obs: Observation) -> float:
        return postflop_strength(obs.hole, obs.board)

    def act(self, obs: Observation) -> Action:
        return self._preflop(obs) if obs.street == 0 else self._postflop(obs)

    def _preflop(self, obs: Observation) -> Action:
        adj = self._POS_ADJ.get(obs.position, 0.0)
        chen = chen_score(obs.hole)
        bb = obs.big_blind
        facing_raise = obs.to_call > bb or (obs.bet > bb and obs.to_call > 0)
        if not facing_raise:
            if chen >= self.open_thr + adj and obs.can_raise:
                return Action.raise_to(clamp_raise(obs, self.open_size * bb))
            if obs.can_check:
                return Action.check()
            return Action.call() if chen >= self.call_thr + adj - 2 and obs.to_call <= bb else Action.fold()
        if chen >= self.threebet_thr + adj and obs.can_raise:
            return Action.raise_to(clamp_raise(obs, 3 * (obs.to_call + obs.bet)))
        if chen >= self.call_thr + adj and obs.to_call <= 0.25 * obs.stack:
            return Action.call()
        return Action.fold()

    def _postflop(self, obs: Observation) -> Action:
        s = self.strength(obs) + self.rng.uniform(-0.04, 0.04)
        if obs.to_call == 0:
            if obs.can_raise and (s >= self.bet_thr or self.rng.random() < self.bluff):
                return Action.raise_to(clamp_raise(obs, self.pot_frac * obs.pot))
            return Action.check()
        if obs.can_raise and s >= self.raise_thr and self.rng.random() < self.aggression:
            return Action.raise_to(clamp_raise(obs, obs.bet + obs.to_call + 0.75 * (obs.pot + obs.to_call)))
        if s >= self.call_base + self.call_slope * obs.pot_odds:
            return Action.call()
        return Action.fold()


class Nit(HeuristicBot):
    name = "nit"
    description = "Very tight, rarely bluffs."
    open_thr, threebet_thr, call_thr = 9.5, 13.0, 10.5
    bet_thr, raise_thr, bluff, aggression = 0.65, 0.9, 0.0, 0.5
    call_base = 0.4


class TAG(HeuristicBot):
    name = "tag"
    description = "Tight-aggressive reg."


class LAG(HeuristicBot):
    name = "lag"
    description = "Loose-aggressive, wide ranges, frequent bluffs."
    open_thr, threebet_thr, call_thr = 5.0, 9.0, 6.5
    bet_thr, raise_thr, bluff, aggression = 0.45, 0.7, 0.25, 0.8
    pot_frac, call_base = 0.75, 0.2


class Rock(HeuristicBot):
    name = "rock"
    description = "Tight-passive: plays good hands but rarely raises postflop."
    open_thr, threebet_thr, call_thr = 8.0, 12.0, 8.5
    bet_thr, raise_thr, bluff, aggression = 0.7, 0.95, 0.0, 0.2


class EquityBot(HeuristicBot):
    """Postflop decisions from Monte-Carlo equity against random hands."""

    name = "equity"
    description = "Monte-Carlo equity postflop, Chen preflop."
    iterations = 90
    bet_thr, raise_thr, bluff, aggression = 0.62, 0.8, 0.05, 0.7
    call_base, call_slope = 0.02, 1.05

    def strength(self, obs: Observation) -> float:
        opponents = min(max(obs.num_opponents_live, 1), 4)
        return equity_vs_random(obs.hole, obs.board, opponents, self.iterations, self.rng)


class EquityLAG(EquityBot):
    name = "equity_lag"
    description = "Equity bot with wider ranges and more aggression."
    open_thr, threebet_thr, call_thr = 5.5, 9.0, 7.0
    bet_thr, raise_thr, bluff, aggression = 0.5, 0.72, 0.18, 0.85
    call_base, call_slope = -0.03, 1.0


BUILTIN = {cls.name: cls for cls in (
    RandomBot, CallingStation, Maniac, Nit, Rock, TAG, LAG, EquityBot, EquityLAG)}
