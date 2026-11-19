"""Exercise built modules on disposable loopback SpacetimeDB, optionally over old bundles."""
import argparse
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from pokerarena.figgie import WebSocket, PROTOCOL


def main(legacy):
    with tempfile.TemporaryDirectory() as tmp, socket.socket() as reservation:
        reservation.bind(('127.0.0.1', 0))
        port = reservation.getsockname()[1]
        reservation.close()
        host = f'http://127.0.0.1:{port}'
        with open(Path(tmp)/'node.log', 'w') as log:
            server = subprocess.Popen(['spacetime', 'start', '--listen-addr', f'127.0.0.1:{port}', '--data-dir', tmp+'/data', '--non-interactive'], stdout=log, stderr=log, start_new_session=True)
        def post(path, data=b'', token=None):
            headers = {'Content-Type': 'text/plain' if path.endswith('/sql') else 'application/json'}
            if token: headers['Authorization'] = 'Bearer '+token
            with urlopen(Request(host+path, data=data, headers=headers), timeout=8) as result:
                return result.read().decode()

        controls = []
        try:
            for _ in range(100):
                try: admin = json.loads(post('/v1/identity')); break
                except OSError: time.sleep(.1)
            else: raise RuntimeError('local node did not start')
            token = admin['token']
            cfg = Path(tmp)/'cli.toml'
            cfg.write_text('spacetimedb_token = '+json.dumps(token)+'\n'); cfg.chmod(0o600)
            def publish(base, module, db):
                subprocess.run(['spacetime', '--config-path', str(cfg), 'publish', '--server', host, '--js-path', str(base/module/'dist/bundle.js'),
                                '--no-config', '--delete-data=never', '--break-clients', '--yes=migrate,skip-login', db], check=True, cwd=tmp, stdout=subprocess.DEVNULL,
                               env={**os.environ, 'ARENA_ADMIN_ID': admin['identity'], 'FIGGIE_DEAL_KEY': os.urandom(32).hex(), 'POKER_DEAL_KEY': os.urandom(32).hex()})
            def denied(fn):
                try: fn()
                except HTTPError: return
                raise AssertionError('expected refusal')
            for module, db in [('spacetimedb', 'poker-arena'), ('spacetimedb-hu', 'poker-heads-up'), ('spacetimedb-figgie', 'figgie-arena')]:
                route = '/v1/database/'+db
                def rows(query, auth=token): return json.loads(post(route+'/sql',query.encode(),auth))[0]['rows']
                def call(name,args,auth=token): return post(route+'/call/'+name,json.dumps(args).encode(),auth)
                if legacy:
                    publish(legacy,module,db); call('set_paused',[True]); before = rows('SELECT * FROM control')
                publish(ROOT,module,db)
                if legacy: assert before == rows('SELECT * FROM control')
                else: call('set_paused',[True])
                other = json.loads(post('/v1/identity'))['token']
                denied(lambda: call('set_paused',[False],other))
                if db == 'figgie-arena':
                    denied(lambda: call('host_bot',['example','maker'],other))
                    call('register',['figgie_test'],other); denied(lambda: rows('SELECT * FROM hand',other))
                    print(db, 'remote registration, hand privacy, no hosting, pause preserved: OK',flush=True); continue
                denied(lambda: call('connect_bot',['example','unused'],other))
                denied(lambda: rows('SELECT * FROM bot',other))
                ws = WebSocket(host.replace('http:','ws:')+route+'/subscribe',PROTOCOL)
                try:
                    ws.sock.settimeout(15)
                    owner = json.loads(ws.recv())['IdentityToken']['token']
                    ws.send(json.dumps({'CallReducer':{'reducer':'register','args':'["socket_test"]','request_id':1,'flags':0}}))
                    ws.send(json.dumps({'Subscribe':{'query_strings':['SELECT * FROM my_turn'],'request_id':2}}))
                    while 'InitialSubscription' not in json.loads(ws.recv()): pass
                    assert ['socket_test'] in rows('SELECT name FROM standings',other)
                    denied(lambda: call('remove_bot',['socket_test'],other))
                    call('set_paused',[False])
                    deadline = time.monotonic()+12
                    while not (mine := rows('SELECT * FROM my_turn',owner)):
                        if time.monotonic()>deadline: raise AssertionError('no private turn after registration')
                        time.sleep(.1)
                    turn_id, _, table_id, _, raw = mine[0]; obs = json.loads(raw)
                    assert obs['players'][obs['seat']]['name']=='socket_test' and len(obs['hole'])==2
                    assert not rows('SELECT * FROM my_turn',other)
                    seats=json.loads(rows(f'SELECT seats FROM table_state WHERE table_id = {table_id}',other)[0][0])
                    assert all(s['hole']==['??','??'] for s in seats)
                    action = [turn_id,'fold',0]; denied(lambda: call('submit_action',action,other))
                    ws.send(json.dumps({'CallReducer':{'reducer':'submit_action','args':json.dumps(action),'request_id':3,'flags':0}}))
                    while True:
                        tx = json.loads(ws.recv()).get('TransactionUpdate',{})
                        if tx.get('reducer_call',{}).get('request_id') == 3:
                            assert 'Committed' in tx['status'],tx['status']; break
                finally: ws.close()
                # Run the same Python command advertised on the website, through a rated match.
                proc=subprocess.Popen([sys.executable,'-m','pokerarena','connect','bots_user/example_bot.py','--game',
                                       'heads-up' if module.endswith('-hu') else '6-max','--name','cli_test','--host',host.replace('http:','ws:')],
                                      cwd=ROOT,env={**os.environ,'POKERARENA_HOME':tmp},stdout=subprocess.DEVNULL)
                controls.append(proc)
                deadline = time.monotonic()+45
                while time.monotonic()<deadline:
                    matches = rows("SELECT matches FROM standings WHERE name = 'cli_test'",other)
                    if matches and matches[0][0]>0: break
                    assert proc.poll() is None, 'CLI exited prematurely'
                    time.sleep(.25)
                else: raise AssertionError('CLI bot did not finish a match')
                proc.terminate(); proc.wait(timeout=5)
                print(db,'CLI rated match, private live cards, turn ownership, no hosting, pause preserved: OK',flush=True)
        finally:
            for p in controls:
                if p.poll() is None: p.terminate(); p.wait(timeout=5)
            os.killpg(server.pid,signal.SIGTERM); server.wait(timeout=10)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--legacy-dir', type=Path, help='checkout containing built pre-upgrade bundles')
    main(parser.parse_args().legacy_dir)
