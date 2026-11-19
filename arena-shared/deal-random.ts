import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

// ctx.random is seeded from the reducer timestamp. That is fine for house-bot
// behaviour, but live players must not be able to reconstruct the hidden deal.
export function dealRandom(secret: string, dealId: string) {
  if (!/^[a-f0-9]{64}$/i.test(secret)) throw new Error('deal key must be a 32-byte hex key');
  const key = hexToBytes(secret);
  let counter = 0, cursor = 0, block: Uint8Array = new Uint8Array(0);
  function index(n: number): number {
    // All callers shuffle <= 64 players/cards. Reject the incomplete bucket.
    if (!Number.isInteger(n) || n < 1 || n > 65536) throw new Error('invalid shuffle size');
    const limit = 65536 - (65536 % n);
    for (;;) {
      if (cursor === block.length) {
        block = hmac(sha256, key, utf8ToBytes(`arena/deal/v1:${dealId}:${counter++}`));
        cursor = 0;
      }
      const value = (block[cursor++] << 8) | block[cursor++];
      if (value < limit) return value % n;
    }
  }
  return { index, shuffle<T>(items: T[]) {
    for (let i = items.length - 1; i > 0; i--) {
      const j = index(i + 1);
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  } };
}
