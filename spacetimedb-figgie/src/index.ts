// Figgie arena. Four bots per table, 40 cards, a $200 pot, 60 seconds of trading.
//
// Rules (Jane Street's Figgie):
//   * One suit has 12 cards, two have 10, one has 8. The goal suit is the suit of the
//     same colour as the 12-card suit, so it holds 8 or 10 cards.
//   * Everyone starts with $350 and antes $50 into a $200 pot, then gets 10 cards.
//   * Bots post bids and offers for one card of a suit, or take the best one.
//     Any trade clears every resting quote at the table.
//   * At the bell each goal-suit card pays $10 from the pot. Whatever is left goes to
//     whoever holds the most goal-suit cards (split on a tie).
//
// Bots connect over the SpacetimeDB WebSocket (subprotocol v1.json.spacetimedb), call
// `register`, subscribe to the public tables plus the `my_hand` view, and trade with the
// reducers below. Hands stay private until the bell, then land in `round_result`.

import { ScheduleAt } from 'spacetimedb';
import { Identity } from 'spacetimedb';
import { schema, table, t, SenderError, type InferSchema, type ReducerCtx } from 'spacetimedb/server';

const SUITS = ['spades', 'clubs', 'hearts', 'diamonds'] as const;
type Suit = (typeof SUITS)[number];
const PARTNER = [1, 0, 3, 2]; // same colour: spades<->clubs, hearts<->diamonds
const SEATS = 4;
const HAND_SIZE = 10;
const START_CASH = 350;
const ANTE = 50;
const POT = ANTE * SEATS;
const GOAL_PAY = 10;
const ROUND_MS = 60_000;
const BREAK_MS = 9_000;
const TICK_MICROS = 500_000n;
const MAX_PRICE = 400;
const MAX_ACTIONS = 900; // per bot per round
const ONLINE_GRACE_MS = 30_000;
const KEEP_RESULTS = 400;
const HOUSE = ['bayes', 'maker', 'hoarder', 'tape', 'noise'];

const player = table({ name: 'player', public: true }, {
  name: t.string().primaryKey(),
  owner: t.identity().index(),
  kind: t.string(), // house | remote | hosted
  elo: t.f64(),
  rounds: t.u32(),
  pnl: t.f64(),
  pnlSq: t.f64(),
  bonuses: t.u32(),
  tops: t.u32(),
  trades: t.u32(),
  edge: t.f64(),
  goalCards: t.u32(),
  rejects: t.u32(),
  online: t.bool(),
  lastSeen: t.f64(),
  joinedAt: t.f64(),
  tableId: t.i32(),
});

const figgieTable = table({ name: 'figgie_table', public: true }, {
  tableId: t.u32().primaryKey(),
  roundNo: t.u32(),
  phase: t.string(), // trading | reveal
  startedAt: t.f64(),
  endsAt: t.f64(),
  nextAt: t.f64(),
  pot: t.u32(),
  goal: t.string(), // '' until the bell
  twelve: t.string(),
  counts: t.string(),
  names: t.string(),
  lastTrade: t.string(),
});

const seat = table({ name: 'seat', public: true }, {
  seatKey: t.u32().primaryKey(),
  tableId: t.u32().index(),
  seat: t.u32(),
  name: t.string(),
  kind: t.string(),
  cash: t.i32(),
  cards: t.u32(),
  buys: t.u32(),
  sells: t.u32(),
  actions: t.u32(),
});

const hand = table({ name: 'hand' }, {
  seatKey: t.u32().primaryKey(),
  tableId: t.u32().index(),
  owner: t.identity().index(),
  name: t.string(),
  spades: t.u32(),
  clubs: t.u32(),
  hearts: t.u32(),
  diamonds: t.u32(),
  dealt: t.string(), // JSON [spades, clubs, hearts, diamonds] as dealt
});

const quote = table({ name: 'quote', public: true }, {
  quoteId: t.u64().primaryKey().autoInc(),
  tableId: t.u32().index(),
  seatKey: t.u32(),
  name: t.string(),
  suit: t.string(),
  side: t.string(), // bid | ask
  price: t.u32(),
  at: t.f64(),
});

const trade = table({ name: 'trade', public: true }, {
  tradeId: t.u64().primaryKey().autoInc(),
  tableId: t.u32().index(),
  roundNo: t.u32(),
  suit: t.string(),
  price: t.u32(),
  buyer: t.string(),
  seller: t.string(),
  at: t.f64(),
});

const roundResult = table({ name: 'round_result', public: true }, {
  resultId: t.u64().primaryKey().autoInc(),
  tableId: t.u32(),
  roundNo: t.u32(),
  startedAt: t.f64(),
  endedAt: t.f64(),
  goal: t.string(),
  twelve: t.string(),
  counts: t.string(),
  players: t.string(), // JSON, see settle()
  tape: t.string(), // JSON [[ms, suit, price, buyer, seller], ...]
  trades: t.u32(),
  volume: t.u32(),
});

const dealer = table({ name: 'dealer' }, {
  tableId: t.u32().primaryKey(),
  goal: t.u32(),
  twelve: t.u32(),
  counts: t.string(),
  startHands: t.string(),
});

const hosted = table({ name: 'hosted' }, {
  name: t.string().primaryKey(),
  source: t.string(),
});

const control = table({ name: 'control', public: true }, {
  id: t.u32().primaryKey(),
  paused: t.bool(),
  roundNo: t.u32(),
  admin: t.identity(),
});

const tickTimer = table({ name: 'tick_timer' }, {
  scheduledId: t.u64().primaryKey().autoInc(),
  scheduledAt: t.scheduleAt(),
});

const spacetimedb = schema({
  player, figgieTable, seat, hand, quote, trade, roundResult, dealer, hosted, control, tickTimer,
});
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
type HandRow = { spades: number; clubs: number; hearts: number; diamonds: number };

function nowMs(ctx: Ctx): number {
  return Number(ctx.timestamp.microsSinceUnixEpoch / 1000n);
}

function suitIndex(raw: string): number {
  const s = String(raw || '').trim().toLowerCase();
  const byName = SUITS.indexOf(s as Suit);
  if (byName >= 0) return byName;
  const short: Record<string, number> = { s: 0, c: 1, h: 2, d: 3, '♠': 0, '♣': 1, '♥': 2, '♦': 3, spade: 0, club: 1, heart: 2, diamond: 3 };
  if (s in short) return short[s];
  throw new SenderError(`unknown suit "${raw}" (use spades, clubs, hearts or diamonds)`);
}

function held(h: HandRow, suit: number): number {
  return [h.spades, h.clubs, h.hearts, h.diamonds][suit];
}

function withCount(h: HandRow, suit: number, delta: number): HandRow {
  const arr = [h.spades, h.clubs, h.hearts, h.diamonds];
  arr[suit] += delta;
  return { spades: arr[0], clubs: arr[1], hearts: arr[2], diamonds: arr[3] };
}

function handArr(h: HandRow): number[] {
  return [h.spades, h.clubs, h.hearts, h.diamonds];
}

// ---------- seating and dealing ----------

function control0(ctx: Ctx) {
  let row = ctx.db.control.id.find(0);
  if (!row) {
    row = { id: 0, paused: false, roundNo: 0, admin: ctx.sender };
    ctx.db.control.insert(row);
  }
  return row;
}

function eligibleUsers(ctx: Ctx, now: number): string[] {
  const out: string[] = [];
  for (const p of ctx.db.player.iter()) {
    if (p.kind === 'hosted') out.push(p.name);
    else if (p.kind === 'remote' && (p.online || now - p.lastSeen < ONLINE_GRACE_MS)) out.push(p.name);
  }
  return out;
}

function clearTables(ctx: Ctx): void {
  for (const q of [...ctx.db.quote.iter()]) ctx.db.quote.quoteId.delete(q.quoteId);
  for (const tr of [...ctx.db.trade.iter()]) ctx.db.trade.tradeId.delete(tr.tradeId);
  for (const s of [...ctx.db.seat.iter()]) ctx.db.seat.seatKey.delete(s.seatKey);
  for (const h of [...ctx.db.hand.iter()]) ctx.db.hand.seatKey.delete(h.seatKey);
  for (const d of [...ctx.db.dealer.iter()]) ctx.db.dealer.tableId.delete(d.tableId);
}

function deal(ctx: Ctx): void {
  const now = nowMs(ctx);
  const ctl = control0(ctx);
  const roundNo = ctl.roundNo + 1;
  ctx.db.control.id.update({ ...ctl, roundNo });
  clearTables(ctx);

  const users = ctx.random.shuffle(eligibleUsers(ctx, now));
  const tableCount = Math.max(1, Math.ceil(users.length / SEATS));
  const lineups: string[][] = Array.from({ length: tableCount }, () => []);
  users.forEach((name, i) => lineups[i % tableCount].push(name));
  let rot = roundNo;
  for (const lineup of lineups) {
    const used = new Set(lineup);
    while (lineup.length < SEATS) {
      const pick = HOUSE[rot++ % HOUSE.length];
      if (!used.has(pick)) {
        used.add(pick);
        lineup.push(pick);
      }
    }
  }

  for (const p of [...ctx.db.player.iter()]) {
    if (p.tableId !== -1) ctx.db.player.name.update({ ...p, tableId: -1 });
  }
  for (const row of [...ctx.db.figgieTable.iter()]) {
    if (row.tableId >= tableCount) ctx.db.figgieTable.tableId.delete(row.tableId);
  }

  lineups.forEach((lineup, tableId) => {
    const order = ctx.random.shuffle([...lineup]);
    const twelve = ctx.random.integerInRange(0, 3);
    const goal = PARTNER[twelve];
    const others = [0, 1, 2, 3].filter(s => s !== twelve);
    const eight = others[ctx.random.integerInRange(0, 2)];
    const counts = [10, 10, 10, 10];
    counts[twelve] = 12;
    counts[eight] = 8;
    const deck: number[] = [];
    counts.forEach((n, s) => { for (let i = 0; i < n; i++) deck.push(s); });
    ctx.random.shuffle(deck);
    const starts: number[][] = [];
    order.forEach((name, i) => {
      const cards = deck.slice(i * HAND_SIZE, (i + 1) * HAND_SIZE);
      const h = [0, 0, 0, 0];
      for (const c of cards) h[c] += 1;
      starts.push(h);
      const seatKey = tableId * 8 + i;
      const p = ctx.db.player.name.find(name)!;
      ctx.db.player.name.update({ ...p, tableId });
      ctx.db.seat.insert({
        seatKey, tableId, seat: i, name, kind: p.kind,
        cash: START_CASH - ANTE, cards: HAND_SIZE, buys: 0, sells: 0, actions: 0,
      });
      ctx.db.hand.insert({
        seatKey, tableId, owner: p.kind === 'remote' ? p.owner : Identity.zero(), name,
        spades: h[0], clubs: h[1], hearts: h[2], diamonds: h[3], dealt: JSON.stringify(h),
      });
    });
    ctx.db.dealer.insert({
      tableId, goal, twelve, counts: counts.join(','), startHands: JSON.stringify(starts),
    });
    const row = {
      tableId, roundNo, phase: 'trading', startedAt: now, endsAt: now + ROUND_MS, nextAt: now + ROUND_MS + BREAK_MS,
      pot: POT, goal: '', twelve: '', counts: '', names: order.join(','), lastTrade: '',
    };
    if (ctx.db.figgieTable.tableId.find(tableId)) ctx.db.figgieTable.tableId.update(row);
    else ctx.db.figgieTable.insert(row);
  });
}

// ---------- the market ----------

function seatOf(ctx: Ctx, tableId: number, name: string) {
  for (const s of ctx.db.seat.tableId.filter(tableId)) if (s.name === name) return s;
  return undefined;
}

function bestQuote(ctx: Ctx, tableId: number, suit: string, side: 'bid' | 'ask', exceptSeat = -1) {
  let best: ReturnType<typeof ctx.db.quote.quoteId.find> = null;
  for (const q of ctx.db.quote.tableId.filter(tableId)) {
    if (q.suit !== suit || q.side !== side || q.seatKey === exceptSeat) continue;
    if (!best) { best = q; continue; }
    const better = side === 'bid' ? q.price > best.price : q.price < best.price;
    if (better || (q.price === best.price && q.at < best.at)) best = q;
  }
  return best;
}

function execute(ctx: Ctx, tableId: number, suitIdx: number, price: number, buyerKey: number, sellerKey: number): string {
  const now = nowMs(ctx);
  const suit = SUITS[suitIdx];
  const buyer = ctx.db.seat.seatKey.find(buyerKey)!;
  const seller = ctx.db.seat.seatKey.find(sellerKey)!;
  const bh = ctx.db.hand.seatKey.find(buyerKey)!;
  const sh = ctx.db.hand.seatKey.find(sellerKey)!;
  if (held(sh, suitIdx) < 1) throw new SenderError(`${seller.name} has no ${suit} left`);
  if (buyer.cash < price) throw new SenderError(`${buyer.name} cannot pay $${price}`);
  ctx.db.hand.seatKey.update({ ...bh, ...withCount(bh, suitIdx, 1) });
  ctx.db.hand.seatKey.update({ ...sh, ...withCount(sh, suitIdx, -1) });
  ctx.db.seat.seatKey.update({ ...buyer, cash: buyer.cash - price, cards: buyer.cards + 1, buys: buyer.buys + 1 });
  ctx.db.seat.seatKey.update({ ...seller, cash: seller.cash + price, cards: seller.cards - 1, sells: seller.sells + 1 });
  const tbl = ctx.db.figgieTable.tableId.find(tableId)!;
  ctx.db.trade.insert({ tradeId: 0n, tableId, roundNo: tbl.roundNo, suit, price, buyer: buyer.name, seller: seller.name, at: now });
  const line = `${buyer.name} buys ${suit} from ${seller.name} at $${price}`;
  ctx.db.figgieTable.tableId.update({ ...tbl, lastTrade: line });
  // Figgie rule: a trade wipes every resting bid and offer.
  for (const q of [...ctx.db.quote.tableId.filter(tableId)]) ctx.db.quote.quoteId.delete(q.quoteId);
  return line;
}

type Order =
  | { type: 'bid' | 'ask'; suit: string; price: number }
  | { type: 'buy' | 'sell'; suit: string }
  | { type: 'cancel'; suit?: string; side?: string };

function liveTable(ctx: Ctx, tableId: number) {
  const tbl = ctx.db.figgieTable.tableId.find(tableId);
  if (!tbl || tbl.phase !== 'trading' || nowMs(ctx) >= tbl.endsAt) throw new SenderError('the market is closed until the next deal');
  return tbl;
}

function place(ctx: Ctx, tableId: number, seatKey: number, order: Order): void {
  liveTable(ctx, tableId);
  const me = ctx.db.seat.seatKey.find(seatKey);
  if (!me) throw new SenderError('not seated');
  if (me.actions >= MAX_ACTIONS) throw new SenderError(`limit of ${MAX_ACTIONS} actions per round reached`);
  ctx.db.seat.seatKey.update({ ...me, actions: me.actions + 1 });

  if (order.type === 'cancel') {
    const suit = order.suit ? SUITS[suitIndex(order.suit)] : '';
    for (const q of [...ctx.db.quote.tableId.filter(tableId)]) {
      if (q.seatKey !== seatKey) continue;
      if (suit && q.suit !== suit) continue;
      if (order.side && q.side !== order.side) continue;
      ctx.db.quote.quoteId.delete(q.quoteId);
    }
    return;
  }

  const suitIdx = suitIndex(order.suit);
  const suit = SUITS[suitIdx];
  const myHand = ctx.db.hand.seatKey.find(seatKey)!;

  if (order.type === 'buy' || order.type === 'sell') {
    const side = order.type === 'buy' ? 'ask' : 'bid';
    const best = bestQuote(ctx, tableId, suit, side, seatKey);
    if (!best) throw new SenderError(`nobody is ${order.type === 'buy' ? 'offering' : 'bidding for'} ${suit}`);
    if (order.type === 'buy') execute(ctx, tableId, suitIdx, best.price, seatKey, best.seatKey);
    else {
      if (held(myHand, suitIdx) < 1) throw new SenderError(`you hold no ${suit}`);
      execute(ctx, tableId, suitIdx, best.price, best.seatKey, seatKey);
    }
    return;
  }

  const price = Math.floor(Number((order as { price: number }).price));
  if (!Number.isFinite(price) || price < 1 || price > MAX_PRICE) throw new SenderError(`price must be a whole number from 1 to ${MAX_PRICE}`);
  const side = order.type as "bid" | "ask";
  if (side === 'bid' && price > me.cash) throw new SenderError(`you only have $${me.cash}`);
  if (side === 'ask' && held(myHand, suitIdx) < 1) throw new SenderError(`you hold no ${suit}`);

  const against = bestQuote(ctx, tableId, suit, side === 'bid' ? 'ask' : 'bid', seatKey);
  if (against && (side === 'bid' ? against.price <= price : against.price >= price)) {
    if (side === 'bid') execute(ctx, tableId, suitIdx, against.price, seatKey, against.seatKey);
    else execute(ctx, tableId, suitIdx, against.price, against.seatKey, seatKey);
    return;
  }
  const mine = [...ctx.db.quote.tableId.filter(tableId)].filter(q => q.seatKey === seatKey && q.suit === suit);
  const opposite = mine.find(q => q.side !== side);
  if (opposite && (side === 'bid' ? price >= opposite.price : price <= opposite.price)) {
    throw new SenderError(`that ${side} crosses your own ${opposite.side} at $${opposite.price}`);
  }
  for (const q of mine) if (q.side === side) ctx.db.quote.quoteId.delete(q.quoteId);
  ctx.db.quote.insert({ quoteId: 0n, tableId, seatKey, name: me.name, suit, side, price, at: nowMs(ctx) });
}

// ---------- bots that live inside the module ----------

const COMBOS: number[] = (() => {
  const c: number[][] = [];
  for (let n = 0; n <= 12; n++) {
    c.push([]);
    for (let k = 0; k <= 12; k++) c[n].push(k === 0 ? 1 : k > n ? 0 : (c[n - 1]?.[k - 1] ?? 0) + (c[n - 1]?.[k] ?? 0));
  }
  return c.flat();
})();
function choose(n: number, k: number): number {
  return k < 0 || k > n ? 0 : COMBOS[n * 13 + k];
}

/** Probability that each suit is the goal suit, given only your own hand. */
function goalOdds(h: number[]): number[] {
  const p = [0, 0, 0, 0];
  let total = 0;
  for (let twelve = 0; twelve < 4; twelve++) {
    for (let eight = 0; eight < 4; eight++) {
      if (eight === twelve) continue;
      const counts = [10, 10, 10, 10];
      counts[twelve] = 12;
      counts[eight] = 8;
      let w = 1;
      for (let s = 0; s < 4; s++) w *= choose(counts[s], h[s]);
      p[PARTNER[twelve]] += w;
      total += w;
    }
  }
  return p.map(x => (total ? x / total : 0.25));
}

type View = {
  me: string;
  hand: number[];
  dealt: number[];
  cash: number;
  timeLeft: number;
  book: { bid: number; bidder: string; ask: number; asker: string }[];
  trades: { suit: number; price: number; buyer: string; seller: string }[];
  rnd: () => number;
};

function houseOrders(name: string, v: View): Order[] {
  const odds = goalOdds(v.dealt);
  // Tape: buying pressure per suit moves the estimate a little.
  const pressure = [0, 0, 0, 0];
  for (const tr of v.trades) pressure[tr.suit] += tr.price;
  const tapeTotal = pressure.reduce((a, b) => a + b, 0) || 1;
  const blended = odds.map((p, s) => name === 'tape' ? 0.5 * p + 0.5 * pressure[s] / tapeTotal : p);
  const value = blended.map(p => p * (GOAL_PAY + 14));
  const best = value.indexOf(Math.max(...value));
  const out: Order[] = [];
  const S = SUITS;
  const r = v.rnd;

  if (name === 'noise') {
    const s = Math.floor(r() * 4);
    const price = 2 + Math.floor(r() * 12);
    if (r() < 0.5) out.push({ type: 'bid', suit: S[s], price: Math.min(price, v.cash) });
    else if (v.hand[s] > 0) out.push({ type: 'ask', suit: S[s], price });
    if (r() < 0.15 && v.book[s].ask) out.push({ type: 'buy', suit: S[s] });
    return out;
  }
  if (name === 'hoarder') {
    const ask = v.book[best];
    if (ask.ask && ask.ask <= value[best] + 2 && ask.ask <= v.cash) out.push({ type: 'buy', suit: S[best] });
    else out.push({ type: 'bid', suit: S[best], price: Math.max(1, Math.min(v.cash, Math.round(value[best] + 1))) });
    for (let s = 0; s < 4; s++) {
      if (s === best || v.hand[s] === 0) continue;
      if (v.book[s].bid >= 2) { out.push({ type: 'sell', suit: S[s] }); break; }
      out.push({ type: 'ask', suit: S[s], price: Math.max(2, Math.round(value[s] + 2)) });
    }
    return out;
  }
  if (name === 'maker') {
    const s = Math.floor(r() * 4);
    const fair = value[s];
    const bid = Math.max(1, Math.floor(fair - 3));
    const ask = Math.max(bid + 1, Math.ceil(fair + 3));
    if (bid <= v.cash) out.push({ type: 'bid', suit: S[s], price: bid });
    if (v.hand[s] > 0) out.push({ type: 'ask', suit: S[s], price: ask });
    return out;
  }
  // bayes and tape: take mispriced quotes, otherwise lean on the best suit.
  for (let s = 0; s < 4; s++) {
    const b = v.book[s];
    if (b.ask && b.ask < value[s] - 1 && b.ask <= v.cash) return [{ type: 'buy', suit: S[s] }];
    if (b.bid && b.bid > value[s] + 1 && v.hand[s] > 0) return [{ type: 'sell', suit: S[s] }];
  }
  const s = r() < 0.6 ? best : Math.floor(r() * 4);
  const fair = value[s];
  if (r() < 0.5) out.push({ type: 'bid', suit: S[s], price: Math.max(1, Math.min(v.cash, Math.floor(fair - 2))) });
  else if (v.hand[s] > 0) out.push({ type: 'ask', suit: S[s], price: Math.max(1, Math.ceil(fair + 2)) });
  return out;
}

function hostedOrders(source: string, v: View): Order[] {
  const state = {
    you: v.me,
    hand: Object.fromEntries(SUITS.map((s, i) => [s, v.hand[i]])),
    dealt: Object.fromEntries(SUITS.map((s, i) => [s, v.dealt[i]])),
    cash: v.cash,
    timeLeft: v.timeLeft,
    book: Object.fromEntries(SUITS.map((s, i) => [s, { ...v.book[i] }])),
    trades: v.trades.map(tr => ({ ...tr, suit: SUITS[tr.suit] })),
    goalOdds: Object.fromEntries(SUITS.map((s, i) => [s, goalOdds(v.dealt)[i]])),
  };
  const fn = new Function('state', `"use strict";\n${source}\n; return typeof act === "function" ? act(state) : [];`);
  const out = fn(state);
  const list = Array.isArray(out) ? out : out ? [out] : [];
  return list.slice(0, 4).filter((o: any) => o && typeof o.type === 'string');
}

function runBots(ctx: Ctx, tableId: number): void {
  const tbl = ctx.db.figgieTable.tableId.find(tableId)!;
  const now = nowMs(ctx);
  const seats = [...ctx.db.seat.tableId.filter(tableId)];
  for (const s of ctx.random.shuffle(seats)) {
    if (s.kind === 'remote') continue;
    if (ctx.random() > (s.kind === 'hosted' ? 0.8 : 0.45)) continue;
    const fresh = ctx.db.seat.seatKey.find(s.seatKey)!;
    const h = ctx.db.hand.seatKey.find(s.seatKey)!;
    const book = SUITS.map(suit => {
      const b = bestQuote(ctx, tableId, suit, 'bid', s.seatKey);
      const a = bestQuote(ctx, tableId, suit, 'ask', s.seatKey);
      return { bid: b?.price ?? 0, bidder: b?.name ?? '', ask: a?.price ?? 0, asker: a?.name ?? '' };
    });
    const trades = [...ctx.db.trade.tableId.filter(tableId)]
      .filter(tr => tr.roundNo === tbl.roundNo)
      .map(tr => ({ suit: SUITS.indexOf(tr.suit as Suit), price: tr.price, buyer: tr.buyer, seller: tr.seller }));
    const view: View = {
      me: s.name, hand: handArr(h), dealt: JSON.parse(h.dealt), cash: fresh.cash, timeLeft: Math.max(0, tbl.endsAt - now) / 1000,
      book, trades, rnd: () => ctx.random(),
    };
    let orders: Order[] = [];
    try {
      if (s.kind === 'hosted') orders = hostedOrders(ctx.db.hosted.name.find(s.name)?.source ?? '', view);
      else orders = houseOrders(s.name, view);
    } catch {
      bumpRejects(ctx, s.name);
      continue;
    }
    for (const order of orders) {
      try {
        place(ctx, tableId, s.seatKey, order);
      } catch {
        if (s.kind === 'hosted') bumpRejects(ctx, s.name);
      }
    }
  }
}

function bumpRejects(ctx: Ctx, name: string): void {
  const p = ctx.db.player.name.find(name);
  if (p) ctx.db.player.name.update({ ...p, rejects: p.rejects + 1 });
}

// ---------- the bell ----------

function expected(a: number, b: number): number {
  return 1 / (1 + 10 ** ((b - a) / 400));
}

function settle(ctx: Ctx, tableId: number): void {
  const now = nowMs(ctx);
  const tbl = ctx.db.figgieTable.tableId.find(tableId)!;
  const d = ctx.db.dealer.tableId.find(tableId)!;
  const seats = [...ctx.db.seat.tableId.filter(tableId)].sort((a, b) => a.seat - b.seat);
  const hands = seats.map(s => ctx.db.hand.seatKey.find(s.seatKey)!);
  const goal = d.goal;
  const goalCount = Number(d.counts.split(',')[goal]);
  const goalHeld = hands.map(h => held(h, goal));
  const most = Math.max(...goalHeld);
  const leaders = seats.map((_, i) => i).filter(i => goalHeld[i] === most);
  const bonusPot = POT - GOAL_PAY * goalCount;
  const share = Math.floor(bonusPot / leaders.length);
  const tape = [...ctx.db.trade.tableId.filter(tableId)].filter(tr => tr.roundNo === tbl.roundNo).sort((a, b) => a.at - b.at);
  const edges = seats.map(() => 0);
  const idx = (name: string) => seats.findIndex(s => s.name === name);
  for (const tr of tape) {
    const v = SUITS.indexOf(tr.suit as Suit) === goal ? GOAL_PAY : 0;
    const b = idx(tr.buyer), s = idx(tr.seller);
    if (b >= 0) edges[b] += v - tr.price;
    if (s >= 0) edges[s] += tr.price - v;
  }
  const starts: number[][] = JSON.parse(d.startHands);
  const pnl = seats.map((s, i) => {
    const payout = goalHeld[i] * GOAL_PAY + (leaders.includes(i) ? share : 0);
    return s.cash + payout - START_CASH;
  });
  const rows = seats.map(s => ctx.db.player.name.find(s.name)!);
  const n = seats.length;
  const deltas = rows.map((row, i) => {
    let total = 0;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const sc = pnl[i] === pnl[j] ? 0.5 : pnl[i] > pnl[j] ? 1 : 0;
      total += sc - expected(row.elo, rows[j].elo);
    }
    return (row.rounds < 30 ? 32 : 16) * total / (n - 1);
  });
  const top = Math.max(...pnl);
  const results = seats.map((s, i) => ({
    name: s.name,
    kind: s.kind,
    start: starts[i],
    end: handArr(hands[i]),
    cash: s.cash,
    goalCards: goalHeld[i],
    bonus: leaders.includes(i) ? share : 0,
    payout: goalHeld[i] * GOAL_PAY + (leaders.includes(i) ? share : 0),
    pnl: pnl[i],
    edge: edges[i],
    buys: s.buys,
    sells: s.sells,
    eloBefore: Math.round(rows[i].elo * 10) / 10,
    eloAfter: Math.round((rows[i].elo + deltas[i]) * 10) / 10,
  }));
  rows.forEach((row, i) => {
    ctx.db.player.name.update({
      ...row,
      elo: row.elo + deltas[i],
      rounds: row.rounds + 1,
      pnl: row.pnl + pnl[i],
      pnlSq: row.pnlSq + pnl[i] * pnl[i],
      bonuses: row.bonuses + (leaders.includes(i) ? 1 : 0),
      tops: row.tops + (pnl[i] === top ? 1 : 0),
      trades: row.trades + seats[i].buys + seats[i].sells,
      edge: row.edge + edges[i],
      goalCards: row.goalCards + goalHeld[i],
    });
  });
  ctx.db.roundResult.insert({
    resultId: 0n, tableId, roundNo: tbl.roundNo, startedAt: tbl.startedAt, endedAt: now,
    goal: SUITS[goal], twelve: SUITS[d.twelve], counts: d.counts,
    players: JSON.stringify(results),
    tape: JSON.stringify(tape.map(tr => [Math.round(tr.at - tbl.startedAt), tr.suit, tr.price, tr.buyer, tr.seller])),
    trades: tape.length,
    volume: tape.reduce((a, tr) => a + tr.price, 0),
  });
  for (const q of [...ctx.db.quote.tableId.filter(tableId)]) ctx.db.quote.quoteId.delete(q.quoteId);
  const winners = leaders.map(i => seats[i].name).join(' and ');
  ctx.db.figgieTable.tableId.update({
    ...tbl, phase: 'reveal', nextAt: now + BREAK_MS,
    goal: SUITS[goal], twelve: SUITS[d.twelve], counts: d.counts,
    lastTrade: `Goal suit was ${SUITS[goal]} (${goalCount} cards). ${winners} took the $${bonusPot} bonus.`,
  });
  pruneResults(ctx);
}

function pruneResults(ctx: Ctx): void {
  const all = [...ctx.db.roundResult.iter()];
  if (all.length <= KEEP_RESULTS) return;
  all.sort((a, b) => Number(a.resultId - b.resultId));
  for (const r of all.slice(0, all.length - KEEP_RESULTS)) ctx.db.roundResult.resultId.delete(r.resultId);
}

function step(ctx: Ctx): void {
  const ctl = control0(ctx);
  if (ctl.paused) return;
  const now = nowMs(ctx);
  const tables = [...ctx.db.figgieTable.iter()];
  if (!tables.length || tables.every(tb => tb.phase === 'reveal' && now >= tb.nextAt)) {
    deal(ctx);
    return;
  }
  for (const tb of tables) {
    if (tb.phase !== 'trading') continue;
    if (now >= tb.endsAt) settle(ctx, tb.tableId);
    else runBots(ctx, tb.tableId);
  }
}

// ---------- reducers ----------

export const tick = spacetimedb.reducer(
  { onSchedule: tickTimer },
  { timer: tickTimer.rowType },
  (ctx, _args) => {
    step(ctx);
  }
);

export const init = spacetimedb.init(ctx => {
  const now = nowMs(ctx);
  for (const name of HOUSE) {
    ctx.db.player.insert({
      name, owner: Identity.zero(), kind: 'house', elo: 1500, rounds: 0, pnl: 0, pnlSq: 0, bonuses: 0, tops: 0,
      trades: 0, edge: 0, goalCards: 0, rejects: 0, online: true, lastSeen: now, joinedAt: now, tableId: -1,
    });
  }
  ctx.db.control.insert({ id: 0, paused: false, roundNo: 0, admin: ctx.sender });
  ctx.db.tickTimer.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(TICK_MICROS) });
  deal(ctx);
});

function touch(ctx: Ctx, online?: boolean): void {
  for (const p of ctx.db.player.owner.filter(ctx.sender)) {
    if (p.kind !== 'remote') continue;
    ctx.db.player.name.update({ ...p, lastSeen: nowMs(ctx), online: online ?? p.online });
  }
}

export const onConnect = spacetimedb.clientConnected(ctx => touch(ctx, true));
export const onDisconnect = spacetimedb.clientDisconnected(ctx => touch(ctx, false));

function cleanName(name: string): string {
  const safe = String(name || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 24);
  if (!safe) throw new SenderError('pick a name made of letters, digits and _');
  if (HOUSE.includes(safe)) throw new SenderError(`${safe} is a house bot, pick another name`);
  return safe;
}

/** Claim a bot name for this connection's identity. Seated at the next deal. */
export const register = spacetimedb.reducer({ name: t.string() }, (ctx, { name }) => {
  const safe = cleanName(name);
  const now = nowMs(ctx);
  const existing = ctx.db.player.name.find(safe);
  if (existing) {
    if (!existing.owner.isEqual(ctx.sender)) throw new SenderError(`${safe} belongs to another identity`);
    ctx.db.player.name.update({ ...existing, online: true, lastSeen: now });
    return;
  }
  for (const p of ctx.db.player.owner.filter(ctx.sender)) {
    throw new SenderError(`this identity already plays as ${p.name}; one bot per identity`);
  }
  ctx.db.player.insert({
    name: safe, owner: ctx.sender, kind: 'remote', elo: 1500, rounds: 0, pnl: 0, pnlSq: 0, bonuses: 0, tops: 0,
    trades: 0, edge: 0, goalCards: 0, rejects: 0, online: true, lastSeen: now, joinedAt: now, tableId: -1,
  });
});

/** Keep an HTTP-only bot seated (WebSocket bots stay seated while connected). */
export const ready = spacetimedb.reducer(ctx => touch(ctx));

function mySeat(ctx: Ctx) {
  let me: ReturnType<typeof ctx.db.player.name.find> = null;
  for (const p of ctx.db.player.owner.filter(ctx.sender)) if (p.kind === 'remote') me = p;
  if (!me) throw new SenderError('call register(name) first');
  if (me.tableId < 0) throw new SenderError('not seated yet; you join at the next deal');
  const s = seatOf(ctx, me.tableId, me.name);
  if (!s) throw new SenderError('not seated yet; you join at the next deal');
  if (nowMs(ctx) - me.lastSeen > 5_000) ctx.db.player.name.update({ ...me, lastSeen: nowMs(ctx) });
  return s;
}

function guarded(ctx: Ctx, order: Order): void {
  const s = mySeat(ctx);
  place(ctx, s.tableId, s.seatKey, order);
}

export const bid = spacetimedb.reducer({ suit: t.string(), price: t.u32() }, (ctx, { suit, price }) => {
  guarded(ctx, { type: 'bid', suit, price });
});
export const ask = spacetimedb.reducer({ suit: t.string(), price: t.u32() }, (ctx, { suit, price }) => {
  guarded(ctx, { type: 'ask', suit, price });
});
export const buy = spacetimedb.reducer({ suit: t.string() }, (ctx, { suit }) => {
  guarded(ctx, { type: 'buy', suit });
});
export const sell = spacetimedb.reducer({ suit: t.string() }, (ctx, { suit }) => {
  guarded(ctx, { type: 'sell', suit });
});
/** Cancel your quotes. Empty suit = every suit; side is '', 'bid' or 'ask'. */
export const cancel = spacetimedb.reducer({ suit: t.string(), side: t.string() }, (ctx, { suit, side }) => {
  guarded(ctx, { type: 'cancel', suit: suit || undefined, side: side || undefined });
});

/** Your own hand (and nobody else's) while you are seated. */
export const myHand = spacetimedb.view({ name: 'my_hand', public: true }, t.array(hand.rowType), ctx =>
  ctx.from.hand.where(r => r.owner.eq(ctx.sender)).build()
);

/** Paste a JavaScript act(state) and the module runs it every tick, like a house bot. */
export const hostBot = spacetimedb.reducer({ name: t.string(), source: t.string() }, (ctx, { name, source }) => {
  const safe = cleanName(name);
  if (source.length < 8 || source.length > 8000) throw new SenderError('paste a short act(state) function');
  if (!/function\s+act\s*\(/.test(source) && !/act\s*=\s*\(/.test(source)) throw new SenderError('the code needs a function named act');
  try {
    new Function('state', `"use strict";\n${source}\n; return typeof act === "function" ? act : null;`);
  } catch (err) {
    throw new SenderError('that code does not parse: ' + String(err).slice(0, 120));
  }
  const now = nowMs(ctx);
  const existing = ctx.db.player.name.find(safe);
  if (existing && existing.kind !== 'hosted') throw new SenderError(`${safe} is taken`);
  if (existing && !existing.owner.isEqual(ctx.sender)) throw new SenderError(`${safe} belongs to another identity`);
  if (existing) ctx.db.player.name.update({ ...existing, lastSeen: now });
  else {
    ctx.db.player.insert({
      name: safe, owner: ctx.sender, kind: 'hosted', elo: 1500, rounds: 0, pnl: 0, pnlSq: 0, bonuses: 0, tops: 0,
      trades: 0, edge: 0, goalCards: 0, rejects: 0, online: true, lastSeen: now, joinedAt: now, tableId: -1,
    });
  }
  if (ctx.db.hosted.name.find(safe)) ctx.db.hosted.name.update({ name: safe, source });
  else ctx.db.hosted.insert({ name: safe, source });
});

/** Remove your bot (remote or hosted). */
export const leave = spacetimedb.reducer({ name: t.string() }, (ctx, { name }) => {
  const p = ctx.db.player.name.find(name);
  if (!p || p.kind === 'house') return;
  const ctl = control0(ctx);
  if (!p.owner.isEqual(ctx.sender) && !ctl.admin.isEqual(ctx.sender)) throw new SenderError('not your bot');
  ctx.db.player.name.delete(name);
  if (ctx.db.hosted.name.find(name)) ctx.db.hosted.name.delete(name);
});

export const setPaused = spacetimedb.reducer({ paused: t.bool() }, (ctx, { paused }) => {
  const ctl = control0(ctx);
  if (!ctl.admin.isEqual(ctx.sender)) throw new SenderError('only the arena owner can pause');
  ctx.db.control.id.update({ ...ctl, paused });
});
