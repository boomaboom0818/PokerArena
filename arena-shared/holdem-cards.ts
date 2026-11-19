export const BB = 100, SB = 50, STACK = 10000;
export const HOUSE = ['tag', 'lag', 'nit', 'equity', 'calling_station', 'maniac'];
export const cardStr = (c: number) => '23456789TJQKA'[c >> 2] + 'cdhs'[c & 3];

function straightHigh(mask: number): number {
  const m = (mask << 1) | ((mask >> 12) & 1);
  for (let i = 13; i > 3; i--) {
    if (((m >> (i - 4)) & 0b11111) === 0b11111) return i - 1;
  }
  return -1;
}

export function evaluate(cards: number[]): number {
  const counts = new Array(13).fill(0);
  const bySuit: number[][] = [[], [], [], []];
  let mask = 0;
  for (const c of cards) {
    const r = c >> 2;
    counts[r] += 1;
    bySuit[c & 3].push(r);
    mask |= 1 << r;
  }
  const pack = (cat: number, ranks: number[]) => {
    let score = cat << 20;
    let shift = 16;
    for (const r of ranks.slice(0, 5)) {
      score |= r << shift;
      shift -= 4;
    }
    return score;
  };
  for (const ranks of bySuit) {
    if (ranks.length >= 5) {
      let fmask = 0;
      for (const r of ranks) fmask |= 1 << r;
      const sf = straightHigh(fmask);
      if (sf >= 0) return pack(8, [sf]);
      ranks.sort((a, b) => b - a);
      return pack(5, ranks);
    }
  }
  const quads: number[] = [];
  const trips: number[] = [];
  const pairs: number[] = [];
  const singles: number[] = [];
  for (let r = 12; r >= 0; r--) {
    if (counts[r] === 4) quads.push(r);
    else if (counts[r] === 3) trips.push(r);
    else if (counts[r] === 2) pairs.push(r);
    else if (counts[r] === 1) singles.push(r);
  }
  if (quads.length) {
    const q = quads[0];
    const kick = Math.max(...[...Array(13).keys()].filter(r => counts[r] && r !== q), 0);
    return pack(7, [q, kick]);
  }
  if (trips.length && (trips.length > 1 || pairs.length)) {
    const pairRank = Math.max(pairs[0] ?? -1, trips[1] ?? -1);
    return pack(6, [trips[0], pairRank]);
  }
  const st = straightHigh(mask);
  if (st >= 0) return pack(4, [st]);
  if (trips.length) return pack(3, [trips[0], ...singles.slice(0, 2)]);
  if (pairs.length >= 2) {
    const rest = [...pairs.slice(2), ...singles].sort((a, b) => b - a);
    return pack(2, [pairs[0], pairs[1], ...rest.slice(0, 1)]);
  }
  if (pairs.length) return pack(1, [pairs[0], ...singles.slice(0, 3)]);
  return pack(0, singles);
}

export function houseAction(name: string, hole: number[], board: number[], toCall: number, stack: number, rnd: () => number): string {
  const ranks = hole.map(c => c >> 2).sort((a, b) => b - a);
  const suited = (hole[0] & 3) === (hole[1] & 3);
  const pair = ranks[0] === ranks[1];
  const premium = pair && ranks[0] >= 8 || ranks[0] >= 10 && ranks[1] >= 10;
  const playable = premium || pair || suited && ranks[0] - ranks[1] <= 2 || ranks[0] >= 11;
  if (board.length === 0) {
    if (name === 'maniac' || name === 'calling_station') return toCall > stack * 0.4 && name === 'maniac' ? 'fold' : 'call';
    if (name === 'nit' || name === 'rock') return premium ? 'raise' : toCall === 0 ? 'check' : 'fold';
    if (name === 'lag') return playable ? 'raise' : toCall <= BB ? 'call' : 'fold';
    if (name === 'tag') return premium || ranks[0] >= 10 && suited ? 'raise' : playable && toCall <= 3 * BB ? 'call' : toCall === 0 ? 'check' : 'fold';
    return playable ? 'call' : toCall === 0 ? 'check' : 'fold';
  }
  const score = evaluate([...hole, ...board]);
  const cat = score >> 20;
  if (name === 'calling_station') return 'call';
  if (name === 'maniac') return rnd() < 0.7 ? 'raise' : 'call';
  if (cat >= 2) return 'raise';
  if (cat === 1) return toCall <= 4 * BB ? 'call' : 'fold';
  if (toCall === 0 && rnd() < (name === 'lag' ? 0.35 : 0.12)) return 'raise';
  return toCall === 0 ? 'check' : 'fold';
}
