import assert from 'node:assert/strict';
import test from 'node:test';
import { arenaPreview } from '../public/stdb.js';

function mockArena(t, tableRows, paused = false) {
  const fetch = t.mock.method(globalThis, 'fetch', async (_url, opts) => ({
    ok: true,
    async json() { return [{ rows: opts.body.includes('FROM control') ? [{ paused }] : tableRows }]; },
  }));
  return fetch;
}

test('paused snapshots never appear live', async t => {
  mockArena(t, [{ phase: 'flop', log: 'Old hand' }], true);
  const result = await arenaPreview('6-max');
  assert.equal(result.state, 'paused');
  assert.doesNotMatch(result.note, /Old hand/);
});

test('poker preview counts active tables and shows a public action', async t => {
  const fetch = mockArena(t, [{ phase: 'flop', log: 'ada calls $100' }, { phase: 'turn' }, { phase: 'result' }]);
  assert.deepEqual(await arenaPreview('heads-up'), { state: 'live', label: '2 live tables', note: 'ada calls $100' });
  assert.ok(fetch.mock.calls.every(call => call.arguments[0].includes('/poker-heads-up/sql')));
});

test('expired Figgie rounds are not advertised as trading', async t => {
  mockArena(t, [{ phase: 'trading', ends_at: 1000 }, { phase: 'reveal', next_at: 1200, last_trade: 'Goal suit was clubs' }]);
  assert.equal((await arenaPreview('figgie', 1100)).state, 'break');
  assert.equal((await arenaPreview('figgie', 1300)).label, 'Waiting for bots');
});
