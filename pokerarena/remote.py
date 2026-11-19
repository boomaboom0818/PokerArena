"""Run an existing Hold'em Bot locally, answering its private WebSocket turns."""

import json
import sys
import time

from .bots import spec_from_string
from .engine import _coerce
from .figgie import HOST, PROTOCOL, WebSocket, clean_name, save_token, token_path
from .models import ActionEvent, Observation, PlayerView


def observation(raw):
    data = json.loads(raw)
    for key in ('hole', 'board'):
        data[key] = tuple(data[key])
    data['players'] = tuple(PlayerView(**p) for p in data['players'])
    data['history'] = tuple(ActionEvent(**e) for e in data['history'])
    return Observation(**data)


def play_session(ws, bot, name, path):
    rid, last = 0, None

    def call(reducer, args):
        nonlocal rid
        rid += 1
        ws.send(json.dumps({'CallReducer': {'reducer': reducer, 'args': json.dumps(args), 'request_id': rid, 'flags': 0}}))

    while True:
        msg = json.loads(ws.recv())
        if 'IdentityToken' in msg:
            save_token(path, msg['IdentityToken']['token'])
            call('register', [name])
            ws.send(json.dumps({'Subscribe': {'query_strings': ['SELECT * FROM my_turn'], 'request_id': 0}}))
            continue
        if 'SubscriptionError' in msg:
            raise SystemExit('The arena refused the my_turn subscription; check your database selection.')
        tx = msg.get('TransactionUpdate', {})
        status = tx.get('status', {})
        reducer = tx.get('reducer_call', {}).get('reducer_name', '')
        if 'Failed' in status:
            if reducer == 'register' or tx.get('reducer_call', {}).get('request_id') == 1:
                raise SystemExit(f"registration refused: {status['Failed']}")
            print(f"turn refused: {status['Failed']}", file=sys.stderr)
        if 'InitialSubscription' in msg:
            print(f'{name}: connected; waiting for a turn', flush=True)
        update = (msg.get('InitialSubscription', {}).get('database_update') or
                  msg.get('TransactionUpdateLight', {}).get('update') or status.get('Committed') or {})
        for table in update.get('tables', []):
            if table['table_name'] != 'my_turn':
                continue
            for change in table['updates']:
                for row in change['inserts']:
                    row = json.loads(row)
                    if isinstance(row, list):
                        row = dict(zip(('turn_id', 'owner', 'table_id', 'deadline_ms', 'observation'), row))
                    key = row['turn_id'], row['deadline_ms']
                    if key == last:
                        continue
                    last = key
                    obs = observation(row['observation'])
                    bot.seat = obs.seat
                    try:
                        action, amount = _coerce(bot.act(obs)) or ('check' if obs.can_check else 'fold', 0)
                    except Exception as e:
                        print(f'local bot error: {e}', file=sys.stderr)
                        action, amount = ('check' if obs.can_check else 'fold'), 0
                    call('submit_action', [key[0], action, amount if action == 'raise' else 0])


def run(args):
    specs = spec_from_string(args.bot)
    if len(specs) != 1:
        raise SystemExit('Choose one bot, using file.py:Class if needed.')
    name = clean_name(args.name or specs[0].name)
    if not name:
        raise SystemExit('A bot name needs letters, digits or _.')
    db = 'poker-heads-up' if args.game == 'heads-up' else 'poker-arena'
    host = args.host.rstrip('/')
    path = token_path(name, host, db)
    bot = specs[0].build()
    delay = 1
    while True:
        try:
            ws = WebSocket(f'{host}/v1/database/{db}/subscribe', PROTOCOL, path.read_text().strip() if path.exists() else None)
            try:
                delay = 1
                play_session(ws, bot, name, path)
            finally:
                ws.close()
        except OSError as e:
            print(f'{db}: {e}; reconnecting in {delay}s', file=sys.stderr)
            time.sleep(delay)
            delay = min(30, delay*2)
