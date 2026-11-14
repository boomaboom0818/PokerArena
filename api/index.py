"""Vercel file-based Python function. Every /api/* rewrite lands here.

The class is named ``handler`` because that is what the Python runtime looks
for. It answers with the same JSON the local ``python -m pokerarena serve``
process serves, reading data/sample.db (or $POKERARENA_DB).
"""

from __future__ import annotations

import json
import os
import shutil
import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from pokerarena.bots import BUILTIN  # noqa: E402
from pokerarena.http_api import (  # noqa: E402
    CONNECT_GUIDE,
    bot_detail,
    hand_payload,
    leaderboard_payload,
    list_hands,
    list_matches,
    broadcast_frame,
)
from pokerarena.starter import starter_source  # noqa: E402
from pokerarena.storage import Store  # noqa: E402

_STORE = None


def store() -> Store:
    global _STORE
    if _STORE is None:
        src = Path(os.environ.get("POKERARENA_DB", str(ROOT / "data" / "sample.db")))
        # Vercel serves the deployment read-only. SQLite needs a writable file
        # because opening it sets WAL mode and refreshes the view.
        if os.access(src.parent, os.W_OK):
            path = src
        else:
            path = Path("/tmp/pokerarena.db")
            shutil.copy(src, path)
        _STORE = Store(str(path))
    return _STORE


def dispatch(method: str, path: str, qs: dict, body: dict):
    path = path.split("?", 1)[0]
    if "/api/" in path:
        path = path[path.index("/api/"):]
    elif path.startswith("/api"):
        pass
    else:
        path = "/api" + (path if path.startswith("/") else "/" + path)
    path = path.rstrip("/") or "/api"
    parts = [p for p in path.split("/") if p]
    db = store()

    if path in ("/api", "/api/health"):
        return 200, {"ok": True, "service": "pokerarena"}
    if path == "/api/leaderboard":
        return 200, leaderboard_payload(db, int(qs.get("min_hands", ["0"])[0]))
    if path == "/api/bots":
        rows = []
        for r in db.db.execute(
            "SELECT bot_id, description, elo, matches, hands FROM bots ORDER BY elo DESC"):
            rows.append({
                "bot": r["bot_id"], "description": r["description"], "elo": r["elo"],
                "matches": r["matches"], "hands": r["hands"],
            })
        known = {r["bot"] for r in rows}
        for name, cls in BUILTIN.items():
            if name not in known:
                rows.append({
                    "bot": name, "description": cls.description, "elo": None,
                    "matches": 0, "hands": 0, "builtin": True,
                })
        return 200, {"bots": rows, "builtins": sorted(BUILTIN)}
    if len(parts) == 3 and parts[:2] == ["api", "bots"]:
        detail = bot_detail(db, parts[2])
        return (200, detail) if detail else (404, {"error": "unknown bot"})
    if path == "/api/matches":
        return 200, {"matches": list_matches(db, min(int(qs.get("limit", ["40"])[0]), 200))}
    if path == "/api/hands":
        match_id = int(qs["match_id"][0]) if "match_id" in qs else None
        return 200, {"hands": list_hands(
            db,
            limit=min(int(qs.get("limit", ["30"])[0]), 100),
            bot=(qs.get("bot") or [None])[0],
            match_id=match_id,
        )}
    if len(parts) == 3 and parts[:2] == ["api", "hands"]:
        payload = hand_payload(db, int(parts[2]))
        return (200, payload) if payload else (404, {"error": "unknown hand"})
    if path == "/api/connect":
        return 200, CONNECT_GUIDE
    if path == "/api/connect/starter":
        name = (qs.get("name") or ["my_bot"])[0]
        return 200, {"source": starter_source(name), "filename": name}
    if path == "/api/live":
        return 200, broadcast_frame(table=int((qs.get("table") or ["0"])[0]), store=db)
    return 404, {"error": "not found", "path": path}


class handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return

    def _qs(self):
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        # The rewrite sends the original path as ?path= so one function covers /api/*.
        hinted = (qs.pop("path", [""]) or [""])[0]
        route = self.path
        if hinted:
            route = "/api/" + hinted.lstrip("/")
        return route, qs

    def _read_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try:
            data = json.loads(raw.decode() or "{}")
        except json.JSONDecodeError:
            return {}
        return data if isinstance(data, dict) else {}

    def _finish(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._finish(204, {})

    def do_GET(self):
        route, qs = self._qs()
        try:
            code, payload = dispatch("GET", route, qs, {})
        except ValueError as exc:
            code, payload = 400, {"error": str(exc)}
        except Exception as exc:
            code, payload = 500, {"error": str(exc)}
        self._finish(code, payload)

    def do_POST(self):
        route, qs = self._qs()
        try:
            code, payload = dispatch("POST", route, qs, self._read_json())
        except ValueError as exc:
            code, payload = 400, {"error": str(exc)}
        except Exception as exc:
            code, payload = 500, {"error": str(exc)}
        self._finish(code, payload)
