"""Play Figgie in the live arena from Python. Standard library only.

The arena is a SpacetimeDB database. A bot opens one WebSocket
(subprotocol ``v1.json.spacetimedb``), subscribes to the public tables and its own
``my_hand`` view, and calls reducers (``register``, ``bid``, ``ask``, ``buy``, ``sell``,
``cancel``). This module does all of that, so a bot only writes ``on_update``::

    from pokerarena.figgie import FiggieBot

    class MyBot(FiggieBot):
        name = "my_figgie_bot"

        def on_update(self, s):
            best = max(s.goal_odds(), key=s.goal_odds().get)
            if s.book[best].ask and s.book[best].ask <= 8:
                self.buy(best)

Run it with ``python -m pokerarena figgie my_bot.py``.
"""

from __future__ import annotations

import base64
import hashlib
import importlib.util
import inspect
import json
import os
import queue
import re
import socket
import ssl
import struct
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, field
from math import comb
from pathlib import Path
from urllib.parse import urlsplit

HOST = "wss://maincloud.spacetimedb.com"
DATABASE = "figgie-arena"
PROTOCOL = "v1.json.spacetimedb"
SUITS = ("spades", "clubs", "hearts", "diamonds")
PARTNER = {"spades": "clubs", "clubs": "spades", "hearts": "diamonds", "diamonds": "hearts"}
GOAL_PAY = 10
POT = 200
START_CASH = 350

SUBSCRIPTIONS = [
    "SELECT * FROM figgie_table",
    "SELECT * FROM seat",
    "SELECT * FROM quote",
    "SELECT * FROM trade",
    "SELECT * FROM my_hand",
    "SELECT * FROM player",
]


# ---------------------------------------------------------------- odds

def goal_odds(hand: dict) -> dict:
    """P(goal suit = s) from your own hand alone (12 equally likely decks)."""
    h = [int(hand.get(s, 0)) for s in SUITS]
    weights = dict.fromkeys(SUITS, 0.0)
    for twelve in range(4):
        for eight in range(4):
            if eight == twelve:
                continue
            counts = [10, 10, 10, 10]
            counts[twelve], counts[eight] = 12, 8
            w = 1
            for n, k in zip(counts, h):
                w *= comb(n, k)
            weights[PARTNER[SUITS[twelve]]] += w
    total = sum(weights.values()) or 1
    return {s: w / total for s, w in weights.items()}


# ---------------------------------------------------------------- state

@dataclass
class Side:
    bid: int | None = None
    bidder: str = ""
    ask: int | None = None
    asker: str = ""


@dataclass
class State:
    """What a bot sees. Hands of other bots stay hidden until the round ends."""

    me: str
    seated: bool = False
    table_id: int = -1
    round_no: int = 0
    phase: str = ""
    time_left: float = 0.0
    hand: dict = field(default_factory=lambda: dict.fromkeys(SUITS, 0))
    dealt: dict = field(default_factory=lambda: dict.fromkeys(SUITS, 0))
    cash: int = 0
    book: dict = field(default_factory=lambda: {s: Side() for s in SUITS})
    quotes: list = field(default_factory=list)
    trades: list = field(default_factory=list)
    players: list = field(default_factory=list)
    goal: str = ""
    pot: int = 0

    @property
    def my_quotes(self) -> list:
        return [q for q in self.quotes if q["name"] == self.me]

    def goal_odds(self) -> dict:
        """P(goal suit) from the hand you were dealt (cards you traded for carry no news)."""
        return goal_odds(self.dealt)


# Column order of each table. Initial rows arrive as JSON objects, later updates as
# positional JSON arrays in this order (tests check it against the module source).
COLUMNS = {
    "player": ["name", "owner", "kind", "elo", "rounds", "pnl", "pnl_sq", "bonuses", "tops", "trades",
               "edge", "goal_cards", "rejects", "online", "last_seen", "joined_at", "table_id"],
    "figgie_table": ["table_id", "round_no", "phase", "started_at", "ends_at", "next_at", "pot", "goal",
                     "twelve", "counts", "names", "last_trade"],
    "seat": ["seat_key", "table_id", "seat", "name", "kind", "cash", "cards", "buys", "sells", "actions"],
    "my_hand": ["seat_key", "table_id", "owner", "name", "spades", "clubs", "hearts", "diamonds", "dealt"],
    "quote": ["quote_id", "table_id", "seat_key", "name", "suit", "side", "price", "at"],
    "trade": ["trade_id", "table_id", "round_no", "suit", "price", "buyer", "seller", "at"],
    "round_result": ["result_id", "table_id", "round_no", "started_at", "ended_at", "goal", "twelve", "counts",
                     "players", "tape", "trades", "volume"],
}
KEYS = {"player": "name", "figgie_table": "table_id", "seat": "seat_key", "my_hand": "seat_key",
        "quote": "quote_id", "trade": "trade_id", "round_result": "result_id"}


def decode_row(table: str, raw: str) -> dict:
    row = json.loads(raw)
    if isinstance(row, list):
        row = dict(zip(COLUMNS[table], row))
    return row


class Cache:
    """Rows of the subscribed tables, kept in sync from WebSocket updates.

    An update is a delete of the old row plus an insert of the new one. Rows are keyed
    by primary key because the same row can arrive as an object or as an array.
    """

    def __init__(self):
        self.tables: dict[str, dict] = {}

    def apply(self, tables: list) -> None:
        for tbl in tables or []:
            name = tbl["table_name"]
            if name not in COLUMNS:
                continue
            rows = self.tables.setdefault(name, {})
            key = KEYS[name]
            for upd in tbl.get("updates", []):
                for raw in upd.get("deletes", []):
                    rows.pop(decode_row(name, raw)[key], None)
                for raw in upd.get("inserts", []):
                    row = decode_row(name, raw)
                    rows[row[key]] = row

    def rows(self, name: str) -> list:
        return list(self.tables.get(name, {}).values())


def build_state(cache: Cache, me: str, now: float | None = None) -> State:
    now = time.time() if now is None else now
    s = State(me=me)
    seat = next((r for r in cache.rows("seat") if r["name"] == me), None)
    if not seat:
        return s
    tid = seat["table_id"]
    tbl = next((r for r in cache.rows("figgie_table") if r["table_id"] == tid), None)
    s.seated = True
    s.table_id = tid
    s.cash = seat["cash"]
    if tbl:
        s.round_no = tbl["round_no"]
        s.phase = tbl["phase"]
        s.goal = tbl["goal"]
        s.pot = tbl["pot"]
        s.time_left = max(0.0, tbl["ends_at"] / 1000 - now) if tbl["phase"] == "trading" else 0.0
    mine = next((r for r in cache.rows("my_hand") if r["table_id"] == tid), None)
    if mine:
        s.hand = {suit: mine[suit] for suit in SUITS}
        try:
            s.dealt = dict(zip(SUITS, json.loads(mine.get("dealt") or "[]")))
        except ValueError:
            pass
        if len(s.dealt) != 4:
            s.dealt = dict(s.hand)
    s.players = sorted((r for r in cache.rows("seat") if r["table_id"] == tid), key=lambda r: r["seat"])
    s.quotes = sorted((r for r in cache.rows("quote") if r["table_id"] == tid), key=lambda r: r["at"])
    s.trades = sorted(
        (r for r in cache.rows("trade") if r["table_id"] == tid and r["round_no"] == s.round_no),
        key=lambda r: r["at"],
    )
    for q in s.quotes:
        side = s.book[q["suit"]]
        if q["side"] == "bid" and (side.bid is None or q["price"] > side.bid):
            side.bid, side.bidder = q["price"], q["name"]
        if q["side"] == "ask" and (side.ask is None or q["price"] < side.ask):
            side.ask, side.asker = q["price"], q["name"]
    return s


# ---------------------------------------------------------------- websocket

MAX_HEADERS = 16 * 1024
MAX_MESSAGE = 2 * 1024 * 1024


def _origin(url: str) -> str:
    u = urlsplit(url)
    if (not u.hostname or u.scheme not in ('ws', 'wss') or u.username is not None or
            u.password is not None or u.query or u.fragment or any(ord(c) <= 32 or ord(c) >= 127 for c in url)):
        raise ValueError('expected a WebSocket URL without credentials, query or fragment')
    if u.scheme == 'ws' and u.hostname not in ('127.0.0.1', 'localhost', '::1'):
        raise ValueError('remote arenas require wss://')
    host = f'[{u.hostname}]' if ':' in u.hostname else u.hostname
    port = u.port or (443 if u.scheme == 'wss' else 80)
    return f'{u.scheme}://{host}:{port}'


def _valid_token(token: str) -> bool:
    return isinstance(token, str) and bool(re.fullmatch(r'[A-Za-z0-9._~+/=-]{1,8192}', token))


class WebSocket:
    """The small part of RFC 6455 a bot needs: text frames, ping/pong, close."""

    def __init__(self, url: str, protocol: str, token: str | None = None, timeout: float = 15):
        origin = _origin(url)
        if protocol != PROTOCOL or (token is not None and not _valid_token(token)):
            raise ValueError('invalid protocol or bearer token')
        u = urlsplit(url)
        secure = u.scheme == "wss"
        port = u.port or (443 if secure else 80)
        raw = socket.create_connection((u.hostname, port), timeout=timeout)
        self.sock = raw
        self.lock = threading.Lock()
        try:
            if secure:
                self.sock = ssl.create_default_context().wrap_socket(raw, server_hostname=u.hostname)
            self._upgrade(u.path or '/', urlsplit(origin).netloc, protocol, token, timeout)
        except BaseException:
            self.sock.close()
            raise

    def _upgrade(self, path, authority, protocol, token, timeout):
        key = base64.b64encode(os.urandom(16)).decode()
        lines = [
            f"GET {path} HTTP/1.1",
            f"Host: {authority}",
            "Upgrade: websocket",
            "Connection: Upgrade",
            f"Sec-WebSocket-Key: {key}",
            "Sec-WebSocket-Version: 13",
            f"Sec-WebSocket-Protocol: {protocol}",
            "User-Agent: pokerarena-figgie",
        ]
        if token:
            lines.append(f"Authorization: Bearer {token}")
        self.sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
        head = b""
        deadline = time.monotonic() + timeout
        while b"\r\n\r\n" not in head:
            if len(head) >= MAX_HEADERS or time.monotonic() >= deadline:
                raise ConnectionError('WebSocket upgrade exceeded limits')
            self.sock.settimeout(max(0.001, deadline - time.monotonic()))
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("server closed during handshake")
            head += chunk
        head, self._buf = head.split(b"\r\n\r\n", 1)
        status, *fields = head.split(b'\r\n')
        headers = {}
        for line in fields:
            name, sep, value = line.partition(b':')
            if not sep:
                raise ConnectionError('malformed WebSocket upgrade')
            headers.setdefault(name.lower(), []).append(value.strip())
        accept = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest())
        if (len(head) > MAX_HEADERS or status.split()[:2] != [b'HTTP/1.1', b'101'] or
                headers.get(b'sec-websocket-accept') != [accept] or
                headers.get(b'sec-websocket-protocol') != [protocol.encode()] or
                b'sec-websocket-extensions' in headers or
                [v.lower() for v in headers.get(b'upgrade', [])] != [b'websocket'] or
                b'upgrade' not in [v.strip() for v in b','.join(headers.get(b'connection', [])).lower().split(b',')]):
            raise ConnectionError('server did not confirm the WebSocket upgrade and arena subprotocol')
        self.sock.settimeout(None)

    def _read(self, n: int) -> bytes:
        out, self._buf = bytearray(self._buf[:n]), self._buf[n:]
        while len(out) < n:
            chunk = self.sock.recv(min(n - len(out), 65536))
            if not chunk:
                raise ConnectionError("connection closed")
            out.extend(chunk)
        return bytes(out)

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        head = bytes([0x80 | opcode])
        n = len(payload)
        if n < 126:
            head += bytes([0x80 | n])
        elif n < 1 << 16:
            head += bytes([0x80 | 126]) + struct.pack("!H", n)
        else:
            head += bytes([0x80 | 127]) + struct.pack("!Q", n)
        mask = os.urandom(4)
        body = bytes(b ^ mask[i & 3] for i, b in enumerate(payload))
        with self.lock:
            self.sock.sendall(head + mask + body)

    def send(self, text: str) -> None:
        self._send_frame(0x1, text.encode())

    def recv(self) -> str:
        message = bytearray()
        fragments = 0
        while True:
            b0, b1 = self._read(2)
            opcode, fin = b0 & 0x0F, b0 & 0x80
            n = b1 & 0x7F
            if b0 & 0x70 or b1 & 0x80 or opcode not in (0, 1, 8, 9, 10):
                raise ConnectionError('invalid server frame')
            if opcode >= 8 and (not fin or n > 125):
                raise ConnectionError('invalid control frame')
            if n == 126:
                n = struct.unpack("!H", self._read(2))[0]
                if n < 126:
                    raise ConnectionError('invalid frame length')
            elif n == 127:
                n = struct.unpack("!Q", self._read(8))[0]
                if n < 65536:
                    raise ConnectionError('invalid frame length')
            if opcode < 8:
                if (opcode == 0) != bool(fragments) or n + len(message) > MAX_MESSAGE or fragments >= 1024:
                    raise ConnectionError('invalid or oversized WebSocket message')
                fragments += 1
            payload = self._read(n)
            if opcode == 0x8:
                raise ConnectionError('server closed the WebSocket')
            if opcode == 0x9:
                self._send_frame(0xA, payload)
                continue
            if opcode == 0xA:
                continue
            message.extend(payload)
            if fin:
                return message.decode()

    def close(self) -> None:
        try:
            self._send_frame(0x8, struct.pack("!H", 1000))
        except OSError:
            pass
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.sock.close()


# ---------------------------------------------------------------- bot

class FiggieBot:
    """Subclass this. Override ``on_update`` (and optionally the other hooks)."""

    name = "my_figgie_bot"
    tick_seconds = 0.25

    # hooks -------------------------------------------------------------
    def on_round_start(self, s: State) -> None:
        """A new deal: $300 after the ante at four seats, or $310 at five."""

    def on_update(self, s: State) -> None:
        """Called every ``tick_seconds`` (0.25 s) during trading with the latest state."""

    def on_round_end(self, s: State) -> None:
        """The bell rang. ``s.goal`` is the goal suit."""

    def on_error(self, reducer: str, message: str) -> None:
        print(f"[{self.name}] {reducer} refused: {message}", file=sys.stderr)

    # actions -----------------------------------------------------------
    def bid(self, suit: str, price: int) -> None:
        """Offer to buy one card of ``suit`` for ``price``. Replaces your old bid."""
        self._call("bid", [suit, int(price)])

    def ask(self, suit: str, price: int) -> None:
        """Offer to sell one card of ``suit`` for ``price``. Replaces your old offer."""
        self._call("ask", [suit, int(price)])

    def buy(self, suit: str) -> None:
        """Take the best offer in ``suit``."""
        self._call("buy", [suit])

    def sell(self, suit: str) -> None:
        """Hit the best bid in ``suit``."""
        self._call("sell", [suit])

    def cancel(self, suit: str = "", side: str = "") -> None:
        """Pull your quotes. No arguments pulls everything."""
        self._call("cancel", [suit, side])

    # plumbing ------------------------------------------------------------
    _ws: WebSocket | None = None
    _requests: dict | None = None
    _next_id = 1

    def _call(self, reducer: str, args: list) -> None:
        if not self._ws:
            raise RuntimeError("not connected")
        if len(self._requests) >= 256:
            raise RuntimeError('too many pending reducer calls')
        rid = self._next_id
        self._next_id += 1
        self._requests[rid] = reducer
        self._ws.send(json.dumps({"CallReducer": {
            "reducer": reducer, "args": json.dumps(args), "request_id": rid, "flags": 0,
        }}))


def token_path(name: str, host: str = HOST, database: str = DATABASE) -> Path:
    if urlsplit(host).path not in ('', '/') or not re.fullmatch(r'[a-z0-9-]{1,128}', database):
        raise ValueError('invalid arena host or database')
    scope = hashlib.sha256(f'{_origin(host)}/{database}'.encode()).hexdigest()[:24]
    return Path(os.environ.get("POKERARENA_HOME", Path.home() / ".pokerarena")) / f"figgie-{scope}-{clean_name(name)}.token"


def save_token(path: Path, token: str) -> None:
    if not _valid_token(token):
        raise ValueError('invalid arena identity token')
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False, mode='w') as f:
        try:
            f.write(token)
            f.close()  # mkstemp creates the new inode with 0600, even on replacement
            os.replace(f.name, path)
        finally:
            Path(f.name).unlink(missing_ok=True)


def clean_name(name: str) -> str:
    """The arena keeps lowercase letters, digits and _ (24 at most)."""
    return "".join(ch for ch in str(name).lower() if ch.isascii() and (ch.isalnum() or ch == "_"))[:24]


def run(bot: FiggieBot, host: str = HOST, database: str = DATABASE, rounds: int | None = None,
        verbose: bool = True) -> None:
    """Connect, register, and trade until interrupted (reconnects on drops)."""
    bot.name = clean_name(bot.name)
    if not bot.name:
        raise SystemExit("give the bot a name made of letters, digits and _")
    host = host.removesuffix('/')
    tok_file = token_path(bot.name, host, database)
    legacy = tok_file.parent / f'figgie-{bot.name}.token'
    if not tok_file.exists() and legacy.exists():
        raise SystemExit(f'Existing identity is not tied to a server. If it belongs to {host}/{database}, '
                         f'chmod 600 and move {legacy} to {tok_file}; otherwise use a new bot name.')
    backoff = 1.0
    played = 0
    while rounds is None or played < rounds:
        token = tok_file.read_text().strip() if tok_file.exists() else None
        try:
            ws = WebSocket(f"{host}/v1/database/{database}/subscribe", PROTOCOL, token)
        except OSError as err:
            print(f"connect failed: {err}; retrying in {backoff:.0f}s", file=sys.stderr)
            time.sleep(backoff)
            backoff = min(backoff * 2, 30)
            continue
        backoff = 1.0
        bot._ws, bot._requests = ws, {}
        inbox: queue.Queue = queue.Queue(maxsize=16)
        stopped = threading.Event()

        def reader(ws=ws, inbox=inbox, stopped=stopped):
            def put(msg):
                while not stopped.is_set():
                    try:
                        inbox.put(msg, timeout=0.25)
                        return
                    except queue.Full:
                        pass
            try:
                while not stopped.is_set():
                    put(json.loads(ws.recv()))
            except (OSError, ValueError, RecursionError) as err:
                put({"_closed": str(err)})

        threading.Thread(target=reader, daemon=True).start()
        cache = Cache()
        last_round = None
        last_phase = None
        next_tick = 0.0
        try:
            closed = False
            while not closed and (rounds is None or played < rounds):
                # Drain everything that arrived, then act at most once per tick.
                batch = []
                try:
                    batch.append(inbox.get(timeout=max(0.01, next_tick - time.time())))
                    while len(batch) < 16:
                        batch.append(inbox.get_nowait())
                except queue.Empty:
                    pass
                for msg in batch:
                    if "_closed" in msg:
                        print(f"disconnected: {msg['_closed']}", file=sys.stderr)
                        closed = True
                    elif "IdentityToken" in msg:
                        save_token(tok_file, msg["IdentityToken"]["token"])
                        ws.send(json.dumps({"Subscribe": {"query_strings": SUBSCRIPTIONS, "request_id": 1}}))
                        bot._call("register", [bot.name])
                        if verbose:
                            print(f"connected as {bot.name}; you sit down at the next deal", flush=True)
                    elif "InitialSubscription" in msg:
                        cache.apply(msg["InitialSubscription"]["database_update"]["tables"])
                    elif "TransactionUpdateLight" in msg:
                        cache.apply(msg["TransactionUpdateLight"]["update"]["tables"])
                    elif "TransactionUpdate" in msg:
                        tu = msg["TransactionUpdate"]
                        status = tu.get("status", {})
                        if "Committed" in status:
                            cache.apply(status["Committed"].get("tables", []))
                        rid = (tu.get("reducer_call") or {}).get("request_id")
                        reducer = bot._requests.pop(rid, None)
                        if "Failed" in status and reducer:
                            bot.on_error(reducer, status["Failed"])
                if closed or time.time() < next_tick:
                    continue
                next_tick = time.time() + bot.tick_seconds
                s = build_state(cache, bot.name)
                if s.seated and (s.round_no, s.phase) != (last_round, last_phase):
                    if s.phase == "trading" and s.round_no != last_round:
                        if verbose:
                            print(f"round {s.round_no}: table {s.table_id + 1}, hand {s.hand}", flush=True)
                        bot.on_round_start(s)
                    if s.phase == "reveal" and last_phase == "trading":
                        played += 1
                        if verbose:
                            print(f"round {s.round_no} over: goal {s.goal}, cash ${s.cash}, hand {s.hand}", flush=True)
                        bot.on_round_end(s)
                    last_round, last_phase = s.round_no, s.phase
                if s.seated and s.phase == "trading" and s.time_left > 0:
                    try:
                        bot.on_update(s)
                    except Exception as err:  # a bug in the bot should not drop the connection
                        print(f"on_update raised {err!r}", file=sys.stderr)
        finally:
            stopped.set()
            bot._ws = None
            ws.close()
        time.sleep(1)


def load_bot(path: str) -> FiggieBot:
    spec = importlib.util.spec_from_file_location(Path(path).stem, path)
    if not spec or not spec.loader:
        raise SystemExit(f"cannot import {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    found = [obj for obj in vars(mod).values()
             if inspect.isclass(obj) and issubclass(obj, FiggieBot) and obj is not FiggieBot]
    if not found:
        raise SystemExit(f"no FiggieBot subclass in {path}")
    return found[0]()


STARTER = '''from pokerarena.figgie import FiggieBot


class {cls}(FiggieBot):
    name = "{name}"

    def on_update(self, s):
        odds = s.goal_odds()                     # P(goal suit) from the hand you were dealt
        goal = max(odds, key=odds.get)
        value = {{suit: p * 18 for suit, p in odds.items()}}  # $10 a card + a share of the bonus

        # Buy the likely goal suit when it is cheap, sell the rest when someone pays up.
        if s.book[goal].ask and s.book[goal].ask < value[goal] + 3:
            self.buy(goal)
            return
        for suit, n in s.hand.items():
            if suit != goal and n and s.book[suit].bid and s.book[suit].bid > value[suit] + 1:
                self.sell(suit)
                return
        if not s.my_quotes:
            self.bid(goal, max(1, int(value[goal])))
'''


def starter_source(name: str) -> str:
    safe = "".join(ch if ch.isalnum() or ch == "_" else "_" for ch in name.strip().lower()).strip("_") or "my_figgie_bot"
    if safe[0].isdigit():
        safe = "bot_" + safe
    safe = safe[:24]
    cls = "".join(part[:1].upper() + part[1:] for part in safe.split("_") if part) or "MyFiggieBot"
    return STARTER.format(name=safe, cls=cls)


__all__ = ["FiggieBot", "State", "Side", "Cache", "WebSocket", "build_state", "goal_odds", "run",
           "load_bot", "starter_source", "clean_name", "SUITS"]
