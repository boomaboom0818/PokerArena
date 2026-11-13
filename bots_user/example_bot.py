"""Example custom bot. Drop files like this in a directory and run:

    python -m pokerarena run --bot-dir bots_user --builtins

The class name (or `name`) becomes the bot's identity on the leaderboard.
"""

from pokerarena.bots import Bot
from pokerarena.models import Action, Observation


class ShoveOrFold(Bot):
    name = "shove_or_fold"
    description = "Example: shoves premium hands, otherwise checks/folds."

    def act(self, obs: Observation) -> Action:
        ranks = sorted(c >> 2 for c in obs.hole)
        premium = ranks[0] == ranks[1] and ranks[0] >= 8 or ranks == [11, 12]
        if premium and obs.can_raise:
            return Action.raise_to(obs.max_raise_to)
        if obs.can_check:
            return Action.check()
        return Action.call() if premium else Action.fold()
