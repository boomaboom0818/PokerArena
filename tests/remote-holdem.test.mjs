import test from 'node:test';
import assert from 'node:assert/strict';
import { act, deal, observation, publicFrame } from '../arena-shared/holdem-engine.ts';
import { dealRandom } from '../arena-shared/deal-random.ts';

const deck = Array.from({length:52}, (_,i)=>i);
test('heads-up button acts first preflop; the big blind acts first on the flop', () => {
  const h = deal(['alice','bob'],1,deck);
  assert.equal(h.actor,0);
  assert.deepEqual(observation(h).hole,[0,1]);
  assert.equal(observation(h).players.some(p => 'hole' in p), false);
  assert.ok(JSON.parse(publicFrame(h).seats).every(s=>s.hole.join(' ')==='?? ??'));
  assert.throws(()=>act(h,'check'));
  assert.throws(()=>act(h,'raise',150));
  act(h,'call'); act(h,'check');
  assert.equal(h.actor,1); assert.deepEqual(observation(h).board,[4,5,6]);
  act(h,'raise',observation(h).max_raise_to); act(h,'call');
  assert.ok(h.done); assert.equal(h.seats.reduce((n,s)=>n+s.stack,0),20000);
  assert.ok(JSON.parse(publicFrame(h).seats).every(s=>!s.hole.includes('??')));
});

test('remote turn sequences finish legally and conserve chips in both arenas', () => {
  const rng=dealRandom('ae'.repeat(32),'test');
  for (const n of [2,6]) for (let no=1;no<=120;no++) {
    const h=deal(Array.from({length:n},(_,i)=>`bot${i}`),no,rng.shuffle([...deck]));
    for (let i=0;!h.done;i++) {
      assert.ok(i<1000);
      const o=observation(h), pick=rng.index(8);
      const action=pick<=1 && o.can_raise ? 'raise' : pick===2 && o.to_call ? 'fold' : 'call';
      act(h,action,pick===0 ? o.max_raise_to : o.min_raise_to);
    }
    assert.ok(h.seats.every(s=>s.stack>=0 && Number.isInteger(s.stack)));
    assert.equal(h.seats.reduce((v,s)=>v+s.stack,0),n*10000);
  }
});
