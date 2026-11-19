export const HOST = "https://maincloud.spacetimedb.com";
const DB = "poker-arena";
const HU_DB = "poker-heads-up";

function sql(query, db = DB) {
  return fetch(HOST + "/v1/database/" + db + "/sql", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: query,
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
  const result = await sql("SELECT * FROM standings", db);
  const bots = rows(result).map((b) => ({
    bot: b.name,
    elo: Math.round(b.elo * 10) / 10,
    matches: b.matches,
    hands: b.hands,
    bb100: b.hands ? Math.round(Number(b.chips) / b.hands * 1000) / 10 : 0,
    stderr: 0,
    ci95: 0,
    vpip: 0,
    pfr: 0,
    af: 0,
    match_wins: 0,
    rank: 0,
  })).sort((a, b) => b.elo - a.elo);
  bots.forEach((b, i) => { b.rank = i + 1; });
  return { bots };
}

export const headsUpDb = HU_DB;
