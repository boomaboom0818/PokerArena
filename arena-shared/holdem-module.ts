import { ScheduleAt } from 'spacetimedb';
import { schema, table, t, SenderError, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import { dealRandom } from './deal-random.ts';
import { STACK, HOUSE } from './holdem-cards.ts';
import { deal, act, observation, publicFrame, MATCH_HANDS, type Hand } from './holdem-engine.ts';

export function pokerArena(size: 2 | 6) {
  const houses = HOUSE.slice(0, size);
  // Keep the old row shape for a non-destructive upgrade. Legacy `elo` and `source` are frozen and never read;
  // standings rank by total chips won.
  const bot = table({ name: 'bot' }, { name: t.string().primaryKey(), elo: t.f64(), matches: t.u32(), hands: t.u32(), chips: t.i64(), source: t.string() });
  const botOwner = table({ name: 'bot_owner' }, { name: t.string().primaryKey(), owner: t.identity().unique() });
  const online = table({ name: 'online' }, { name: t.string().primaryKey(), connection: t.string().unique() });
  const tableState = table({ name: 'table_state', public: true }, {
    tableId: t.u32().primaryKey(), names: t.string(), handNo: t.u32(), phase: t.string(), board: t.string(), pot: t.i32(),
    actor: t.string(), log: t.string(), seats: t.string(), handsSaved: t.u32(),
  });
  const control = table({ name: 'control', public: true }, { id: t.u32().primaryKey(), paused: t.bool() });
  const tickTimer = table({ name: 'tick_timer' }, { scheduledId: t.u64().primaryKey().autoInc(), scheduledAt: t.scheduleAt() });
  const active = table({ name: 'active_match' }, { tableId: t.u32().primaryKey(), state: t.string() });
  const turn = table({ name: 'turn' }, { turnId: t.string().primaryKey(), owner: t.identity().unique(), tableId: t.u32().unique(), deadlineMs: t.f64(), observation: t.string() });
  const db = schema({ bot, botOwner, online, tableState, control, tickTimer, active, turn }, { env: { ARENA_ADMIN_ID: t.string(), POKER_DEAL_KEY: t.string() } });
  type Ctx = ReducerCtx<InferSchema<typeof db>>;
  type Match = { hand: Hand; nets: number[] };
  const now = (ctx: Ctx) => Number(ctx.timestamp.microsSinceUnixEpoch / 1000n);
  const paused = (ctx: Ctx) => ctx.db.control.id.find(0)?.paused !== false;
  const admin = (ctx: Ctx) => ctx.sender.toHexString() === ctx.env.ARENA_ADMIN_ID;
  const stats = (name: string) => ({ name, elo: 0, matches: 0, hands: 0, chips: 0n, source: '' });
  const standings = db.anonymousView({ public: true }, t.array(t.row('Standing', {
    name: t.string().primaryKey(), matches: t.u32(), hands: t.u32(), chips: t.i64(),
  })), ctx => [...ctx.db.bot.iter()].map(({ name, matches, hands, chips }) => ({ name, matches, hands, chips })));
  const myTurn = db.view({ name: 'my_turn', public: true }, t.array(turn.rowType), ctx => ctx.from.turn.where(r => r.owner.eq(ctx.sender)).build());

  function newHand(ctx: Ctx, tableId: number, names: string[], no: number) {
    const random = dealRandom(ctx.env.POKER_DEAL_KEY, `${ctx.databaseIdentity.toHexString()}:${ctx.timestamp.microsSinceUnixEpoch}:${tableId}:${no}`);
    return deal(names, no, random.shuffle(Array.from({length:52}, (_,i) => i)));
  }

  function record(ctx: Ctx, m: Match) {
    m.hand.seats.forEach((s,i) => {
      const row = ctx.db.bot.name.find(s.name)!;
      ctx.db.bot.name.update({ ...row, matches: row.matches+1, hands: row.hands+MATCH_HANDS, chips: row.chips+BigInt(m.nets[i]) });
    });
  }

  // Advance to the next connected player's decision or the end of the current hand.
  function advance(ctx: Ctx, tableId: number, m: Match) {
    const h = m.hand;
    while (!h.done) {
      const s = h.seats[h.actor], obs = observation(h);
      if (ctx.db.online.name.find(s.name)) {
        ctx.db.turn.insert({ turnId: ctx.newUuidV7().toString(), owner: ctx.db.botOwner.name.find(s.name)!.owner,
          tableId, deadlineMs: now(ctx)+10000, observation: JSON.stringify(obs) });
        break;
      }
      act(h, obs.to_call ? 'fold' : 'check');
    }
    if (h.done) {
      h.seats.forEach((s,i) => { m.nets[i] += s.stack-STACK; });
      if (h.no === MATCH_HANDS) record(ctx,m);
    }
    const old = ctx.db.tableState.tableId.find(tableId);
    const frame = { tableId, names: h.seats.map(s => s.name).join(','), ...publicFrame(h), handsSaved: (old?.handsSaved ?? 0)+Number(h.done) };
    if (old) ctx.db.tableState.tableId.update(frame); else ctx.db.tableState.insert(frame);
    const entry = { tableId, state: JSON.stringify(m) };
    if (ctx.db.active.tableId.find(tableId)) ctx.db.active.tableId.update(entry); else ctx.db.active.insert(entry);
  }

  function step(ctx: Ctx) {
    if (paused(ctx)) return;
    const occupied = new Set<number>(), seated = new Set<string>();
    const returning = new Set<string>();
    for (const row of [...ctx.db.active.iter()]) {
      const m: Match = JSON.parse(row.state), id = row.tableId, names = m.hand.seats.map(s => s.name);
      // Retire legacy house-filled matches, and never deal a new hand without every player.
      if (names.some(n => houses.includes(n)) || (m.hand.done && (m.hand.no === MATCH_HANDS || names.some(n => !ctx.db.online.name.find(n))))) {
        ctx.db.turn.tableId.delete(id);
        ctx.db.active.tableId.delete(id);
        names.forEach(n => returning.add(n));
        continue;
      }
      occupied.add(id); names.forEach(n => seated.add(n));
      if (m.hand.done) { m.hand = newHand(ctx,id,names,m.hand.no+1); advance(ctx,id,m); continue; }
      const p = ctx.db.turn.tableId.find(id)!;
      if (now(ctx) >= p.deadlineMs || !ctx.db.online.name.find(names[m.hand.actor])) {
        ctx.db.turn.turnId.delete(p.turnId);
        act(m.hand, observation(m.hand).to_call ? 'fold' : 'check');
        advance(ctx,id,m);
      }
    }
    const waiting = ctx.random.shuffle([...ctx.db.online.iter()].map(p => p.name).filter(n => !seated.has(n)))
      .sort((a,b) => Number(returning.has(a)) - Number(returning.has(b)));
    while (waiting.length >= size) {
      let id = 0; while (occupied.has(id)) id++;
      const names = waiting.splice(0,size);
      occupied.add(id);
      advance(ctx,id,{ hand: newHand(ctx,id,ctx.random.shuffle(names),1), nets: names.map(() => 0) });
    }
    for (const old of [...ctx.db.tableState.iter()]) if (!occupied.has(old.tableId)) ctx.db.tableState.tableId.delete(old.tableId);
  }

  const init = db.init(ctx => {
    for (const name of houses) ctx.db.bot.insert(stats(name));
    ctx.db.control.insert({ id:0, paused:false });
    ctx.db.tickTimer.insert({ scheduledId:0n, scheduledAt: ScheduleAt.interval(1_000_000n) });
    step(ctx);
  });
  const tick = db.reducer({ onSchedule: tickTimer }, { timer: tickTimer.rowType }, ctx => { step(ctx); });
  const register = db.reducer({ name:t.string() }, (ctx,{name}) => {
    const connection = ctx.connectionId?.toHexString();
    if (!connection) throw new SenderError('register over WebSocket');
    if (!/^[a-z0-9_]{1,24}$/.test(name) || houses.includes(name)) throw new SenderError('pick another bot name (1–24 lowercase letters, digits or _)');
    const owner = ctx.db.botOwner.name.find(name);
    if (owner ? !owner.owner.isEqual(ctx.sender) : ctx.db.bot.name.find(name)) throw new SenderError('name already reserved');
    if (!owner) {
      if (ctx.db.botOwner.owner.find(ctx.sender)) throw new SenderError('one bot per identity');
      if (ctx.db.botOwner.count() >= 64n) throw new SenderError('arena registration is full');
      ctx.db.botOwner.insert({ name, owner:ctx.sender }); ctx.db.bot.insert(stats(name));
    }
    if (ctx.db.online.name.find(name)) ctx.db.online.name.update({name,connection}); else ctx.db.online.insert({name,connection});
  });
  const disconnect = db.clientDisconnected(ctx => {
    if (ctx.connectionId) ctx.db.online.connection.delete(ctx.connectionId.toHexString());
  });
  const submitAction = db.reducer({ turnId:t.string(), action:t.string(), raiseTo:t.u32() }, (ctx,args) => {
    if (paused(ctx)) throw new SenderError('arena is paused');
    const p = ctx.db.turn.owner.find(ctx.sender);
    if (!p || p.turnId !== args.turnId || now(ctx) >= p.deadlineMs) throw new SenderError('no matching open turn');
    const m: Match = JSON.parse(ctx.db.active.tableId.find(p.tableId)!.state);
    if (ctx.db.online.name.find(m.hand.seats[m.hand.actor].name)?.connection !== ctx.connectionId?.toHexString()) throw new SenderError('register this connection first');
    try { act(m.hand,args.action,args.raiseTo); } catch (e) { throw new SenderError((e as Error).message); }
    ctx.db.turn.turnId.delete(p.turnId); advance(ctx,p.tableId,m);
  });
  const setPaused = db.reducer({paused:t.bool()}, (ctx,{paused}) => {
    if (!admin(ctx)) throw new SenderError('arena admin required');
    const old = ctx.db.control.id.find(0)!;
    if (old.paused && !paused) for (const p of [...ctx.db.turn.iter()]) ctx.db.turn.turnId.update({...p, deadlineMs:now(ctx)+10000});
    ctx.db.control.id.update({...old, paused});
  });
  const removeBot = db.reducer({name:t.string()}, (ctx,{name}) => {
    if (houses.includes(name) || (!admin(ctx) && !ctx.db.botOwner.name.find(name)?.owner.isEqual(ctx.sender))) throw new SenderError('not your bot');
    for (const r of ctx.db.active.iter()) if ((JSON.parse(r.state) as Match).hand.seats.some(s => s.name === name)) throw new SenderError('disconnect and wait for the match to finish');
    ctx.db.online.name.delete(name); ctx.db.botOwner.name.delete(name); ctx.db.bot.name.delete(name);
  });
  return { db, init, tick, register, disconnect, submitAction, setPaused, removeBot, standings, myTurn };
}
