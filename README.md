# pokerarena — Texas Hold'em bot arena

Pure-Python (3.10+, **no dependencies**) arena where many bots play 6-handed no-limit
Hold'em at the same time, get a multiplayer **Elo** rating, and leave behind a
**SQLite database** with every hand and every decision, ready for training new bots.

```
python -m pokerarena new my_bot.py                                 # starter file
python -m pokerarena join my_bot.py                                # sit it with the built-ins
python -m pokerarena run --bot-dir bots_user --builtins --rounds 20   # play
python -m pokerarena leaderboard                                      # ratings + stats
python -m pokerarena serve                                            # website + API on :8787
python -m pokerarena replay                                           # print a hand
python -m pokerarena export decisions train.jsonl --top 3             # training data
python -m unittest discover -s tests                                  # tests
```

## Website

[public/](public/) is a static site: Elo rankings, a spectator view of every
table the field fills, stored-hand replay, and a connect page. Six bots is
one table. A seventh bot opens the next one.
`python -m pokerarena serve` keeps the tables playing. `GET /api/live` returns
the action the bots just took. The hosted site has no long-running process,
so it falls back to the shared clock. A visitor cannot
deal, pause, pick bots, or change the seed. `python -m pokerarena serve`
hosts the site and the JSON API together. The same API is what
[Vercel](vercel.json) runs from [api/index.py](api/index.py).

Deploy by importing this repo in the Vercel dashboard (framework preset: Other).
The committed [data/sample.db](data/sample.db) is the leaderboard the hosted
site reads. After a real run, replace that file (or set `POKERARENA_DB`) and
redeploy. To watch a match as it is written, run `serve` against your own
`arena.db` and open the site with `?api=http://127.0.0.1:8787`.

## How the arena works

* **Round** = every bot sits at one 6-seat table (random seats). With 12 bots that is 2 tables, with 60
  bots 10 tables. Leftover bots are re-used to fill the last table. All tables of a round are played
  **in parallel in separate processes**.
* **Match** = one table session of `--hands` hands (default 600, rounded up to a multiple of 6 so every
  bot gets the same number of turns on the button). The button rotates every hand.
* **Stacks reset to 100 BB before every hand.** Hands are therefore independent, low-variance samples
  and the training data is i.i.d.-ish. Blinds are 50/100 chips.
* Matches are **deterministic** given `--seed` (deck + each bot's `self.rng`).
* `--matchmaking elo` seats bots with similar ratings together; `random` (default) is best for unbiased
  ratings.

### Elo ([elo.py](pokerarena/elo.py))

Each table of N bots is treated as N·(N−1)/2 pairwise games decided by **who won more chips in the
match**. A bot's change is `K/(N−1) · Σ(S − E)`, so a table moves ratings by at most K and (with equal K)
is zero-sum. K = 32 for a bot's first 30 matches, then 16. Tables of one round are rated from the same
pre-round snapshot, so the result doesn't depend on which finished first. Start rating 1500.
The leaderboard also shows **bb/100 with a 95 % error bar** — poker is noisy, so read Elo together with
the confidence interval; run more rounds to tighten it.

## Write a bot

```python
from pokerarena.bots import Bot
from pokerarena.models import Action, Observation

class MyBot(Bot):
    name = "my_bot_v1"
    def act(self, obs: Observation) -> Action:
        if obs.can_check: return Action.check()
        return Action.call() if obs.pot_odds < 0.25 else Action.fold()
```

Put the file in a directory and pass `--bot-dir that_dir` (or `--bots path/file.py:MyBot`,
`--bots package.module:MyBot`). See [bots_user/example_bot.py](bots_user/example_bot.py) and the built-ins in
[bots/builtin.py](pokerarena/bots/builtin.py).

`Observation` ([models.py](pokerarena/models.py)) gives hole cards, board, pot, `to_call`, `stack`,
position, `can_raise`/`min_raise_to`/`max_raise_to`, all players' stacks/bets/fold status/names and the
full action history of the hand. Cards are ints `rank*4+suit`; use `pokerarena.cards.card_str`.
Raise amounts mean **raise-to** (total bet on the street). Optional hooks: `on_match_start`, `on_hand_end`
(reveals showdown cards). A fresh instance is created per match, so attributes persist across its hands.

Safety: an exception in `act` or an illegal action never crashes the match — it is corrected (illegal
check → fold, out-of-range raise → clamped, crash → check/fold), counted in `match_players.errors` and
flagged in `actions.corrected`; tracebacks go to the `errors` table.
Bot name = identity on the leaderboard; give each new version a new name.

## Data model ([storage.py](pokerarena/storage.py))

```
runs ─┐
      └< matches >─< match_players >── bots ──< rating_history
              │
              └< hands >─< hand_players   (hole cards of ALL players, net result, VPIP/PFR flags)
                    │
                    └< actions            (one row per action incl. blinds, with the state it was taken in)

VIEW decisions = actions ⨝ hand_players ⨝ hands ⨝ matches  → ready-made training rows
```

| table | grain | notable columns |
|---|---|---|
| `bots` | bot | `elo`, `matches`, `hands` |
| `rating_history` | bot × match | `elo_before`, `elo_after` → plot rating curves |
| `matches` | table session | `seed`, blinds, stack, `run_id`, `round_no` |
| `match_players` | bot × match | `net_chips`, `bb_per_100`, `rank`, `errors` |
| `hands` | hand | `board`, `button`, `pot_total`, `showdown` |
| `hand_players` | bot × hand | `hole`, `position`, `net`, `vpip`, `pfr`, `saw_flop`, `hand_category` |
| `actions` | action | `street`, `kind` (sb bb fold check call bet raise), `amount`, `to_total`, `pot_before`, `to_call`, `stack_before`, `min/max_raise_to`, `num_active`, `think_ms` |

Everything is plain SQL, e.g. how often does each bot fold to a river bet:

```sql
SELECT bot_id, AVG(action='fold') FROM decisions WHERE street=3 AND to_call>0 GROUP BY bot_id;
```

### Training data

`decisions` rows hold exactly what the bot saw when it acted + the label (`action`, `to_total`) +
the outcome (`hand_net_bb`: big blinds won/lost in that hand). Extra derived columns: `pot_bb`, `to_call_bb`,
`stack_bb`, `raise_pot_frac` and a compact `history` string such as `p:UTG:raise:3 p:BTN:call:3 f:...`.

```python
from pokerarena.dataset import iter_decisions, iter_hands
from pokerarena.features import encode_decision, action_class

for row in iter_decisions("arena.db", top=3):           # behaviour-clone the best bots
    x, y = encode_decision(row), action_class(row)      # 124 floats, 5 action classes
```

Filters: `bots=[...]`, `top=N`, `min_elo`, `min_bb100`, `run_id`, `winners_only`. CLI equivalents:

```
python -m pokerarena export decisions data.csv --top 3 --winners-only
python -m pokerarena export hands hands.jsonl           # full histories (all hole cards + actions)
```

Because *all* hole cards are stored, the data supports both honest-information models (use only the
acting seat's `hole`) and "oracle" training (e.g. value networks, equity targets).
You can also embed the engine directly (`pokerarena.engine.Table`) for self-play training loops.

## Layout

```
pokerarena/engine.py     betting rules, side pots, showdown     evaluator.py  7-card evaluator
pokerarena/arena.py      matchmaking + parallel rounds          elo.py        multiplayer Elo
pokerarena/storage.py    schema, writer, leaderboard            dataset.py    exports / iterators
pokerarena/bots/         Bot base class, loader, built-ins      features.py   optional encoders
```

## Notes / possible extensions

* No-limit only; chips are integers; stacks reset per hand (cash-game style with fixed depth).
* Elo ratings are relative to the pool; seed it with a few anchor bots (the built-ins) to keep scales comparable.
* Bots run in-process in the worker, with no time limit or sandbox — only run code you trust.
* Ideas: duplicate-deal (replay the same cards with rotated seats) for lower variance, per-action time limits,
  Parquet export, TrueSkill/Weng-Lin instead of pairwise Elo.
* The website does not execute uploaded bot code. Connecting a bot means running it
  locally (or on a machine you trust) with `--bot-dir`, then serving or redeploying the database.
