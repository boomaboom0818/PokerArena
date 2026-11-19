import assert from 'node:assert/strict';
import test from 'node:test';
import { dealRandom } from '../arena-shared/deal-random.ts';

test('deals conserve cards, are replayable, and change with the private key or round', () => {
  const deck = Array.from({ length: 40 }, (_, i) => i);
  const shuffle = (key, round) => dealRandom(key, round).shuffle([...deck]);
  const key = '12'.repeat(32), otherKey = '34'.repeat(32);
  const deal = shuffle(key, 'db:1:1000');
  assert.deepEqual([...deal].sort((a, b) => a - b), deck);
  assert.deepEqual(shuffle(key, 'db:1:1000'), deal);
  assert.notDeepEqual(shuffle(otherKey, 'db:1:1000'), deal);
  assert.notDeepEqual(shuffle(key, 'db:2:1000'), deal);
  assert.throws(() => shuffle('', 'db:1:1000'));
});
