"""API and live-frame checks. The website reads these payloads."""

import json
import os
import tempfile
import unittest
from urllib.request import urlopen

from pokerarena.arena import Arena, ArenaConfig
from pokerarena.bots import builtin_specs
from pokerarena.http_api import hand_payload, leaderboard_payload, live_frame
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


class ApiPayloadTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        self.tmp.close()
        self.store = Store(self.tmp.name)
        specs = builtin_specs(["tag", "nit", "lag", "rock", "calling_station", "maniac"])
        Arena(self.store, specs, ArenaConfig(hands_per_match=6, workers=1, seed=2)).run(1)

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
