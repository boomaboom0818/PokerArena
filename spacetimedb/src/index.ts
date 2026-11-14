import { ScheduleAt } from 'spacetimedb';
import { schema, table, t, type InferSchema, type ReducerCtx } from 'spacetimedb/server';

const RANKS = '23456789TJQKA';
const SUITS = 'cdhs';
const NAMES = ['tag', 'lag', 'nit', 'equity', 'calling_station', 'maniac'];
const TABLE_SIZE = 6;
const MATCH_HANDS = 6;
const BB = 100;
const SB = 50;
const STACK = 10000;

const bot = table({ name: 'bot', public: true }, {
  name: t.string().primaryKey(),
  elo: t.f64(),
  matches: t.u32(),
  hands: t.u32(),
  chips: t.i64(),
});

const tableState = table({ name: 'table_state', public: true }, {
  tableId: t.u32().primaryKey(),
  names: t.string(),
  handNo: t.u32(),
  phase: t.string(),
  board: t.string(),
  pot: t.i32(),
  actor: t.string(),
  log: t.string(),
  seats: t.string(),
  handsSaved: t.u32(),
});

const tickTimer = table({ name: 'tick_timer' }, {
  scheduledId: t.u64().primaryKey().autoInc(),
  scheduledAt: t.scheduleAt(),
});

const spacetimedb = schema({ bot, tableState, tickTimer });
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

function cardStr(card: number): string {
  return RANKS[card >> 2] + SUITS[card & 3];
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(deck: number[], rnd: () => number): void {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = deck[i];
    deck[i] = deck[j];
    deck[j] = tmp;
  }
}

function straightHigh(mask: number): number {
  const m = (mask << 1) | ((mask >> 12) & 1);
  for (let i = 13; i > 3; i--) {
    if (((m >> (i - 4)) & 0b11111) === 0b11111) return i - 1;
  }
  return -1;
}

function evaluate(cards: number[]): number {
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

type Seat = {
  name: string;
  hole: number[];
  stack: number;
  bet: number;
  folded: boolean;
  net: number;
};

function decide(name: string, hole: number[], board: number[], toCall: number, stack: number, rnd: () => number): string {
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

function playHand(names: string[], handNo: number, seed: number): { seats: Seat[]; board: string; pot: number; log: string } {
  const rnd = mulberry32((seed + handNo * 97) >>> 0);
  const deck = [...Array(52).keys()];
  shuffle(deck, rnd);
  const seats: Seat[] = names.map((name, i) => ({
    name, hole: [deck[2 * i], deck[2 * i + 1]], stack: STACK, bet: 0, folded: false, net: 0,
  }));
  const n = seats.length;
  const button = handNo % n;
  const sb = (button + 1) % n;
  const bb = (button + 2) % n;
  const post = (i: number, amt: number) => {
    const paid = Math.min(amt, seats[i].stack);
    seats[i].stack -= paid;
    seats[i].bet += paid;
  };
  post(sb, SB);
  post(bb, BB);
  const boardIds = deck.slice(2 * n, 2 * n + 5);
  const logs: string[] = [`${seats[sb].name} posts the small blind`, `${seats[bb].name} posts the big blind`];
  let street = 0;
  const streets = [0, 3, 4, 5];
  for (const shown of streets) {
    const board = boardIds.slice(0, shown);
    let current = Math.max(...seats.map(s => s.bet));
    const acted = new Set<number>();
    let cursor = shown === 0 ? (bb + 1) % n : (button + 1) % n;
    let guard = 0;
    while (guard++ < 40) {
      const live = seats.filter(s => !s.folded);
      if (live.length <= 1) break;
      let pick = -1;
      for (let k = 0; k < n; k++) {
        const i = (cursor + k) % n;
        if (seats[i].folded) continue;
        if (!acted.has(i) || seats[i].bet < current) { pick = i; break; }
      }
      if (pick < 0) break;
      const toCall = current - seats[pick].bet;
      const choice = decide(seats[pick].name, seats[pick].hole, board, toCall, seats[pick].stack, rnd);
      if (choice === 'fold' || (choice === 'check' && toCall > 0)) {
        seats[pick].folded = true;
        logs.push(`${seats[pick].name} folds`);
      } else if (choice === 'raise' && seats[pick].stack > toCall) {
        const raiseTo = Math.min(seats[pick].stack + seats[pick].bet, Math.max(current + BB, current * 2));
        const chips = raiseTo - seats[pick].bet;
        seats[pick].stack -= chips;
        seats[pick].bet = raiseTo;
        current = raiseTo;
        acted.clear();
        acted.add(pick);
        logs.push(`${seats[pick].name} raises to $${raiseTo.toLocaleString()}`);
      } else if (toCall === 0) {
        logs.push(`${seats[pick].name} checks`);
        acted.add(pick);
      } else {
        const chips = Math.min(toCall, seats[pick].stack);
        seats[pick].stack -= chips;
        seats[pick].bet += chips;
        logs.push(`${seats[pick].name} calls $${chips.toLocaleString()}`);
        acted.add(pick);
      }
      cursor = (pick + 1) % n;
    }
    if (seats.filter(s => !s.folded).length <= 1) break;
    for (const s of seats) s.bet = 0;
    street = shown;
    if (shown === 3) logs.push(`Flop: ${boardIds.slice(0, 3).map(cardStr).join(' ')}`);
    if (shown === 4) logs.push(`Turn: ${boardIds.slice(0, 4).map(cardStr).join(' ')}`);
    if (shown === 5) logs.push(`River: ${boardIds.map(cardStr).join(' ')}`);
  }
  const live = seats.filter(s => !s.folded);
  const board = boardIds.slice(0, Math.max(street, live.length > 1 ? 5 : street));
  const contrib = seats.map(s => STACK - s.stack);
  const pot = contrib.reduce((a, b) => a + b, 0);
  if (live.length === 1) {
    live[0].stack += pot;
    logs.push(`${live[0].name} wins $${pot.toLocaleString()}`);
  } else {
    const scores = seats.map((s, i) => s.folded ? -1 : evaluate([...s.hole, ...board]));
    const best = Math.max(...scores);
    const winners = seats.filter((_, i) => scores[i] === best);
    const share = Math.floor(pot / winners.length);
    for (const w of winners) {
      w.stack += share;
      logs.push(`${w.name} wins $${share.toLocaleString()}`);
    }
  }
  for (const s of seats) s.net = s.stack - STACK;
  return {
    seats,
    board: board.map(cardStr).join(' '),
    pot,
    log: logs[logs.length - 1] || 'Hand dealt',
  };
}

function expected(a: number, b: number): number {
  return 1 / (1 + 10 ** ((b - a) / 400));
}

function rate(ctx: Ctx, names: string[], nets: number[]): void {
  const rows = names.map(name => ctx.db.bot.name.find(name)!);
  const n = names.length;
  const profit = nets.map(net => net / BB / MATCH_HANDS * 100);
  const deltas = names.map(() => 0);
  for (let i = 0; i < n; i++) {
    let total = 0;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const diff = profit[i] - profit[j];
      const s = diff === 0 ? 0.5 : diff > 0 ? 1 : 0;
      total += s - expected(rows[i].elo, rows[j].elo);
    }
    const k = rows[i].matches < 30 ? 32 : 16;
    deltas[i] = k * total / (n - 1);
  }
  names.forEach((name, i) => {
    const row = rows[i];
    ctx.db.bot.name.update({
      ...row,
      elo: row.elo + deltas[i],
      matches: row.matches + 1,
      hands: row.hands + MATCH_HANDS,
      chips: row.chips + BigInt(nets[i]),
    });
  });
}

function playMatch(ctx: Ctx): void {
  const seed = Number(ctx.timestamp.microsSinceUnixEpoch % 1_000_000_007n);
  const nets = NAMES.map(() => 0);
  let last = playHand(NAMES, 0, seed);
  for (let hand = 0; hand < MATCH_HANDS; hand++) {
    last = playHand(NAMES, hand, seed);
    last.seats.forEach((s, i) => { nets[i] += s.net; });
  }
  rate(ctx, NAMES, nets);
  const seats = last.seats.map(s => ({
    bot: s.name,
    stack: s.stack,
    bet: 0,
    folded: s.folded,
    hole: s.hole.map(cardStr),
    net: s.net,
    position: 'seat',
  }));
  const existing = ctx.db.tableState.tableId.find(0);
  const row = {
    tableId: 0,
    names: NAMES.join(','),
    handNo: MATCH_HANDS,
    phase: 'result',
    board: last.board,
    pot: last.pot,
    actor: '',
    log: last.log,
    seats: JSON.stringify(seats),
    handsSaved: (existing?.handsSaved ?? 0) + MATCH_HANDS,
  };
  if (existing) ctx.db.tableState.tableId.update(row);
  else ctx.db.tableState.insert(row);
}

export const init = spacetimedb.init(ctx => {
  for (const name of NAMES) {
    ctx.db.bot.insert({ name, elo: 1500, matches: 0, hands: 0, chips: 0n });
  }
  ctx.db.tickTimer.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(2_000_000n) });
  playMatch(ctx);
});

export const tick = spacetimedb.reducer(
  { onSchedule: tickTimer },
  { timer: tickTimer.rowType },
  (ctx, _args) => {
    playMatch(ctx);
  }
);
