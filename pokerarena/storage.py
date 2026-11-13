"""SQLite storage: every match, hand, player-hand and individual decision is kept.

Tables (see ``SCHEMA`` below)::

    bots          current Elo + totals per bot
    rating_history  one row per (bot, match): Elo before/after
    runs          one row per ``arena run`` invocation (config as JSON)
    matches       one table session (N bots x many hands)
    match_players final result per bot in a match
    hands         one row per hand: board, pot, button
    hand_players  one row per (hand, seat): hole cards, net result, VPIP/PFR flags
    actions       one row per action (blinds, folds, calls, bets...) with the game state
    decisions     VIEW joining the above into ready-to-use training rows
"""

from __future__ import annotations

import math
import sqlite3
import time
from pathlib import Path

from .cards import cards_str
from .evaluator import category
from .models import MatchResult

SCHEMA = """
CREATE TABLE IF NOT EXISTS bots (
    bot_id TEXT PRIMARY KEY,
    spec_json TEXT,
    description TEXT,
    elo REAL NOT NULL,
    matches INTEGER NOT NULL DEFAULT 0,
    hands INTEGER NOT NULL DEFAULT 0,
    first_seen TEXT,
    last_played TEXT
);
CREATE TABLE IF NOT EXISTS runs (
    run_id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT,
    config_json TEXT
);
CREATE TABLE IF NOT EXISTS matches (
    match_id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER REFERENCES runs(run_id),
    round_no INTEGER,
    table_no INTEGER,
    seed INTEGER,
    n_players INTEGER,
    n_hands INTEGER,
    small_blind INTEGER,
    big_blind INTEGER,
    starting_stack INTEGER,
    duration_s REAL,
    played_at TEXT
);
CREATE TABLE IF NOT EXISTS match_players (
    match_id INTEGER REFERENCES matches(match_id),
    seat INTEGER,
    bot_id TEXT REFERENCES bots(bot_id),
    net_chips INTEGER,
    bb_per_100 REAL,
    rank INTEGER,            -- 1 = most chips won
    elo_before REAL,
    elo_after REAL,
    errors INTEGER,          -- crashes / invalid actions in this match
    PRIMARY KEY (match_id, seat)
);
CREATE TABLE IF NOT EXISTS rating_history (
    bot_id TEXT REFERENCES bots(bot_id),
    match_id INTEGER REFERENCES matches(match_id),
    elo_before REAL,
    elo_after REAL,
    PRIMARY KEY (bot_id, match_id)
);
CREATE TABLE IF NOT EXISTS hands (
    hand_id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id INTEGER REFERENCES matches(match_id),
    hand_no INTEGER,
    button INTEGER,
    board TEXT,              -- e.g. 'As Kd 7c 2s 9h' (only the cards that were dealt)
    n_players INTEGER,
    pot_total INTEGER,
    showdown INTEGER
);
CREATE TABLE IF NOT EXISTS hand_players (
    hand_id INTEGER REFERENCES hands(hand_id),
    seat INTEGER,
    bot_id TEXT,
    position TEXT,           -- BTN SB BB UTG MP HJ CO ...
    pos_idx INTEGER,         -- 0 = button, 1 = SB, 2 = BB, then clockwise
    hole TEXT,               -- e.g. 'Ah Kd' (known for ALL players: the arena sees everything)
    start_stack INTEGER,
    final_stack INTEGER,
    net INTEGER,             -- chips won(+)/lost(-) this hand
    vpip INTEGER,
    pfr INTEGER,
    saw_flop INTEGER,
    showdown INTEGER,
    won_showdown INTEGER,
    folded_street INTEGER,   -- -1 never folded, else 0..3
    hand_category INTEGER,   -- 0 high card .. 8 straight flush at showdown, else -1
    PRIMARY KEY (hand_id, seat)
);
CREATE TABLE IF NOT EXISTS actions (
    action_id INTEGER PRIMARY KEY AUTOINCREMENT,
    hand_id INTEGER REFERENCES hands(hand_id),
    seq INTEGER,             -- order inside the hand, blinds first
    street INTEGER,          -- 0 preflop 1 flop 2 turn 3 river
    seat INTEGER,
    bot_id TEXT,
    kind TEXT,               -- sb bb fold check call bet raise
    amount INTEGER,          -- chips added by this action
    to_total INTEGER,        -- seat's total bet on this street after the action ("raise to")
    pot_before INTEGER,
    to_call INTEGER,
    stack_before INTEGER,
    min_raise_to INTEGER,
    max_raise_to INTEGER,
    num_active INTEGER,      -- players still in hand before acting
    all_in INTEGER,
    corrected INTEGER,       -- 0 fine, 1 illegal action was corrected, 2 bot crashed
    think_ms REAL
);
CREATE TABLE IF NOT EXISTS errors (
    match_id INTEGER REFERENCES matches(match_id),
    seat INTEGER,
    bot_id TEXT,
    message TEXT             -- traceback of a bot crash
);
CREATE INDEX IF NOT EXISTS idx_actions_hand ON actions(hand_id, seq);
CREATE INDEX IF NOT EXISTS idx_actions_bot ON actions(bot_id);
CREATE INDEX IF NOT EXISTS idx_hands_match ON hands(match_id);
CREATE INDEX IF NOT EXISTS idx_hp_bot ON hand_players(bot_id);
CREATE INDEX IF NOT EXISTS idx_mp_bot ON match_players(bot_id);

DROP VIEW IF EXISTS decisions;
CREATE VIEW decisions AS
SELECT
    a.action_id, a.hand_id, h.match_id, m.run_id, h.hand_no, a.seq,
    a.bot_id, a.seat, hp.position, hp.pos_idx, h.n_players,
    a.street,
    hp.hole,
    CASE a.street WHEN 0 THEN '' WHEN 1 THEN substr(h.board, 1, 8)
                  WHEN 2 THEN substr(h.board, 1, 11) ELSE substr(h.board, 1, 14) END AS board,
    a.kind AS action, a.amount, a.to_total,
    a.pot_before, a.to_call, a.stack_before, a.min_raise_to, a.max_raise_to,
    a.num_active, a.all_in, a.corrected,
    m.big_blind,
    hp.net AS hand_net,
    hp.net * 1.0 / m.big_blind AS hand_net_bb
FROM actions a
JOIN hands h ON h.hand_id = a.hand_id
JOIN matches m ON m.match_id = h.match_id
JOIN hand_players hp ON hp.hand_id = a.hand_id AND hp.seat = a.seat
WHERE a.kind IN ('fold', 'check', 'call', 'bet', 'raise');
"""


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


class Store:
    def __init__(self, path):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.executescript(SCHEMA)
        self.db.commit()

    def close(self):
        self.db.close()

    # ------------------------------------------------------------------- bots/runs
    def register_bot(self, bot_id: str, spec_json: str, description: str, initial_elo: float):
        self.db.execute(
            "INSERT OR IGNORE INTO bots(bot_id, spec_json, description, elo, first_seen) VALUES (?,?,?,?,?)",
            (bot_id, spec_json, description, initial_elo, _now()))
        self.db.execute("UPDATE bots SET spec_json=?, description=? WHERE bot_id=?",
                        (spec_json, description, bot_id))
        self.db.commit()

    def ratings(self) -> dict:
        return {r["bot_id"]: r["elo"] for r in self.db.execute("SELECT bot_id, elo FROM bots")}

    def match_counts(self) -> dict:
        return {r["bot_id"]: r["matches"] for r in self.db.execute("SELECT bot_id, matches FROM bots")}

    def start_run(self, config_json: str) -> int:
        cur = self.db.execute("INSERT INTO runs(started_at, config_json) VALUES (?,?)", (_now(), config_json))
        self.db.commit()
        return cur.lastrowid

    # ----------------------------------------------------------------------- writes
    def save_match(self, run_id, round_no, table_no, result: MatchResult, elo_before: dict,
                   elo_after: dict) -> int:
        cfg = result.config
        db = self.db
        n_hands = len(result.hands)
        bb = cfg["big_blind"]
        nets = result.net_by_seat
        order = sorted(range(len(nets)), key=lambda s: -nets[s])
        rank_of_seat = {s: i + 1 for i, s in enumerate(order)}
        with db:
            cur = db.execute(
                "INSERT INTO matches(run_id, round_no, table_no, seed, n_players, n_hands, small_blind,"
                " big_blind, starting_stack, duration_s, played_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (run_id, round_no, table_no, result.seed, cfg["n_players"], n_hands, cfg["small_blind"],
                 bb, cfg["starting_stack"], result.duration_s, _now()))
            match_id = cur.lastrowid
            for seat, name in enumerate(result.names):
                db.execute(
                    "INSERT INTO match_players VALUES (?,?,?,?,?,?,?,?,?)",
                    (match_id, seat, name, nets[seat], nets[seat] / bb / max(n_hands, 1) * 100,
                     rank_of_seat[seat], elo_before[name], elo_after[name], result.error_counts[seat]))
                db.execute("INSERT INTO rating_history VALUES (?,?,?,?)",
                           (name, match_id, elo_before[name], elo_after[name]))
                db.execute(
                    "UPDATE bots SET elo=?, matches=matches+1, hands=hands+?, last_played=? WHERE bot_id=?",
                    (elo_after[name], n_hands, _now(), name))
            for seat, msg in result.errors:
                db.execute("INSERT INTO errors VALUES (?,?,?,?)", (match_id, seat, result.names[seat], msg))

            names = result.names
            for h in result.hands:
                hid = db.execute(
                    "INSERT INTO hands(match_id, hand_no, button, board, n_players, pot_total, showdown)"
                    " VALUES (?,?,?,?,?,?,?)",
                    (match_id, h.hand_no, h.button, cards_str(h.board), len(names), h.pot_total,
                     int(h.showdown))).lastrowid
                db.executemany(
                    "INSERT INTO hand_players VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    [(hid, s.seat, names[s.seat], s.position, s.pos_idx, cards_str(s.hole), s.start_stack,
                      s.final_stack, s.net, s.vpip, s.pfr, s.saw_flop, s.showdown, s.won_showdown,
                      s.folded_street, category(s.hand_score) if s.hand_score >= 0 else -1)
                     for s in h.seats])
                db.executemany(
                    "INSERT INTO actions(hand_id, seq, street, seat, bot_id, kind, amount, to_total,"
                    " pot_before, to_call, stack_before, min_raise_to, max_raise_to, num_active, all_in,"
                    " corrected, think_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    [(hid, e.seq, e.street, e.seat, names[e.seat], e.kind, e.amount, e.to_total,
                      e.pot_before, e.to_call, e.stack_before, e.min_raise_to, e.max_raise_to,
                      e.num_active, e.all_in, e.corrected, round(e.think_ms, 3)) for e in h.events])
        return match_id

    # ------------------------------------------------------------------------ reads
    def leaderboard(self, min_hands: int = 0) -> list[dict]:
        stats = {}
        for r in self.db.execute(
            """SELECT hp.bot_id, COUNT(*) n, SUM(hp.net * 1.0 / m.big_blind) s,
                      SUM(hp.net * 1.0 * hp.net / (m.big_blind * m.big_blind)) ss,
                      AVG(hp.vpip) vpip, AVG(hp.pfr) pfr, AVG(hp.saw_flop) flop, AVG(hp.showdown) sd
               FROM hand_players hp JOIN hands h ON h.hand_id = hp.hand_id
               JOIN matches m ON m.match_id = h.match_id GROUP BY hp.bot_id"""):
            n = r["n"]
            mean = r["s"] / n
            var = max(r["ss"] / n - mean * mean, 0.0)
            stats[r["bot_id"]] = dict(
                bb100=mean * 100, stderr=math.sqrt(var / n) * 100 if n else 0.0,
                vpip=r["vpip"] * 100, pfr=r["pfr"] * 100, saw_flop=r["flop"] * 100, showdown=r["sd"] * 100)
        agg = {r["bot_id"]: r for r in self.db.execute(
            """SELECT bot_id, SUM(kind IN ('bet','raise')) ag, SUM(kind = 'call') ca
               FROM actions GROUP BY bot_id""")}
        wins = {r["bot_id"]: r["w"] for r in self.db.execute(
            "SELECT bot_id, SUM(rank = 1) w FROM match_players GROUP BY bot_id")}
        out = []
        for b in self.db.execute("SELECT * FROM bots ORDER BY elo DESC"):
            if b["hands"] < min_hands:
                continue
            row = dict(bot=b["bot_id"], elo=b["elo"], matches=b["matches"], hands=b["hands"],
                       match_wins=wins.get(b["bot_id"], 0) or 0)
            row.update(stats.get(b["bot_id"], dict(bb100=0.0, stderr=0.0, vpip=0.0, pfr=0.0,
                                                   saw_flop=0.0, showdown=0.0)))
            a = agg.get(b["bot_id"])
            row["af"] = (a["ag"] / a["ca"]) if a and a["ca"] else 0.0
            out.append(row)
        return out

    def hand_history(self, hand_id: int) -> dict:
        h = self.db.execute(
            "SELECT h.*, m.big_blind, m.small_blind, m.seed FROM hands h JOIN matches m USING(match_id)"
            " WHERE hand_id=?", (hand_id,)).fetchone()
        if not h:
            raise KeyError(f"no hand {hand_id}")
        players = [dict(r) for r in self.db.execute(
            "SELECT * FROM hand_players WHERE hand_id=? ORDER BY seat", (hand_id,))]
        acts = [dict(r) for r in self.db.execute(
            "SELECT * FROM actions WHERE hand_id=? ORDER BY seq", (hand_id,))]
        return dict(hand=dict(h), players=players, actions=acts)
