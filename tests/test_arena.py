import random
import unittest

from pokerarena.bots import BotSpec, builtin_specs
from pokerarena.bots.base import Bot
from pokerarena.cards import parse_cards
from pokerarena.dataset import iter_decisions, iter_hands
from pokerarena.elo import EloConfig, table_deltas
from pokerarena.engine import Table
from pokerarena.evaluator import evaluate
from pokerarena.models import Action
from pokerarena.storage import Store
from pokerarena.arena import make_tables


def ev(s):
    return evaluate(parse_cards(s))


class Evaluator(unittest.TestCase):
    def test_ordering(self):
        hands = [
            "2c 3d 5h 7s 9c Jd Kh",      # high card
            "2c 2d 5h 7s 9c Jd Kh",      # pair
            "2c 2d 5h 5s 9c Jd Kh",      # two pair
            "2c 2d 2h 7s 9c Jd Kh",      # trips
            "3c 4d 5h 6s 7c Jd Kh",      # straight
            "2c 4c 6c 8c Tc Jd Kh",      # flush
            "2c 2d 2h 7s 7c Jd Kh",      # full house
            "2c 2d 2h 2s 9c Jd Kh",      # quads
            "3c 4c 5c 6c 7c Jd Kh",      # straight flush
        ]
        scores = [ev(h) for h in hands]
        self.assertEqual(scores, sorted(scores))
        self.assertEqual(len(set(scores)), len(scores))

    def test_wheel_and_broadway(self):
        wheel = ev("Ac 2d 3h 4s 5c 9d Kh")
        six_high = ev("2c 3d 4h 5s 6c 9d Kh")
        broadway = ev("Ac Kd Qh Js Tc 2d 3h")
        self.assertLess(wheel, six_high)
        self.assertLess(six_high, broadway)

    def test_kickers_and_full_house(self):
        self.assertGreater(ev("Ac Ad Kh 5s 3c 2d 7h"), ev("Ac Ad Qh 5s 3c 2d 7h"))
        # two trips -> full house with the lower trips as the pair
        self.assertEqual(ev("Ac Ad Ah Kc Kd Ks 2h") >> 20, 6)
        self.assertGreater(ev("Ac Ad Ah Kc Kd 2s 2h"), ev("Kc Kd Kh Ac Ad 2s 2h"))


class Station(Bot):
    def act(self, obs):
        return Action.call()


class Shover(Bot):
    def act(self, obs):
        return Action.raise_to(obs.max_raise_to) if obs.can_raise else Action.call()


class Crasher(Bot):
    def act(self, obs):
        raise RuntimeError("boom")


class Illegal(Bot):
    def act(self, obs):
        return "check" if obs.to_call else Action.raise_to(1)  # illegal check + too-small raise


def run_table(bots, hands=60, seed=1, stack=10_000):
    names = [f"b{i}" for i in range(len(bots))]
    return Table(bots, names, starting_stack=stack, seed=seed).run(hands)


class Engine(unittest.TestCase):
    def test_chip_conservation_random_bots(self):
        specs = builtin_specs(["random", "maniac", "calling_station", "nit", "tag", "lag", "rock"])
        bots = [s.build() for s in specs]
        res = run_table(bots, hands=300, seed=7)
        for h in res.hands:
            self.assertEqual(sum(s.net for s in h.seats), 0)
            self.assertEqual(sum(s.final_stack for s in h.seats), 7 * 10_000)
        self.assertEqual(sum(res.net_by_seat), 0)

    def test_side_pots_with_uneven_stacks_via_shoves(self):
        # everyone shoves with equal stacks -> big multiway all-in, chips must balance
        res = run_table([Shover() for _ in range(6)], hands=100, seed=3)
        self.assertTrue(any(h.showdown for h in res.hands))
        for h in res.hands:
            self.assertEqual(sum(s.net for s in h.seats), 0)

    def test_side_pots_uneven_stacks(self):
        names = ["a", "b", "c", "d"]
        for seed in range(30):
            t = Table([Shover() for _ in names], names, starting_stack=[500, 1500, 4000, 10_000], seed=seed)
            res = t.run(8)
            for h in res.hands:
                self.assertEqual(sum(s.net for s in h.seats), 0)
                # nobody can win more than every opponent put in, or lose more than their stack
                for s in h.seats:
                    self.assertGreaterEqual(s.final_stack, 0)
                    self.assertGreaterEqual(s.net, -s.start_stack)

    def test_heads_up(self):
        res = run_table([Station(), Shover()], hands=40, seed=5)
        for h in res.hands:
            self.assertEqual(sum(s.net for s in h.seats), 0)
            self.assertEqual(h.events[0].kind, "sb")
            self.assertEqual(h.events[0].seat, h.button)

    def test_deterministic(self):
        mk = lambda: [s.build() for s in builtin_specs(["random", "tag", "lag", "nit", "maniac", "rock", "calling_station"])]
        a = run_table(mk(), hands=50, seed=11)
        b = run_table(mk(), hands=50, seed=11)
        self.assertEqual(a.net_by_seat, b.net_by_seat)

    def test_crash_and_illegal_actions_are_contained(self):
        res = run_table([Crasher(), Illegal(), Station(), Station()], hands=30, seed=2)
        self.assertGreater(res.error_counts[0], 0)
        kinds = {e.corrected for h in res.hands for e in h.events}
        self.assertIn(2, kinds)
        self.assertIn(1, kinds)
        for h in res.hands:
            self.assertEqual(sum(s.net for s in h.seats), 0)

    def test_fold_out_has_no_showdown(self):
        class Folder(Bot):
            def act(self, obs):
                return Action.fold()
        res = run_table([Folder() for _ in range(5)], hands=10)
        for h in res.hands:
            self.assertFalse(h.showdown)
            self.assertEqual(h.board, [])


class Elo(unittest.TestCase):
    def test_zero_sum_and_direction(self):
        names = list("abcdefg")
        ratings = {n: 1500.0 for n in names}
        profit = {n: float(i) for i, n in enumerate(names)}  # g best
        d = table_deltas(ratings, profit, {n: 100 for n in names}, EloConfig())
        self.assertAlmostEqual(sum(d.values()), 0.0)
        self.assertGreater(d["g"], 0)
        self.assertLess(d["a"], 0)
        self.assertAlmostEqual(d["g"], 16 * 0.5 * 6 / 6 * 1, places=6)  # wins all 6 pairs: K*0.5

    def test_upset_moves_more(self):
        ratings = {"hi": 1800.0, "lo": 1200.0}
        cfg = EloConfig(k=16)
        favourite_wins = table_deltas(ratings, {"hi": 5, "lo": 0}, {"hi": 99, "lo": 99}, cfg)
        upset = table_deltas(ratings, {"hi": 0, "lo": 5}, {"hi": 99, "lo": 99}, cfg)
        self.assertGreater(upset["lo"], favourite_wins["hi"])


class Storage(unittest.TestCase):
    def test_roundtrip_and_exports(self):
        specs = builtin_specs(["random", "maniac", "calling_station", "nit", "tag", "lag", "rock"])
        store = Store(":memory:")
        for s in specs:
            store.register_bot(s.name, "{}", "", 1500.0)
        res = Table([s.build() for s in specs], [s.name for s in specs], seed=9).run(70)
        before = {s.name: 1500.0 for s in specs}
        store.save_match(1, 1, 0, res, before, {n: 1500.0 + i for i, n in enumerate(before)})
        n_hands = store.db.execute("SELECT COUNT(*) FROM hands").fetchone()[0]
        self.assertEqual(n_hands, 70)
        self.assertEqual(store.db.execute("SELECT COUNT(*) FROM hand_players").fetchone()[0], 70 * 7)
        decisions = list(iter_decisions(store))
        self.assertTrue(decisions)
        d = decisions[0]
        for key in ("hole", "board", "action", "hand_net_bb", "history", "pot_bb"):
            self.assertIn(key, d)
        # board only shows cards visible at that street
        for r in decisions:
            self.assertEqual(len(r["board"].split()), [0, 3, 4, 5][r["street"]])
        hands = list(iter_hands(store))
        self.assertEqual(len(hands), 70)
        self.assertEqual(len(hands[0]["players"]), 7)
        lb = store.leaderboard()
        self.assertEqual(len(lb), 7)
        top = list(iter_decisions(store, top=1))
        self.assertEqual({r["bot_id"] for r in top}, {lb[0]["bot"]})


class Matchmaking(unittest.TestCase):
    def test_everyone_plays_and_tables_are_full(self):
        specs = builtin_specs()  # 9 bots
        tables = make_tables(specs, {}, 6, "random", random.Random(1))
        self.assertEqual(len(tables), 2)
        self.assertTrue(all(len(t) == 6 and len({s.name for s in t}) == 6 for t in tables))
        self.assertEqual({s.name for t in tables for s in t}, {s.name for s in specs})


if __name__ == "__main__":
    unittest.main()
