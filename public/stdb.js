export const HOST = "https://maincloud.spacetimedb.com";
const DB = "poker-arena";
const HU_DB = "poker-heads-up";

function sql(query, db = DB, signal) {
  return fetch(HOST + "/v1/database/" + db + "/sql", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: query,
    signal,
  }).then(async (res) => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || res.statusText || "database offline");
    return data;
  });
}

function rows(result) {
  const first = Array.isArray(result) ? result[0] : result;
  const raw = (first && first.rows) || [];
  const names = ((first && first.schema && first.schema.elements) || [])
    .map((el) => (el.name && (el.name.some || el.name)) || "");
  return raw.map((row) => {
    if (!Array.isArray(row)) return row;
    const obj = {};
    names.forEach((name, i) => { obj[name] = row[i]; });
    return obj;
  });
}

const pickedTables = new Map();

export function pickTable(id, db = DB) {
  pickedTables.set(db, Number(id) || 0);
}

export async function liveTable(db = DB) {
  const [result, controls] = await Promise.all([sql("SELECT * FROM table_state", db), sql("SELECT paused FROM control", db)]);
  const all = rows(result).sort((a,b) => Number(a.table_id)-Number(b.table_id));
  const paused = rows(controls)[0]?.paused === true;
  if (!all.length) return { paused, playing: false, tables: 0, frame: { seats: [], board: [], pot: 0 } };
  const row = all.find((r) => Number(r.table_id) === pickedTables.get(db)) || all[0];
  const seats = JSON.parse(row.seats || "[]").map((s, i) => ({ ...s, seat: i, is_button: s.is_button ?? (i === 0) }));
  return {
    live: true,
    paused,
    playing: !paused,
    tables: all.length,
    tableIds: all.map(r => Number(r.table_id)),
    table: Number(row.table_id),
    names: String(row.names || "").split(",").filter(Boolean),
    hand_no: row.hand_no,
    hands_saved: row.hands_saved,
    frame: {
      type: "table",
      phase: row.phase,
      board: String(row.board || "").split(" ").filter(Boolean),
      pot: row.pot,
      actor: seats.find(s => s.bot === row.actor)?.seat ?? null,
      last: { kind: row.phase === 'result' ? 'result' : 'action', bot: row.log },
      log: row.log,
      seats,
    },
  };
}

export async function leaderboard(db = DB) {
  const [result, records] = await Promise.all([
    sql("SELECT * FROM standings", db),
    sql("SELECT * FROM hand_record", db).catch(() => []),
  ]);
  const record = new Map(rows(records).map((r) => [r.name, r]));
  const bots = rows(result).map((b) => {
    const rec = record.get(b.name);
    const played = rec ? Number(rec.played) : 0;
    return {
    bot: b.name,
    chips: Number(b.chips),
    // hands played, updated after every hand (standings.hands only moves when a match ends)
    hands: played,
    bb100: b.hands ? Math.round(Number(b.chips) / b.hands * 1000) / 10 : 0,
    stderr: 0,
    ci95: 0,
    vpip: 0,
    pfr: 0,
    af: 0,
    match_wins: 0,
    // share of hands won since tracking began; null until the bot finishes one
    win_rate: played ? Math.round(Number(rec.won) / played * 1000) / 10 : null,
    rank: 0,
  }; }).sort((a, b) => b.chips - a.chips || a.bot.localeCompare(b.bot));
  bots.forEach((b, i) => { b.rank = i + 1; });
  return { bots };
}

export const headsUpDb = HU_DB;

export async function arenaPreview(game, now = Date.now()) {
  const source = {
    "6-max": [DB, "SELECT phase, log FROM table_state"],
    "heads-up": [HU_DB, "SELECT phase, log FROM table_state"],
    figgie: ["figgie-arena", "SELECT phase, ends_at, next_at, last_trade FROM figgie_table"],
  }[game];
  const [db, query] = source;
  const signal = AbortSignal.timeout(8000);
  const [result, control] = await Promise.all([sql(query, db, signal), sql("SELECT paused FROM control", db, signal)]);
  if (rows(control)[0]?.paused) return { state: "paused", label: "Arena paused", note: "Tables are not running right now." };
  const tables = rows(result);
  const live = tables.filter(t => game === "figgie" ? t.phase === "trading" && t.ends_at > now : t.phase !== "result");
  const table = live.find(t => t.log || t.last_trade) || live[0];
  if (table) return { state: "live", label: `${live.length} ${game === "figgie" ? "trading" : "live"} ${live.length === 1 ? "table" : "tables"}`,
    note: table.log || table.last_trade || (game === "figgie" ? "Trading is open." : "A hand is in progress.") };
  const resultTable = tables.find(t => game === "figgie" ? t.phase === "reveal" && t.next_at > now : t.phase === "result");
  if (resultTable) return { state: "break", label: game === "figgie" ? "Between rounds" : "Between hands", note: resultTable.log || resultTable.last_trade };
  const seats = game === "6-max" ? "Six" : game === "heads-up" ? "Two" : "Four or five";
  return { state: "waiting", label: "Waiting for bots", note: `${seats} bots are needed to start a table.` };
}
