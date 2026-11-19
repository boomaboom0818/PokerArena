// Figgie arena. Four or five bots, 40 cards, a $200 pot, 60 seconds of trading.
//
// Rules (Jane Street's Figgie):
//   * One suit has 12 cards, two have 10, one has 8. The goal suit is the suit of the
//     same colour as the 12-card suit, so it holds 8 or 10 cards.
//   * Everyone starts with $350 and antes an equal share of the $200 pot.
//     Four seats get 10 cards each; five seats get 8 cards each.
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
import { dealRandom } from '@pokerarena/shared/shuffle';
import { DECK_SIZE, POT, START_CASH, dealHands, tableSizes } from './seating';

const SUITS = ['spades', 'clubs', 'hearts', 'diamonds'] as const;
type Suit = (typeof SUITS)[number];
const PARTNER = [1, 0, 3, 2]; // same colour: spades<->clubs, hearts<->diamonds
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

// HTTP calls can emit connect/disconnect events too, so their explicit ready
// lease must survive disconnection; ordinary WebSocket seats don't get a lease.
const readyLease = table({ name: 'ready_lease' }, {
  name: t.string().primaryKey(),
  until: t.f64(),
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
  player, figgieTable, seat, hand, quote, trade, roundResult, dealer, hosted, readyLease, control, tickTimer,
}, { env: { FIGGIE_DEAL_KEY: t.string() } });
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
  if (Object.prototype.hasOwnProperty.call(short, s)) return short[s];
  throw new SenderError('unknown suit (use spades, clubs, hearts or diamonds)');
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
  const row = ctx.db.control.id.find(0);
  if (!row) throw new SenderError('arena control is not initialized');
  return row;
}

function eligibleUsers(ctx: Ctx, now: number): string[] {
  const out: string[] = [];
  for (const p of ctx.db.player.iter()) {
    if (p.kind === 'remote' && (p.online || (ctx.db.readyLease.name.find(p.name)?.until ?? 0) > now)) out.push(p.name);
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
  const eligible = eligibleUsers(ctx, now);
  const sizes = tableSizes(eligible.length);
  if (!sizes.length && !ctx.db.figgieTable.count()) return;
  const ctl = control0(ctx);
  const roundNo = ctl.roundNo + 1;
  if (sizes.length) ctx.db.control.id.update({ ...ctl, roundNo });
  clearTables(ctx);

  const random = dealRandom(ctx.env.FIGGIE_DEAL_KEY, `${ctx.databaseIdentity.toHexString()}:${roundNo}:${ctx.timestamp.microsSinceUnixEpoch}`);
  const tableCount = sizes.length;
  // Give anyone benched in the previous round first claim on an available seat.
  const wasSeated = new Set([...ctx.db.player.iter()].filter(p => p.tableId >= 0).map(p => p.name));
  const users = random.shuffle(eligible).sort((a,b) => Number(wasSeated.has(a)) - Number(wasSeated.has(b)));
  const seated = random.shuffle(users.slice(0, sizes.reduce((a,b) => a+b, 0)));
  const lineups = sizes.map(size => seated.splice(0, size));

  for (const p of [...ctx.db.player.iter()]) {
    if (p.tableId !== -1) ctx.db.player.name.update({ ...p, tableId: -1 });
  }
  for (const row of [...ctx.db.figgieTable.iter()]) {
    if (row.tableId >= tableCount) ctx.db.figgieTable.tableId.delete(row.tableId);
  }

  lineups.forEach((lineup, tableId) => {
    const order = random.shuffle([...lineup]);
    const twelve = random.index(4);
    const goal = PARTNER[twelve];
    const others = [0, 1, 2, 3].filter(s => s !== twelve);
    const eight = others[random.index(3)];
    const counts = [10, 10, 10, 10];
    counts[twelve] = 12;
    counts[eight] = 8;
    const deck: number[] = [];
    counts.forEach((n, s) => { for (let i = 0; i < n; i++) deck.push(s); });
    random.shuffle(deck);
    const starts = dealHands(deck, order.length);
    const ante = POT / order.length;
    order.forEach((name, i) => {
      const h = starts[i];
      const seatKey = tableId * 8 + i;
      const p = ctx.db.player.name.find(name)!;
      ctx.db.player.name.update({ ...p, tableId });
      ctx.db.seat.insert({
        seatKey, tableId, seat: i, name, kind: p.kind,
        cash: START_CASH - ante, cards: DECK_SIZE / order.length, buys: 0, sells: 0, actions: 0,
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

function runBots(ctx: Ctx, tableId: number): void {
  const tbl = ctx.db.figgieTable.tableId.find(tableId)!;
  const now = nowMs(ctx);
  const seats = [...ctx.db.seat.tableId.filter(tableId)];
  for (const s of ctx.random.shuffle(seats)) {
    if (s.kind !== 'house' || !HOUSE.includes(s.name) || ctx.random() > 0.45) continue;
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
      orders = houseOrders(s.name, view);
    } catch {
      bumpRejects(ctx, s.name);
      continue;
    }
    for (const order of orders) {
      try {
        place(ctx, tableId, s.seatKey, order);
      } catch {
        bumpRejects(ctx, s.name);
      }
    }
  }
}

function bumpRejects(ctx: Ctx, name: string): void {
  const p = ctx.db.player.name.find(name);
  if (p) ctx.db.player.name.update({ ...p, rejects: p.rejects + 1 });
}

// ---------- the bell ----------

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
  const bonusPot = tbl.pot - GOAL_PAY * goalCount;
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
  }));
  rows.forEach((row, i) => {
    ctx.db.player.name.update({
      ...row,
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
      name, owner: Identity.zero(), kind: 'house', rounds: 0, pnl: 0, pnlSq: 0, bonuses: 0, tops: 0,
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
    ctx.db.player.name.update({ ...p, lastSeen: online === false ? 0 : nowMs(ctx), online: online ?? p.online });
  }
}

export const onConnect = spacetimedb.clientConnected(ctx => touch(ctx, true));
export const onDisconnect = spacetimedb.clientDisconnected(ctx => touch(ctx, false));

function cleanName(name: string): string {
  const safe = name.toLowerCase();
  if (!/^[a-z0-9_]{1,24}$/.test(safe)) throw new SenderError('pick a name of 1–24 letters, digits and _');
  if (HOUSE.includes(safe)) throw new SenderError(`${safe} is a house bot, pick another name`);
  return safe;
}

function checkRegistration(ctx: Ctx): void {
  for (const p of ctx.db.player.owner.filter(ctx.sender)) {
    throw new SenderError(`this identity already plays as ${p.name}; one bot per identity`);
  }
  if (ctx.db.player.count() >= BigInt(HOUSE.length + 64)) throw new SenderError('arena registration is full');
}

/** Claim a bot name for this connection's identity. Seated at the next deal. */
export const register = spacetimedb.reducer({ name: t.string() }, (ctx, { name }) => {
  const safe = cleanName(name);
  const now = nowMs(ctx);
  const existing = ctx.db.player.name.find(safe);
  if (existing) {
    if (!existing.owner.isEqual(ctx.sender)) throw new SenderError('name already reserved');
    if (existing.kind === 'hosted') {
      if (existing.tableId >= 0 && ctx.db.figgieTable.tableId.find(existing.tableId)?.phase === 'trading') throw new SenderError('reconnect after the bell to convert this seat');
      ctx.db.hosted.name.delete(safe);
    }
    ctx.db.player.name.update({ ...existing, kind: 'remote', online: ctx.connectionId !== null, lastSeen: now });
    return;
  }
  checkRegistration(ctx);
  ctx.db.player.insert({
    name: safe, owner: ctx.sender, kind: 'remote', rounds: 0, pnl: 0, pnlSq: 0, bonuses: 0, tops: 0,
    trades: 0, edge: 0, goalCards: 0, rejects: 0, online: ctx.connectionId !== null, lastSeen: now, joinedAt: now, tableId: -1,
  });
});

/** Keep an HTTP-only bot seated (WebSocket bots stay seated while connected). */
export const ready = spacetimedb.reducer(ctx => {
  const now = nowMs(ctx);
  for (const p of ctx.db.player.owner.filter(ctx.sender)) {
    if (p.kind !== 'remote') continue;
    const lease = { name: p.name, until: now + ONLINE_GRACE_MS };
    if (ctx.db.readyLease.name.find(p.name)) ctx.db.readyLease.name.update(lease);
    else ctx.db.readyLease.insert(lease);
  }
});

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
  if (control0(ctx).paused) throw new SenderError('arena is paused');
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

/** Remove your bot. The old private hosted table is retained for migration only. */
export const leave = spacetimedb.reducer({ name: t.string() }, (ctx, { name }) => {
  const p = ctx.db.player.name.find(name);
  if (!p || p.kind === 'house') return;
  const ctl = control0(ctx);
  if (!p.owner.isEqual(ctx.sender) && !ctl.admin.isEqual(ctx.sender)) throw new SenderError('not your bot');
  if (p.tableId >= 0 && ctx.db.figgieTable.tableId.find(p.tableId)?.phase === 'trading') {
    throw new SenderError('wait for the bell before removing a seated bot');
  }
  ctx.db.player.name.delete(name);
  ctx.db.readyLease.name.delete(name);
  if (ctx.db.hosted.name.find(name)) ctx.db.hosted.name.delete(name);
});

export const setPaused = spacetimedb.reducer({ paused: t.bool() }, (ctx, { paused }) => {
  const ctl = control0(ctx);
  if (!ctl.admin.isEqual(ctx.sender)) throw new SenderError('only the arena owner can pause');
  ctx.db.control.id.update({ ...ctl, paused });
});
