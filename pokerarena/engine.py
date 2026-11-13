"""No-limit Texas Hold'em engine: one table, one match (= many hands, stacks reset each hand)."""

from __future__ import annotations

import random
import time
import traceback

from .evaluator import evaluate
from .models import (
    Action,
    ActionEvent,
    HandResult,
    HandSummary,
    MatchInfo,
    MatchResult,
    Observation,
    PlayerView,
    SeatResult,
    position_names,
)


def _coerce(raw) -> tuple[str, int] | None:
    if isinstance(raw, Action):
        return raw.kind, raw.amount
    if isinstance(raw, str):
        return raw.lower(), 0
    if isinstance(raw, (tuple, list)) and raw:
        try:
            return str(raw[0]).lower(), int(raw[1]) if len(raw) > 1 else 0
        except (TypeError, ValueError):
            return None
    return None


class Table:
    """Plays hands between ``len(bots)`` (2-9) bots. Deterministic for a given ``seed``."""

    def __init__(self, bots, names, *, small_blind=50, big_blind=100, starting_stack=10_000, seed=0):
        assert 2 <= len(bots) <= 9, "table size must be 2..9"
        assert len(bots) == len(names)
        self.bots = list(bots)
        self.names = list(names)
        self.n = len(bots)
        self.sb = small_blind
        self.bb = big_blind
        self.stack0 = starting_stack
        self.seed = seed
        self.rng = random.Random(seed)
        self.pos_names = position_names(self.n)
        self.errors: list[tuple[int, str]] = []
        self.error_counts = [0] * self.n
        for seat, bot in enumerate(self.bots):
            bot.seat = seat
            bot.rng = random.Random(f"{seed}/{seat}")

    # ------------------------------------------------------------------ match loop
    def run(self, n_hands: int) -> MatchResult:
        t0 = time.perf_counter()
        for seat, bot in enumerate(self.bots):
            info = MatchInfo(seat, tuple(self.names), self.n, self.sb, self.bb, self.stack0, n_hands)
            self._safe(seat, bot.on_match_start, info)
        result = MatchResult(
            seed=self.seed,
            names=list(self.names),
            config=dict(n_players=self.n, small_blind=self.sb, big_blind=self.bb,
                        starting_stack=self.stack0, n_hands=n_hands),
        )
        for hand_no in range(n_hands):
            result.hands.append(self.play_hand(hand_no))
        result.errors = self.errors[:20]
        result.error_counts = list(self.error_counts)
        result.duration_s = time.perf_counter() - t0
        return result

    def _safe(self, seat, fn, *args):
        try:
            return fn(*args)
        except Exception:
            self.error_counts[seat] += 1
            if len(self.errors) < 50:
                self.errors.append((seat, traceback.format_exc(limit=3)))
            return None

    # -------------------------------------------------------------------- one hand
    def play_hand(self, hand_no: int) -> HandResult:
        n, bb, sb, rng = self.n, self.bb, self.sb, self.rng
        button = hand_no % n
        deck = list(range(52))
        rng.shuffle(deck)
        hole = [(deck[2 * i], deck[2 * i + 1]) for i in range(n)]
        full_board = deck[2 * n: 2 * n + 5]
        board: list[int] = []

        start = list(self.stack0) if isinstance(self.stack0, (list, tuple)) else [self.stack0] * n
        stack = list(start)
        bet = [0] * n
        contrib = [0] * n
        folded = [False] * n
        allin = [False] * n
        events: list[ActionEvent] = []
        pos_idx = [(s - button) % n for s in range(n)]
        pos_name = [self.pos_names[p] for p in pos_idx]

        def log(street, seat, kind, amount, *, pot_before, to_call=0, stack_before=0,
                min_to=0, max_to=0, active=0, corrected=0, think=0.0):
            events.append(ActionEvent(
                seq=len(events), street=street, seat=seat, kind=kind, amount=amount,
                to_total=bet[seat], pot_before=pot_before, to_call=to_call,
                stack_before=stack_before, min_raise_to=min_to, max_raise_to=max_to,
                num_active=active, all_in=int(allin[seat]), corrected=corrected, think_ms=think))

        def post_blind(seat, amount, kind):
            pot_before = sum(contrib)
            before = stack[seat]
            paid = min(amount, before)
            stack[seat] -= paid
            bet[seat] += paid
            contrib[seat] += paid
            if stack[seat] == 0:
                allin[seat] = True
            log(0, seat, kind, paid, pot_before=pot_before, stack_before=before, active=n)

        if n == 2:
            sb_seat, bb_seat = button, (button + 1) % 2
        else:
            sb_seat, bb_seat = (button + 1) % n, (button + 2) % n
        post_blind(sb_seat, sb, "sb")
        post_blind(bb_seat, bb, "bb")

        def observe(seat, street, to_call, can_raise, min_to, max_to):
            views = tuple(PlayerView(s, self.names[s], stack[s], bet[s], folded[s], allin[s], pos_name[s])
                          for s in range(n))
            return Observation(
                hand_no=hand_no, seat=seat, n_players=n, button=button, position=pos_name[seat],
                pos_idx=pos_idx[seat], street=street, hole=hole[seat], board=tuple(board),
                pot=sum(contrib), to_call=to_call, stack=stack[seat], bet=bet[seat],
                can_raise=can_raise, min_raise_to=min_to, max_raise_to=max_to,
                small_blind=sb, big_blind=bb, players=views, history=tuple(events))

        def betting_round(street: int):
            current_bet = max(bet)
            last_raise = bb
            acted: set[int] = set()
            cursor = ((bb_seat + 1) % n if n > 2 else button) if street == 0 else (button + 1) % n
            while True:
                if sum(1 for s in range(n) if not folded[s]) == 1:
                    return
                pick = None
                for i in range(n):
                    s = (cursor + i) % n
                    if folded[s] or allin[s]:
                        continue
                    if s not in acted or bet[s] < current_bet:
                        pick = s
                        break
                if pick is None:
                    return
                others_can_act = any(not folded[o] and not allin[o] for o in range(n) if o != pick)
                to_call = current_bet - bet[pick]
                if not others_can_act and to_call == 0:
                    return
                max_to = bet[pick] + stack[pick]
                min_to = min(current_bet + last_raise, max_to)
                can_raise = pick not in acted and stack[pick] > to_call and others_can_act
                pot_before = sum(contrib)
                active = sum(1 for s in range(n) if not folded[s])
                stack_before = stack[pick]

                corrected = 0
                t0 = time.perf_counter()
                try:
                    raw = self.bots[pick].act(observe(pick, street, to_call, can_raise, min_to, max_to))
                except Exception:
                    raw = None
                    corrected = 2
                    self.error_counts[pick] += 1
                    if len(self.errors) < 50:
                        self.errors.append((pick, traceback.format_exc(limit=3)))
                think = (time.perf_counter() - t0) * 1000.0
                parsed = _coerce(raw)
                if parsed is None:
                    corrected = corrected or 1
                    parsed = ("check" if to_call == 0 else "fold", 0)
                kind, amount = parsed

                if kind == "raise" and not can_raise:
                    kind, corrected = ("call", corrected or 1)
                if kind == "call" and to_call == 0:
                    kind = "check"
                elif kind == "check" and to_call > 0:
                    kind, corrected = "fold", corrected or 1
                elif kind not in ("fold", "check", "call", "raise"):
                    kind, corrected = ("check" if to_call == 0 else "fold"), corrected or 1

                if kind == "raise":
                    clamped = max(min_to, min(max_to, amount))
                    if clamped != amount:
                        corrected = corrected or 1
                    chips = clamped - bet[pick]
                    label = "bet" if current_bet == 0 else "raise"
                    if clamped - current_bet >= last_raise:  # full raise re-opens the betting
                        last_raise = clamped - current_bet
                        acted = {pick}
                    else:  # short all-in: others may call/fold but not re-raise
                        acted.add(pick)
                    current_bet = clamped
                elif kind == "call":
                    chips = min(to_call, stack[pick])
                    label = "call"
                    acted.add(pick)
                else:
                    chips = 0
                    label = kind
                    acted.add(pick)

                stack[pick] -= chips
                bet[pick] += chips
                contrib[pick] += chips
                if stack[pick] == 0 and chips > 0:
                    allin[pick] = True
                if label == "fold":
                    folded[pick] = True
                log(street, pick, label, chips, pot_before=pot_before, to_call=to_call,
                    stack_before=stack_before, min_to=min_to, max_to=max_to, active=active,
                    corrected=corrected, think=think)
                cursor = (pick + 1) % n

        for street in range(4):
            if street == 1:
                board.extend(full_board[0:3])
            elif street == 2:
                board.append(full_board[3])
            elif street == 3:
                board.append(full_board[4])
            if street > 0:
                bet[:] = [0] * n
            betting_round(street)
            if sum(1 for s in range(n) if not folded[s]) == 1:
                break

        # ------------------------------------------------------------------ payout
        live = [s for s in range(n) if not folded[s]]
        showdown = len(live) > 1
        scores = {s: evaluate(list(hole[s]) + board) for s in live} if showdown else {}
        winnings = [0] * n
        prev = 0
        for level in sorted({c for c in contrib if c > 0}):
            amount = sum(min(c, level) - min(c, prev) for c in contrib)
            prev = level
            elig = [s for s in live if contrib[s] >= level] or [max(live, key=lambda s: contrib[s])]
            if len(elig) == 1:
                winnings[elig[0]] += amount
                continue
            best = max(scores[s] for s in elig)
            winners = sorted((s for s in elig if scores[s] == best), key=lambda s: (s - button - 1) % n)
            share, rem = divmod(amount, len(winners))
            for i, w in enumerate(winners):
                winnings[w] += share + (1 if i < rem else 0)
        final = [stack[s] + winnings[s] for s in range(n)]

        seats = []
        for s in range(n):
            mine = [e for e in events if e.seat == s]
            fold_ev = next((e for e in mine if e.kind == "fold"), None)
            net = final[s] - start[s]
            seats.append(SeatResult(
                seat=s, hole=hole[s], start_stack=start[s], final_stack=final[s], net=net,
                pos_idx=pos_idx[s], position=pos_name[s],
                vpip=int(any(e.street == 0 and e.kind in ("call", "bet", "raise") for e in mine)),
                pfr=int(any(e.street == 0 and e.kind in ("bet", "raise") for e in mine)),
                saw_flop=int(len(board) >= 3 and (fold_ev is None or fold_ev.street >= 1)),
                showdown=int(showdown and not folded[s]),
                won_showdown=int(showdown and not folded[s] and net > 0),
                folded_street=fold_ev.street if fold_ev else -1,
                hand_score=scores.get(s, -1)))
        assert sum(x.net for x in seats) == 0, "chips not conserved"

        summary = HandSummary(
            hand_no=hand_no, board=tuple(board), net=tuple(x.net for x in seats),
            revealed={s: hole[s] for s in live} if showdown else {}, events=tuple(events),
            showdown=showdown)
        for s, bot in enumerate(self.bots):
            self._safe(s, bot.on_hand_end, summary)

        return HandResult(hand_no=hand_no, button=button, board=list(board), events=events,
                          seats=seats, pot_total=sum(contrib), showdown=showdown)
