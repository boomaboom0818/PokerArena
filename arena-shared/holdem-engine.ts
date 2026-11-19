import { BB, SB, STACK, evaluate, cardStr } from './holdem-cards.ts';

export const MATCH_HANDS = 6;
const STREETS = ['preflop', 'flop', 'turn', 'river'];
type Seat = { name: string; hole: number[]; stack: number; bet: number; paid: number; folded: boolean; actedAt: number };
type Event = { seq: number; street: number; seat: number; kind: string; amount: number; to_total: number; pot_before: number;
  to_call: number; stack_before: number; min_raise_to: number; max_raise_to: number; num_active: number; all_in: number };
export type Hand = { no: number; button: number; seats: Seat[]; runout: number[]; street: number; current: number;
  lastRaise: number; actor: number; done: boolean; log: string; history: Event[] };

export const pot = (h: Hand) => h.seats.reduce((sum, s) => sum + s.paid, 0);
export const board = (h: Hand) => h.runout.slice(0, [0, 3, 4, 5][h.street]);
const position = (h: Hand, i: number) => (h.seats.length === 2 ? ['BTN', 'BB'] : ['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO'])[(i - h.button + h.seats.length) % h.seats.length];

function legal(h: Hand, i: number) {
  const s = h.seats[i], max = s.bet + s.stack;
  return { to_call: h.current - s.bet, min_raise_to: Math.min(max, h.current + h.lastRaise), max_raise_to: max,
    can_raise: max > h.current && (s.actedAt < 0 || h.current - s.actedAt >= h.lastRaise) &&
      h.seats.some((o, j) => j !== i && !o.folded && o.stack > 0) };
}

function pay(h: Hand, i: number, kind: string, amount: number) {
  const s = h.seats[i], l = legal(h, i);
  h.history.push({ seq: h.history.length, street: h.street, seat: i, kind, amount, to_total: s.bet + amount,
    pot_before: pot(h), to_call: l.to_call, stack_before: s.stack, min_raise_to: l.min_raise_to, max_raise_to: l.max_raise_to,
    num_active: h.seats.filter(p => !p.folded).length, all_in: Number(s.stack === amount) });
  s.stack -= amount; s.bet += amount; s.paid += amount;
}

export function deal(names: string[], no: number, deck: number[]): Hand {
  const n = names.length, button = (no - 1) % n;
  const sb = n === 2 ? button : (button + 1) % n, bb = (sb + 1) % n;
  const h: Hand = { no, button, seats: names.map((name, i) => ({ name, hole: deck.slice(i*2, i*2+2), stack: STACK, bet: 0, paid: 0, folded: false, actedAt: -1 })),
    runout: deck.slice(2*n, 2*n+5), street: 0, current: 0, lastRaise: BB, actor: (bb + 1) % n, done: false, history: [], log: 'Blinds posted' };
  pay(h, sb, 'sb', SB); h.current = SB; pay(h, bb, 'bb', BB); h.current = BB;
  return h;
}

export function observation(h: Hand) {
  const i = h.actor, s = h.seats[i], n = h.seats.length;
  return { hand_no: h.no, seat: i, n_players: n, button: h.button, position: position(h, i), pos_idx: (i-h.button+n)%n,
    street: h.street, hole: s.hole, board: board(h), pot: pot(h), stack: s.stack, bet: s.bet, ...legal(h, i),
    small_blind: SB, big_blind: BB, history: h.history,
    players: h.seats.map((p, seat) => ({ seat, name: p.name, stack: p.stack, bet: p.bet, folded: p.folded, all_in: !p.stack, position: position(h, seat) })) };
}

function finish(h: Hand) {
  const n = h.seats.length, live = h.seats.filter(s => !s.folded);
  const scores = h.seats.map(s => s.folded ? -1 : live.length === 1 ? 0 : evaluate([...s.hole, ...h.runout]));
  const wins = h.seats.map(() => 0);
  let prev = 0;
  for (const level of [...new Set(h.seats.map(s => s.paid))].sort((a,b) => a-b)) {
    if (!level) continue;
    const inPot = h.seats.map((s,i) => s.paid >= level ? i : -1).filter(i => i >= 0);
    const amount = (level-prev)*inPot.length; prev = level;
    const eligible = inPot.filter(i => !h.seats[i].folded);
    if (!eligible.length) { for (const i of inPot) wins[i] += amount / inPot.length; continue; }
    const best = Math.max(...eligible.map(i => scores[i]));
    const winners = eligible.filter(i => scores[i] === best).sort((a,b) => ((a-h.button-1+n)%n)-((b-h.button-1+n)%n));
    winners.forEach((i,j) => { wins[i] += Math.floor(amount/winners.length) + Number(j < amount%winners.length); });
  }
  for (let i = 0; i < n; i++) h.seats[i].stack += wins[i];
  h.done = true; h.actor = -1;
  h.log = wins.map((w,i) => w ? `${h.seats[i].name} wins $${w}` : '').filter(Boolean).join(' · ');
}

export function act(h: Hand, kind: string, raiseTo = 0) {
  if (h.done) throw new Error('hand is over');
  const i = h.actor, s = h.seats[i], l = legal(h,i), n = h.seats.length;
  if (kind === 'raise' && (!l.can_raise || !Number.isInteger(raiseTo) || raiseTo < l.min_raise_to || raiseTo > l.max_raise_to)) throw new Error('illegal raise-to amount');
  if (kind === 'check' && l.to_call) throw new Error('cannot check facing a bet');
  if (!['check','fold','call','raise'].includes(kind)) throw new Error('expected check, fold, call or raise');
  if (kind === 'call' && !l.to_call) kind = 'check';
  const amount = kind === 'call' ? Math.min(s.stack, l.to_call) : kind === 'raise' ? raiseTo-s.bet : 0;
  pay(h,i,kind,amount);
  if (kind === 'raise') { h.lastRaise = Math.max(h.lastRaise, raiseTo-h.current); h.current = raiseTo; }
  if (kind === 'fold') s.folded = true;
  s.actedAt = h.current;
  h.log = `${s.name} ${kind === 'raise' ? 'raises to $'+raiseTo : kind+'s'}`;
  if (h.seats.filter(p => !p.folded).length === 1) return finish(h);
  let cursor = (i+1)%n;
  for (;;) {
    const stacks = h.seats.filter(p => !p.folded && p.stack > 0).length;
    for (let k=0;k<n;k++) {
      const j=(cursor+k)%n, p=h.seats[j];
      if (!p.folded && p.stack && (p.bet < h.current || (p.actedAt < 0 && stacks > 1))) { h.actor=j; return; }
    }
    if (h.street === 3) return finish(h);
    h.street++; h.current=0; h.lastRaise=BB; cursor=(h.button+1)%n;
    h.seats.forEach(p => { p.bet=0; p.actedAt=-1; });
  }
}

export function publicFrame(h: Hand) {
  return { handNo: h.no, phase: h.done ? 'result' : STREETS[h.street], board: board(h).map(cardStr).join(' '), pot: pot(h),
    actor: h.done ? '' : h.seats[h.actor].name, log: h.log, seats: JSON.stringify(h.seats.map((s,i) => ({
      bot: s.name, stack: s.stack, bet: h.done ? 0 : s.bet, folded: s.folded, position: position(h,i), is_button: i === h.button,
      hole: h.done ? s.hole.map(cardStr) : ['??','??'], ...(h.done ? { net: s.stack-STACK } : {}),
    }))) };
}
