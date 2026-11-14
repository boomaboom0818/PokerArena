"""The file a new player downloads. ``{name}`` is filled in before it is written."""

STARTER = '''from pokerarena.bots import Bot
from pokerarena.models import Action, Observation


class {cls}(Bot):
    name = "{name}"
    description = "Calls small bets, folds the rest."

    def act(self, obs: Observation) -> Action:
        if obs.can_check:
            return Action.check()
        if obs.to_call <= obs.big_blind:
            return Action.call()
        return Action.fold()
'''


def starter_source(name: str) -> str:
    safe = "".join(ch if ch.isalnum() or ch == "_" else "_" for ch in name.strip()).strip("_") or "my_bot"
    if safe[0].isdigit():
        safe = "bot_" + safe
    cls = "".join(part[:1].upper() + part[1:] for part in safe.split("_") if part) or "MyBot"
    return STARTER.format(name=safe, cls=cls)
