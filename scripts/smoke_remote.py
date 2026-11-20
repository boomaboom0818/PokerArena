"""Exercise built modules on disposable loopback SpacetimeDB, optionally over old bundles."""
import argparse
from contextlib import ExitStack
import hashlib
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
                                env={**os.environ, 'ARENA_ADMIN_ID': admin['identity'], 'ARENA_AUTH_CLIENT_ID': 'local-smoke', 'FIGGIE_DEAL_KEY': os.urandom(32).hex(), 'POKER_DEAL_KEY': os.urandom(32).hex()})
            def denied(fn):
                try: fn()
                except HTTPError: return
                raise AssertionError('expected refusal')
            for module, db in [('spacetimedb', 'poker-arena'), ('spacetimedb-hu', 'poker-heads-up'), ('spacetimedb-figgie', 'figgie-arena')]:
                route = '/v1/database/'+db
                def rows(query, auth=token): return json.loads(post(route+'/sql',query.encode(),auth))[0]['rows']
                def call(name,args,auth=token): return post(route+'/call/'+name,json.dumps(args).encode(),auth)
                # The disposable database owner seeds grants in place of the hosted login service.
                def grant(name, account=None, ttl=600):
                    account = account or json.loads(post('/v1/identity'))['identity']
                    code = os.urandom(16).hex()
                    digest = hashlib.sha256(code.encode()).hexdigest()
                    stmt = f"INSERT INTO deploy_grant (account,digest,name,email,expires_ms) VALUES (0x{account},'{digest}','{name}','test@example.invalid',{(time.time()+ttl)*1000:.1f})"
                    post(route+'/sql',stmt.encode(),token)
                    return code, account
                if legacy:
                    publish(legacy,module,db); call('set_paused',[True]); before = rows('SELECT * FROM control')
                publish(ROOT,module,db)
                if legacy: assert before == rows('SELECT * FROM control')
                else: call('set_paused',[True])
                other = json.loads(post('/v1/identity'))['token']
                denied(lambda: call('set_paused',[False],other))
                denied(lambda: call('register',['unlinked'],other))
                denied(lambda: call('issue_deploy_code',['unlinked','ab'*32],other))
                denied(lambda: rows('SELECT * FROM bot_account',other))
                denied(lambda: rows('SELECT * FROM deploy_grant',other))
                expired, account = grant('expired', ttl=-60)
                denied(lambda: call('deploy_bot',['expired',expired],other))
                denied(lambda: call('set_account_banned',[account,True],other))
                call('set_account_banned',[account,True]); call('set_account_banned',[account,False])
                # Recovery keeps attribution and revokes the previous machine's token.
                first = json.loads(post('/v1/identity'))['token']
                replacement = json.loads(post('/v1/identity'))['token']
                code, account = grant('owner_check')
                denied(lambda: call('deploy_bot',['wrong_name',code],first))
                call('deploy_bot',['owner_check',code],first)
                conflict, _ = grant('owner_check')
                denied(lambda: call('deploy_bot',['owner_check',conflict],replacement))
                call('deploy_bot',['owner_check',grant('owner_check',account)[0]],replacement)
                assert rows("SELECT email FROM bot_account WHERE name = 'owner_check'") == [['test@example.invalid']]
                denied(lambda: call('register',['owner_check'],first))
                call('set_account_banned',[account,True]); denied(lambda: call('register',['owner_check'],replacement))
                if db == 'figgie-arena':
                    denied(lambda: call('host_bot',['example','maker'],other))
                    denied(lambda: rows('SELECT * FROM hand',other))
                    figgie_tokens = [other] + [json.loads(post('/v1/identity'))['token'] for _ in range(8)]
                    def deploy_figgie(i, auth):
                        name = f'figgie{i}'
                        code, account = grant(name)
                        call('deploy_bot',[name,code],auth)
                        denied(lambda: call('deploy_bot',[name,code],auth))
                        call('set_account_banned',[account,True]); denied(lambda: call('ready',[],auth))
                        denied(lambda: call('register',[name],auth)); call('set_account_banned',[account,False])
                        call('register',[name],auth); call('ready',[],auth)
                    for i, auth in enumerate(figgie_tokens[:3]): deploy_figgie(i, auth)
                    call('set_paused',[False]); time.sleep(1.2)
                    # An old deployment may still have a round ending; a fresh one must be idle.
                    if not legacy:
                        assert not rows('SELECT * FROM seat')
                        call('set_paused',[True])
                        for i, auth in enumerate(figgie_tokens[3:], 3): deploy_figgie(i, auth)
                        for auth in figgie_tokens: call('ready',[],auth)
                        call('set_paused',[False])
                        deadline = time.monotonic()+5
                        while len(seats := rows('SELECT table_id, kind, cash, cards FROM seat')) < 9:
                            if time.monotonic()>deadline:
                                log = subprocess.run(['spacetime','--config-path',str(cfg),'logs','--server',host,'--no-config',db], capture_output=True, text=True, timeout=8)
                                raise AssertionError(f'mixed Figgie tables did not start: {seats}, players={rows("SELECT name, online, last_seen FROM player")}, control={rows("SELECT paused, round_no FROM control")}\n{log.stdout[-2000:]}\n{log.stderr[-500:]}')
                            time.sleep(.1)
                        assert sorted(seats).count([0,'remote',310,8]) == 5
                        assert sorted(seats).count([1,'remote',300,10]) == 4
                    print(db, 'remote registration, hand privacy, no hosting, seating thresholds: OK',flush=True); continue
                denied(lambda: call('connect_bot',['example','unused'],other))
                denied(lambda: rows('SELECT * FROM bot',other))
                size = 2 if module.endswith('-hu') else 6
                with ExitStack() as cleanup:
                    sockets = {}
                    def join(i):
                        ws = WebSocket(host.replace('http:','ws:')+route+'/subscribe',PROTOCOL)
                        cleanup.callback(ws.close)
                        ws.sock.settimeout(15)
                        owner = json.loads(ws.recv())['IdentityToken']['token']
                        name = f'socket_test_{i}'
                        code, _ = grant(name)
                        ws.send(json.dumps({'CallReducer':{'reducer':'deploy_bot','args':json.dumps([name,code]),'request_id':1,'flags':0}}))
                        ws.send(json.dumps({'Subscribe':{'query_strings':['SELECT * FROM my_turn'],'request_id':2}}))
                        while 'InitialSubscription' not in json.loads(ws.recv()): pass
                        sockets[owner] = (ws, name)
                    for i in range(size-1): join(i)
                    denied(lambda: call('remove_bot',['socket_test_0'],other))
                    call('set_paused',[False])
                    time.sleep(1.8)
                    assert not rows('SELECT * FROM table_state')
                    for i in range(size-1, size*2): join(i)
                    deadline = time.monotonic()+5
                    while len(tables := rows('SELECT names FROM table_state')) < 2:
                        if time.monotonic()>deadline: raise AssertionError('second full poker table did not start')
                        time.sleep(.1)
                    names = [name for (lineup,) in tables for name in lineup.split(',')]
                    assert len(names) == len(set(names)) == size*2 and all(n.startswith('socket_test_') for n in names)
                    owner, mine = next((auth, turns) for auth in sockets if (turns := rows('SELECT * FROM my_turn',auth)))
                    ws, name = sockets[owner]
                    turn_id, _, table_id, _, raw = mine[0]; obs = json.loads(raw)
                    assert obs['players'][obs['seat']]['name']==name and len(obs['hole'])==2
                    assert not rows('SELECT * FROM my_turn',other)
                    seats=json.loads(rows(f'SELECT seats FROM table_state WHERE table_id = {table_id}',other)[0][0])
                    assert all(s['hole']==['??','??'] for s in seats)
                    action = [turn_id,'fold',0]; denied(lambda: call('submit_action',action,other))
                    ws.send(json.dumps({'CallReducer':{'reducer':'submit_action','args':json.dumps(action),'request_id':3,'flags':0}}))
                    while True:
                        tx = json.loads(ws.recv()).get('TransactionUpdate',{})
                        if tx.get('reducer_call',{}).get('request_id') == 3:
                            assert 'Committed' in tx['status'],tx['status']; break
                # Run the same Python command advertised on the website, through a rated match.
                for i in range(size):
                    proc=subprocess.Popen([sys.executable,'-m','pokerarena','connect','bots_user/example_bot.py','--game',
                                           'heads-up' if module.endswith('-hu') else '6-max','--name',f'cli_test_{i}','--host',host.replace('http:','ws:')],
                                           cwd=ROOT,env={**os.environ,'POKERARENA_HOME':tmp},stdout=subprocess.DEVNULL, stdin=subprocess.PIPE, text=True)
                    controls.append(proc)
                    proc.stdin.write(grant(f'cli_test_{i}')[0]+'\n'); proc.stdin.close()
                deadline = time.monotonic()+45
                while time.monotonic()<deadline:
                    matches = rows("SELECT matches FROM standings WHERE name = 'cli_test_0'",other)
                    if matches and matches[0][0]>0: break
                    assert proc.poll() is None, 'CLI exited prematurely'
                    time.sleep(.25)
                else: raise AssertionError('CLI bot did not finish a match')
                for p in controls[-size:]: p.terminate(); p.wait(timeout=5)
                print(db,'full tables only, automatic scale-out, CLI rated match and private turns: OK',flush=True)
        finally:
            for p in controls:
                if p.poll() is None: p.terminate(); p.wait(timeout=5)
            os.killpg(server.pid,signal.SIGTERM); server.wait(timeout=10)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--legacy-dir', type=Path, help='checkout containing built pre-upgrade bundles')
    main(parser.parse_args().legacy_dir)
