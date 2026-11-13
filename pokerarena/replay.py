"""Human-readable hand replay."""

from __future__ import annotations

from .models import STREETS
from .storage import Store


def format_hand(store: Store, hand_id: int) -> str:
    d = store.hand_history(hand_id)
    h, players, acts = d["hand"], d["players"], d["actions"]
    bb = h["big_blind"]
    board = h["board"].split()
    lines = [f"Hand #{h['hand_id']} (match {h['match_id']}, hand {h['hand_no']}) "
             f"blinds {h['small_blind']}/{bb}, button seat {h['button']}"]
    for p in players:
        lines.append(f"  seat {p['seat']} {p['position']:<5} {p['bot_id']:<16} "
                     f"[{p['hole']}] stack {p['start_stack']}")
    street = -1
    for a in acts:
        if a["street"] != street:
            street = a["street"]
            shown = {0: [], 1: board[:3], 2: board[:4], 3: board[:5]}[street]
            pot = f" (pot {a['pot_before']})" if street > 0 else ""
            lines.append(f"--- {STREETS[street].upper()} {' '.join(shown)}{pot}")
        who = f"seat {a['seat']} ({a['bot_id']})"
        verb = {"sb": "posts small blind", "bb": "posts big blind", "fold": "folds", "check": "checks",
                "call": "calls", "bet": "bets", "raise": "raises to"}[a["kind"]]
        amt = ""
        if a["kind"] in ("sb", "bb", "call"):
            amt = f" {a['amount']}"
        elif a["kind"] in ("bet", "raise"):
            amt = f" {a['to_total']}"
        flag = " (all-in)" if a["all_in"] else ""
        note = " [corrected]" if a["corrected"] == 1 else " [CRASHED]" if a["corrected"] == 2 else ""
        lines.append(f"  {who} {verb}{amt}{flag}{note}")
    lines.append(f"--- RESULT board: {' '.join(board)}  pot {h['pot_total']}")
    for p in players:
        extra = ""
        if p["showdown"]:
            extra = " (showdown)"
        lines.append(f"  seat {p['seat']} {p['bot_id']:<16} net {p['net']:+d}{extra}")
    return "\n".join(lines)
