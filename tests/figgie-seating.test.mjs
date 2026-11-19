import assert from 'node:assert/strict';
import test from 'node:test';
import { DECK_SIZE, POT, START_CASH, dealHands, tableSizes } from '../spacetimedb-figgie/src/seating.ts';

test('Figgie fills four- and five-seat tables without splitting five visitors', () => {
  assert.deepEqual(tableSizes(0), []);
  assert.deepEqual(tableSizes(3), []);
  assert.deepEqual(tableSizes(4), [4]);
  assert.deepEqual(tableSizes(5), [5]);
  assert.deepEqual(tableSizes(6), [5]);
  assert.deepEqual(tableSizes(7), [5]);
  assert.deepEqual(tableSizes(8), [4, 4]);
  assert.deepEqual(tableSizes(9), [5, 4]);
  assert.deepEqual(tableSizes(10), [5, 5]);
  for (let visitors = 0; visitors <= 64; visitors++) {
    const sizes = tableSizes(visitors);
    assert.ok(sizes.every(size => size === 4 || size === 5));
    const feasible = Array.from({ length: visitors + 1 }, (_, n) => n)
      .filter(n => Math.ceil(n / 5) <= Math.floor(n / 4));
    const seated = Math.max(...feasible);
    assert.equal(sizes.reduce((a, b) => a + b, 0), seated);
    assert.equal(sizes.length, Math.ceil(seated / 5));
  }
});

test('both table sizes deal all 40 cards and pay equal shares into a $200 pot', () => {
  const suits = [12, 8, 10, 10];
  const deck = suits.flatMap((count, suit) => Array(count).fill(suit));
  assert.equal(deck.length, DECK_SIZE);
  for (const [seats, cards, cash] of [[4, 10, 300], [5, 8, 310]]) {
    const hands = dealHands(deck, seats);
    assert.equal(hands.length, seats);
    for (const hand of hands) assert.equal(hand.reduce((a, b) => a + b, 0), cards);
    assert.deepEqual(suits.map((_, s) => hands.reduce((sum, hand) => sum + hand[s], 0)), suits);
    assert.equal(START_CASH - POT / seats, cash);
    assert.equal((START_CASH - cash) * seats, 200);
  }
});
