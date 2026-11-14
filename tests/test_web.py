"""API and live-frame checks. The website reads these payloads."""

import json
import os
import tempfile
import unittest
from urllib.request import urlopen

from pokerarena.arena import Arena, ArenaConfig
from pokerarena.bots import builtin_specs
from pokerarena.live_runner import LiveRunner
from pokerarena.starter import starter_source
from pokerarena.http_api import (
    BROADCAST_EPOCH,
    BROADCAST_STEP_S,
    broadcast_frame,
    hand_payload,
    leaderboard_payload,
    live_frame,
    playable_bot_names,
    seat_tables,
)
from pokerarena.storage import Store


class LiveFrameTests(unittest.TestCase):
    def test_same_seed_is_the_same_hand(self):
        a = live_frame(["tag", "nit", "lag", "rock", "calling_station", "maniac"], 42, 2, 0)
        b = live_frame(["tag", "nit", "lag", "rock", "calling_station", "maniac"], 42, 2, 0)
        self.assertEqual(a["frame"]["seats"][0]["hole"], b["frame"]["seats"][0]["hole"])
        self.assertEqual(a["frame"]["phase"], "deal")
        self.assertEqual(len(a["frame"]["seats"]), 6)

    def test_cursor_advances_to_an_action(self):
        early = live_frame(["tag", "nit"], 3, 1, 1)
        later = live_frame(["tag", "nit"], 3, 1, 5)
        self.assertEqual(early["frame"]["phase"], "blind")
        self.assertEqual(later["frame"]["phase"], "result")
        self.assertGreater(later["cursor"], early["cursor"])
        done = live_frame(["tag", "nit"], 3, 1, 99)
        self.assertTrue(done["done"])

    def test_rejects_a_duplicate_seat(self):
        with self.assertRaises(ValueError):
            live_frame(["tag", "tag"], 1, 1, 0)

    def test_broadcast_is_the_same_for_everyone_at_one_moment(self):
        moment = BROADCAST_EPOCH + 40 * BROADCAST_STEP_S
        a = broadcast_frame(moment, table=0)
        b = broadcast_frame(moment, table=0)
        self.assertEqual(a["cursor"], b["cursor"])
        self.assertEqual(a["shoe"], b["shoe"])
        self.assertEqual(a["frame"]["seats"][0]["hole"], b["frame"]["seats"][0]["hole"])
        self.assertTrue(a["broadcast"])
        later = broadcast_frame(moment + BROADCAST_STEP_S, table=0)
        self.assertEqual(later["cursor"], a["cursor"] + 1)

    def test_a_year_of_broadcast_is_one_shoe_not_a_walk(self):
        import time
        t0 = time.perf_counter()
        frame = broadcast_frame(BROADCAST_EPOCH + 365 * 86400, table=0)
        self.assertLess(time.perf_counter() - t0, 1.0)
        self.assertGreater(frame["shoe"], 1000)
        self.assertIn("seats", frame["frame"])

    def test_broadcast_ignores_a_request_trying_to_pick_the_game(self):
        # The public route takes only a table index. A huge index wraps.
        wrapped = broadcast_frame(BROADCAST_EPOCH, table=99)
        first = broadcast_frame(BROADCAST_EPOCH, table=wrapped["table"])
        self.assertEqual(wrapped["names"], first["names"])
        self.assertGreaterEqual(wrapped["tables"], 1)

    def test_more_bots_open_more_tables(self):
        self.assertEqual(len(seat_tables(["a", "b", "c", "d", "e", "f"])), 1)
        two = seat_tables(["a", "b", "c", "d", "e", "f", "g"])
        self.assertEqual(len(two), 2)
        self.assertEqual(len(two[0]), 6)
        self.assertEqual(len(two[1]), 6)
        self.assertIn("g", two[1])
        many = seat_tables([f"bot{i}" for i in range(60)])
        self.assertEqual(len(many), 10)
        self.assertTrue(all(len(t) == 6 for t in many))


class ApiPayloadTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        self.tmp.close()
        self.store = Store(self.tmp.name)
        specs = builtin_specs(["tag", "nit", "lag", "rock", "calling_station", "maniac"])
        Arena(self.store, specs, ArenaConfig(hands_per_match=6, workers=1, seed=2)).run(1)

    def test_registered_bots_seat_extra_tables(self):
        frame = broadcast_frame(BROADCAST_EPOCH, table=0, store=self.store)
        # six played bots plus the built-ins that have not sat yet
        self.assertGreater(frame["tables"], 1)
        seated = []
        for i in range(frame["tables"]):
            seated.extend(broadcast_frame(BROADCAST_EPOCH, table=i, store=self.store)["names"])
        self.assertIn("tag", seated)
        self.assertIn("equity", seated)

    def test_a_missing_bot_file_is_not_seated(self):
        self.store.register_bot(
            "gone_bot",
            '{"kind":"file","target":"/tmp/does-not-exist-pokerarena.py","class_name":"Gone"}',
            "",
            1500,
        )
        names = playable_bot_names(self.store)
        self.assertNotIn("gone_bot", names)
        frame = broadcast_frame(BROADCAST_EPOCH, table=0, store=self.store)
        self.assertIn("seats", frame["frame"])

    def test_live_runner_deals_a_new_hand_and_saves_it(self):
        runner = LiveRunner(self.store)
        runner._play_one_step()
        first = runner.snapshot(0)
        self.assertTrue(first["playing"])
        self.assertEqual(first["frame"]["phase"], "deal")
        seen = {first["frame"]["phase"]}
        for _ in range(40):
            runner._play_one_step()
            seen.add(runner.snapshot(0)["frame"]["phase"])
        self.assertIn("preflop", seen)
        before = self.store.db.execute("SELECT COUNT(*) n FROM hands").fetchone()["n"]
        # Finish the rest of the 6-hand match. A hand is a few dozen steps.
        for _ in range(400):
            runner._play_one_step()
            if runner.snapshot(0)["hands_saved"]:
                break
        after = self.store.db.execute("SELECT COUNT(*) n FROM hands").fetchone()["n"]
        self.assertGreater(after, before)
        runner.stop()

    def test_starter_is_a_bot_file(self):
        src = starter_source("my bot!")
        self.assertIn('name = "my_bot"', src)
        self.assertIn("def act", src)

    def tearDown(self):
        self.store.close()
        os.unlink(self.tmp.name)

    def test_leaderboard_and_hand_are_jsonable(self):
        board = leaderboard_payload(self.store)
        self.assertEqual(len(board["bots"]), 6)
        self.assertIn("ci95", board["bots"][0])
        hid = self.store.db.execute("SELECT hand_id FROM hands LIMIT 1").fetchone()["hand_id"]
        hand = hand_payload(self.store, hid)
        json.dumps(hand)
        self.assertEqual(len(hand["players"]), 6)
        self.assertTrue(hand["actions"])


class ServeTests(unittest.TestCase):
    def test_local_server_answers_health_and_a_page(self):
        import threading
        from pokerarena.http_api import make_handler, _with_static
        from http.server import ThreadingHTTPServer

        public = os.path.join(os.path.dirname(__file__), "..", "public")
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), _with_static(make_handler(Store(":memory:")), public))
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            with urlopen(f"http://127.0.0.1:{port}/api/health") as res:
                self.assertEqual(json.load(res)["ok"], True)
            with urlopen(f"http://127.0.0.1:{port}/") as res:
                html = res.read().decode()
            self.assertIn("PokerArena", html)
            with urlopen(f"http://127.0.0.1:{port}/app.js") as res:
                self.assertIn("leaderboard", res.read().decode())
        finally:
            httpd.shutdown()


if __name__ == "__main__":
    unittest.main()
