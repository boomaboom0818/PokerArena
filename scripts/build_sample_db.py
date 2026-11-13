"""Build data/sample.db so the hosted site has a leaderboard on first load.

    python scripts/build_sample_db.py
"""

from pokerarena.arena import Arena, ArenaConfig
from pokerarena.bots import builtin_specs, specs_from_dir
from pokerarena.storage import Store


def main() -> None:
    specs = builtin_specs() + specs_from_dir("bots_user")
    store = Store("data/sample.db")
    Arena(store, specs, ArenaConfig(hands_per_match=24, workers=1, seed=11)).run(4)
    rows = store.leaderboard()
    print(f"sample db: {len(rows)} bots, leader {rows[0]['bot']} {rows[0]['elo']:.0f}")
    store.close()


if __name__ == "__main__":
    main()
