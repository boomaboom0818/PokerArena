"""Figgie client checks. Nothing here needs the network."""

import json
import re
import socket
import struct
import threading
import unittest
from pathlib import Path

from pokerarena import figgie
from pokerarena.figgie import COLUMNS, Cache, SUITS, build_state, goal_odds, starter_source

ROOT = Path(__file__).resolve().parents[1]
MODULE = (ROOT / "spacetimedb-figgie" / "src" / "index.ts").read_text()
PAGE = (ROOT / "public" / "figgie.js").read_text()


def snake(name: str) -> str:
    return re.sub(r"(?<!^)([A-Z])", r"_\1", name).lower()


def module_columns() -> dict:
    """Column order of every table in the SpacetimeDB module source."""
    out = {}
    for m in re.finditer(r"const \w+ = table\(\{ name: '(\w+)'[^}]*\}, \{(.*?)\n\}\);", MODULE, re.S):
        out[m.group(1)] = [snake(c) for c in re.findall(r"^\s+(\w+): t\.", m.group(2), re.M)]
    return out


class SchemaTests(unittest.TestCase):
    def test_client_columns_match_the_module(self):
        cols = module_columns()
        cols["my_hand"] = cols["hand"]  # the view returns hand rows
        for table, names in COLUMNS.items():
            self.assertEqual(names, cols[table], table)

    def test_page_columns_match_the_module(self):
        cols = module_columns()
        block = PAGE[PAGE.index("const COLUMNS = {"):PAGE.index("};", PAGE.index("const COLUMNS = {"))]
        for table, body in re.findall(r"(\w+): \[(.*?)\]", block, re.S):
            self.assertEqual(re.findall(r'"(\w+)"', body), cols[table], table)

    def test_hands_stay_private(self):
        self.assertIn("table({ name: 'hand' }", MODULE)
        self.assertIn("table({ name: 'dealer' }", MODULE)
        self.assertIn("r.owner.eq(ctx.sender)", MODULE)


class OddsTests(unittest.TestCase):
    def test_sums_to_one(self):
        odds = goal_odds({"spades": 3, "clubs": 2, "hearts": 3, "diamonds": 2})
        self.assertAlmostEqual(sum(odds.values()), 1.0)

    def test_long_suit_points_at_its_partner(self):
        odds = goal_odds({"spades": 6, "clubs": 1, "hearts": 2, "diamonds": 1})
        self.assertEqual(max(odds, key=odds.get), "clubs")

    def test_even_hand_is_close_to_even(self):
        odds = goal_odds({"spades": 0, "clubs": 0, "hearts": 0, "diamonds": 0})
        for p in odds.values():
            self.assertAlmostEqual(p, 0.25)


def tbl(name, rows, deletes=()):
    return {"table_name": name, "updates": [{"inserts": [json.dumps(r) for r in rows],
                                             "deletes": [json.dumps(r) for r in deletes]}]}


class CacheTests(unittest.TestCase):
    def test_objects_then_arrays(self):
        cache = Cache()
        q = {"quote_id": 1, "table_id": 0, "seat_key": 0, "name": "a", "suit": "hearts", "side": "bid", "price": 5, "at": 1.0}
        cache.apply([tbl("quote", [q])])
        self.assertEqual(len(cache.rows("quote")), 1)
        as_array = [q[c] for c in COLUMNS["quote"]]
        newer = dict(q, price=6)
        cache.apply([tbl("quote", [[newer[c] for c in COLUMNS["quote"]]], deletes=[as_array])])
        self.assertEqual([r["price"] for r in cache.rows("quote")], [6])
        cache.apply([tbl("quote", [], deletes=[[newer[c] for c in COLUMNS["quote"]]])])
        self.assertEqual(cache.rows("quote"), [])

    def test_state_for_a_seated_bot(self):
        cache = Cache()
        cache.apply([
            tbl("figgie_table", [{"table_id": 0, "round_no": 3, "phase": "trading", "started_at": 0, "ends_at": 60_000,
                                  "next_at": 69_000, "pot": 200, "goal": "", "twelve": "", "counts": "", "names": "me,x",
                                  "last_trade": ""}]),
            tbl("seat", [
                {"seat_key": 0, "table_id": 0, "seat": 0, "name": "me", "kind": "remote", "cash": 300, "cards": 10, "buys": 0, "sells": 0, "actions": 0},
                {"seat_key": 1, "table_id": 0, "seat": 1, "name": "x", "kind": "house", "cash": 300, "cards": 10, "buys": 0, "sells": 0, "actions": 0},
            ]),
            tbl("my_hand", [{"seat_key": 0, "table_id": 0, "owner": {}, "name": "me", "spades": 5, "clubs": 1,
                             "hearts": 2, "diamonds": 2, "dealt": "[4,2,2,2]"}]),
            tbl("quote", [
                {"quote_id": 1, "table_id": 0, "seat_key": 1, "name": "x", "suit": "clubs", "side": "ask", "price": 9, "at": 1},
                {"quote_id": 2, "table_id": 0, "seat_key": 1, "name": "x", "suit": "clubs", "side": "bid", "price": 4, "at": 2},
                {"quote_id": 3, "table_id": 0, "seat_key": 0, "name": "me", "suit": "clubs", "side": "bid", "price": 6, "at": 3},
            ]),
            tbl("trade", [{"trade_id": 1, "table_id": 0, "round_no": 3, "suit": "spades", "price": 3, "buyer": "me", "seller": "x", "at": 5}]),
        ])
        s = build_state(cache, "me", now=30.0)
        self.assertTrue(s.seated)
        self.assertEqual(s.hand["spades"], 5)
        self.assertEqual(s.dealt["spades"], 4)
        self.assertEqual((s.book["clubs"].bid, s.book["clubs"].bidder), (6, "me"))
        self.assertEqual((s.book["clubs"].ask, s.book["clubs"].asker), (9, "x"))
        self.assertEqual(len(s.trades), 1)
        self.assertEqual(len(s.my_quotes), 1)
        self.assertAlmostEqual(s.time_left, 30.0)
        self.assertEqual(s.goal_odds(), goal_odds({"spades": 4, "clubs": 2, "hearts": 2, "diamonds": 2}))

    def test_not_seated(self):
        self.assertFalse(build_state(Cache(), "nobody").seated)


class FrameTests(unittest.TestCase):
    def pair(self):
        a, b = socket.socketpair()
        ws = figgie.WebSocket.__new__(figgie.WebSocket)
        ws.sock, ws._buf, ws.lock = a, b"", threading.Lock()
        self.addCleanup(a.close)
        self.addCleanup(b.close)
        return ws, b

    def test_reads_server_frames_and_answers_ping(self):
        ws, server = self.pair()
        text = json.dumps({"x": "y" * 300}).encode()
        server.sendall(bytes([0x89, 2]) + b"hi")  # ping
        server.sendall(bytes([0x01, 126]) + struct.pack("!H", 100) + text[:100])  # first fragment
        server.sendall(bytes([0x80, 126]) + struct.pack("!H", len(text) - 100) + text[100:])  # continuation
        self.assertEqual(ws.recv(), text.decode())
        pong = server.recv(64)
        self.assertEqual(pong[0], 0x8A)

    def test_client_frames_are_masked(self):
        ws, server = self.pair()
        ws.send("hello")
        raw = server.recv(64)
        self.assertEqual(raw[0], 0x81)
        self.assertTrue(raw[1] & 0x80)
        mask, body = raw[2:6], raw[6:6 + (raw[1] & 0x7F)]
        self.assertEqual(bytes(b ^ mask[i & 3] for i, b in enumerate(body)), b"hello")


class StarterTests(unittest.TestCase):
    def test_starter_defines_a_bot(self):
        ns = {}
        exec(compile(starter_source("My Figgie-Bot"), "starter", "exec"), ns)
        bots = [v for v in ns.values() if isinstance(v, type) and issubclass(v, figgie.FiggieBot) and v is not figgie.FiggieBot]
        self.assertEqual(len(bots), 1)
        self.assertEqual(bots[0].name, "my_figgie_bot")

    def test_starter_trades_against_a_state(self):
        ns = {}
        exec(compile(starter_source("t"), "starter", "exec"), ns)
        bot = next(v for v in ns.values() if isinstance(v, type) and issubclass(v, figgie.FiggieBot) and v is not figgie.FiggieBot)()
        sent = []
        bot._call = lambda reducer, args: sent.append((reducer, args))
        s = figgie.State(me="t", seated=True, phase="trading", time_left=30,
                         hand=dict(zip(SUITS, [6, 1, 2, 1])), dealt=dict(zip(SUITS, [6, 1, 2, 1])), cash=300)
        s.book["clubs"].ask, s.book["clubs"].asker = 2, "x"
        bot.on_update(s)
        self.assertEqual(sent, [("buy", ["clubs"])])

    def test_clean_name(self):
        self.assertEqual(figgie.clean_name("My Bot!"), "mybot")


if __name__ == "__main__":
    unittest.main()
