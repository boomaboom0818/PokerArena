"""Command line: ``python -m pokerarena <command>``."""

from __future__ import annotations

import argparse
import sys
import time

from .arena import Arena, ArenaConfig
from .bots import BUILTIN, builtin_specs, spec_from_string, specs_from_dir
from .dataset import export_csv, export_jsonl, iter_decisions, iter_hands
from .elo import EloConfig
from .replay import format_hand
from .storage import Store


def print_leaderboard(rows) -> None:
    head = f"{'#':>2} {'bot':<18}{'Elo':>7}{'matches':>8}{'hands':>9}{'bb/100':>9}{'±95%':>7}" \
           f"{'VPIP':>6}{'PFR':>6}{'AF':>5}{'wins':>6}"
    print(head)
    print("-" * len(head))
    for i, r in enumerate(rows, 1):
        print(f"{i:>2} {r['bot']:<18}{r['elo']:>7.0f}{r['matches']:>8}{r['hands']:>9}"
              f"{r['bb100']:>9.1f}{1.96 * r['stderr']:>7.1f}{r['vpip']:>6.0f}{r['pfr']:>6.0f}"
              f"{r['af']:>5.1f}{r['match_wins']:>6}")


def cmd_bots(args) -> None:
    for name, cls in BUILTIN.items():
        print(f"{name:<18} {cls.description}")


def cmd_run(args) -> None:
    specs = []
    if args.bots:
        for item in args.bots:
            specs.extend(spec_from_string(item))
    if args.bot_dir:
        specs.extend(specs_from_dir(args.bot_dir))
    if not args.bots and not args.bot_dir or args.builtins:
        specs = builtin_specs() + specs
    seen, unique = set(), []
    for s in specs:
        if s.name not in seen:
            seen.add(s.name)
            unique.append(s)
    store = Store(args.db)
    cfg = ArenaConfig(table_size=args.table_size, hands_per_match=args.hands, workers=args.workers,
                      matchmaking=args.matchmaking, seed=args.seed)
    elo = EloConfig(k=args.k, k_provisional=args.k_provisional)
    arena = Arena(store, unique, cfg, elo)
    n_tables = -(-len(unique) // cfg.table_size)
    print(f"{len(unique)} bots, {n_tables} tables/round x {cfg.table_size} seats, "
          f"{cfg.normalized_hands()} hands/match, {args.rounds} rounds -> {args.db}")
    t0 = time.time()

    def progress(round_no, rows):
        print(f"\n== round {round_no}/{args.rounds}  ({time.time() - t0:.0f}s) ==")
        if round_no % args.show_every == 0 or round_no == args.rounds:
            print_leaderboard(rows)
        else:
            print(f"  leader: {rows[0]['bot']} ({rows[0]['elo']:.0f})")

    arena.run(args.rounds, on_round=progress)
    print("\nFinal leaderboard")
    print_leaderboard(store.leaderboard())


def cmd_leaderboard(args) -> None:
    print_leaderboard(Store(args.db).leaderboard(args.min_hands))


def cmd_export(args) -> None:
    kw = dict(bots=args.bot, top=args.top, min_elo=args.min_elo, run_id=args.run)
    if args.what == "decisions":
        rows = iter_decisions(args.db, min_bb100=args.min_bb100, winners_only=args.winners_only,
                              limit=args.limit, **kw)
    else:
        rows = iter_hands(args.db, **kw)
    fmt = args.format or ("csv" if args.out.endswith(".csv") else "jsonl")
    n = (export_csv if fmt == "csv" else export_jsonl)(rows, args.out)
    print(f"wrote {n} {args.what} rows to {args.out}")


def cmd_serve(args) -> None:
    from pathlib import Path

    from .http_api import serve

    public = Path(__file__).resolve().parent.parent / "public"
    serve(args.db, args.host, args.port, static_dir=str(public) if public.is_dir() else None)


def cmd_replay(args) -> None:
    store = Store(args.db)
    if args.hand_id is None:
        row = store.db.execute(
            "SELECT hand_id FROM hands WHERE showdown=1 ORDER BY pot_total DESC LIMIT 1").fetchone()
        args.hand_id = row["hand_id"] if row else 1
        print("(no hand id given: showing the biggest showdown pot)\n")
    print(format_hand(store, args.hand_id))


def main(argv=None) -> None:
    p = argparse.ArgumentParser(prog="pokerarena", description="Texas Hold'em bot arena with Elo ratings")
    p.add_argument("--db", default="arena.db", help="SQLite database path (default arena.db)")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("bots", help="list built-in bots").set_defaults(fn=cmd_bots)

    r = sub.add_parser("run", help="run tournament rounds (every bot sits at a 6-seat table each round)")
    r.add_argument("--bots", nargs="*", help="built-in names, file.py, file.py:Class or module:Class")
    r.add_argument("--bot-dir", help="directory of .py files containing Bot subclasses")
    r.add_argument("--builtins", action="store_true", help="include built-ins even when --bots/--bot-dir given")
    r.add_argument("--rounds", type=int, default=5)
    r.add_argument("--hands", type=int, default=600, help="hands per match (rounded up to multiple of table size)")
    r.add_argument("--table-size", type=int, default=6)
    r.add_argument("--workers", type=int, default=0, help="parallel processes (0 = all CPUs)")
    r.add_argument("--matchmaking", choices=["random", "elo"], default="random")
    r.add_argument("--seed", type=int, default=0)
    r.add_argument("--k", type=float, default=16.0)
    r.add_argument("--k-provisional", type=float, default=32.0)
    r.add_argument("--show-every", type=int, default=1, help="print full leaderboard every N rounds")
    r.set_defaults(fn=cmd_run)

    lb = sub.add_parser("leaderboard", help="show ratings and stats")
    lb.add_argument("--min-hands", type=int, default=0)
    lb.set_defaults(fn=cmd_leaderboard)

    e = sub.add_parser("export", help="export training data")
    e.add_argument("what", choices=["decisions", "hands"])
    e.add_argument("out")
    e.add_argument("--format", choices=["jsonl", "csv"])
    e.add_argument("--bot", action="append", help="only this bot (repeatable)")
    e.add_argument("--top", type=int, help="only the N highest-Elo bots")
    e.add_argument("--min-elo", type=float)
    e.add_argument("--min-bb100", type=float, help="decisions only: bots with at least this win rate")
    e.add_argument("--run", type=int, help="only a given run id")
    e.add_argument("--winners-only", action="store_true", help="decisions only: hands the bot won")
    e.add_argument("--limit", type=int)
    e.set_defaults(fn=cmd_export)

    rp = sub.add_parser("replay", help="print one hand history")
    rp.add_argument("hand_id", type=int, nargs="?")
    rp.set_defaults(fn=cmd_replay)

    sv = sub.add_parser("serve", help="website + JSON API (what Vercel hosts)")
    sv.add_argument("--host", default="127.0.0.1")
    sv.add_argument("--port", type=int, default=8787)
    sv.set_defaults(fn=cmd_serve)

    args = p.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
