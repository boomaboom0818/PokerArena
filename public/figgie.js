// Figgie spectator page. Reads the figgie-arena SpacetimeDB database over the same
// WebSocket protocol a bot uses, so what you see is exactly what the bots see
// (plus the hands, which are published at the bell).

import { HOST as HTTP_HOST } from "./stdb.js?v=8";
const WS_HOST = HTTP_HOST.replace(/^https:/, "wss:");
const DB = "figgie-arena";
const PROTOCOL = "v1.json.spacetimedb";

const SUITS = ["spades", "clubs", "hearts", "diamonds"];
const GLYPH = { spades: "♠", clubs: "♣", hearts: "♥", diamonds: "♦" };
const SUIT_COLOR = { spades: "#c9d3e0", clubs: "#7dcea0", hearts: "#e8705f", diamonds: "#e4b24a" };
const ROUND_S = 60;
const START_CASH = 350;
const POT = 200;

// Initial rows arrive as objects, later updates as arrays in column order.
const COLUMNS = {
  player: ["name", "owner", "kind", "rounds", "pnl", "pnl_sq", "bonuses", "tops", "trades",
    "edge", "goal_cards", "rejects", "online", "last_seen", "joined_at", "table_id"],
  figgie_table: ["table_id", "round_no", "phase", "started_at", "ends_at", "next_at", "pot", "goal",
    "twelve", "counts", "names", "last_trade"],
  seat: ["seat_key", "table_id", "seat", "name", "kind", "cash", "cards", "buys", "sells", "actions"],
  quote: ["quote_id", "table_id", "seat_key", "name", "suit", "side", "price", "at"],
  trade: ["trade_id", "table_id", "round_no", "suit", "price", "buyer", "seller", "at"],
};
const KEYS = { player: "name", figgie_table: "table_id", seat: "seat_key", quote: "quote_id", trade: "trade_id" };

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => (n > 0 ? "+" : n < 0 ? "−" : "") + "$" + Math.abs(Math.round(n)).toLocaleString();
const suitTag = (s, extra = "") => SUITS.includes(s) ? `<span class="sg sg-${s}${extra}" title="${s}">${GLYPH[s]}</span>` : "?";

const fg = {
  ws: null,
  cache: {},
  table: 0,
  skew: 0,
  active: false,
  clock: null,
  queued: false,
  failures: 0,
  poll: null,
  results: [],
  resultsAt: 0,
  lastPhase: "",
  sortKey: "pnl",
  sortDir: -1,
  selected: null,
  replay: { result: null, frames: [], index: 0, timer: null },
};

// ---------------------------------------------------------------- data

function sql(query) {
  return fetch(`${HTTP_HOST}/v1/database/${DB}/sql`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: query,
  }).then(async (res) => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || res.statusText || "database offline");
    const first = Array.isArray(data) ? data[0] : data;
    const names = ((first && first.schema && first.schema.elements) || []).map((el) => (el.name && (el.name.some || el.name)) || "");
    return ((first && first.rows) || []).map((row) => (Array.isArray(row) ? Object.fromEntries(names.map((n, i) => [n, row[i]])) : row));
  });
}

function decode(table, raw) {
  const row = JSON.parse(raw);
  return Array.isArray(row) ? Object.fromEntries(COLUMNS[table].map((c, i) => [c, row[i]])) : row;
}

function apply(tables) {
  const now = Date.now();
  for (const tbl of tables || []) {
    const name = tbl.table_name;
    if (!COLUMNS[name]) continue;
    const rows = fg.cache[name] || (fg.cache[name] = new Map());
    for (const upd of tbl.updates || []) {
      for (const raw of upd.deletes || []) rows.delete(decode(name, raw)[KEYS[name]]);
      for (const raw of upd.inserts || []) {
        const row = decode(name, raw);
        rows.set(row[KEYS[name]], row);
        if (row.at) fg.skew = Math.max(fg.skew * 0.98, row.at - now); // keep the freshest server clock reading
      }
    }
  }
}

const all = (name) => [...(fg.cache[name] || new Map()).values()];
const serverNow = () => Date.now() + fg.skew;

function connect() {
  if (fg.ws || !fg.active) return;
  let ws;
  try {
    ws = new WebSocket(`${WS_HOST}/v1/database/${DB}/subscribe`, PROTOCOL);
  } catch (err) {
    return fallBack(err);
  }
  fg.ws = ws;
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.IdentityToken) {
      ws.send(JSON.stringify({ Subscribe: {
        query_strings: ["SELECT * FROM figgie_table", "SELECT * FROM seat", "SELECT * FROM quote", "SELECT * FROM trade", "SELECT * FROM player"],
        request_id: 1,
      } }));
    } else if (msg.InitialSubscription) {
      fg.cache = {};
      apply(msg.InitialSubscription.database_update.tables);
      fg.failures = 0;
      stopPoll();
      setStatus("Live", true);
      queue();
    } else if (msg.TransactionUpdateLight) {
      apply(msg.TransactionUpdateLight.update.tables);
      queue();
    } else if (msg.TransactionUpdate && msg.TransactionUpdate.status && msg.TransactionUpdate.status.Committed) {
      apply(msg.TransactionUpdate.status.Committed.tables);
      queue();
    }
  };
  ws.onclose = () => {
    fg.ws = null;
    if (!fg.active) return;
    fg.failures += 1;
    if (fg.failures >= 3) fallBack(new Error("WebSocket closed"));
    setTimeout(connect, Math.min(10000, 800 * 2 ** fg.failures));
  };
}

// If the WebSocket is blocked, read the same tables over HTTP once a second.
function fallBack() {
  if (fg.poll || !fg.active) return;
  const pull = async () => {
    try {
      const names = Object.keys(COLUMNS);
      const res = await Promise.all(names.map((n) => sql(`SELECT * FROM ${n}`)));
      fg.cache = {};
      names.forEach((n, i) => { fg.cache[n] = new Map(res[i].map((r) => [r[KEYS[n]], r])); });
      setStatus("Live (polling)", true);
      queue();
    } catch (err) {
      setStatus("Arena offline", false);
      $("#fg-log").textContent = err.message;
    }
  };
  pull();
  fg.poll = setInterval(pull, 1000);
}
function stopPoll() {
  clearInterval(fg.poll);
  fg.poll = null;
}

async function loadResults(extra = 40) {
  const tables = all("figgie_table");
  const top = Math.max(0, ...tables.map((t) => t.round_no));
  const rows = await sql(`SELECT * FROM round_result WHERE round_no >= ${Math.max(0, top - extra)}`);
  // Replays contain historical JSON strings rather than typed database columns.
  // Validate before interpolating counts into HTML or expanding the trade tape.
  const counts = h => Array.isArray(h) && h.length === 4 && h.every(n => Number.isInteger(n) && n >= 0 && n <= 12);
  const numeric = ['cash', 'goalCards', 'bonus', 'payout', 'pnl', 'edge', 'buys', 'sells'];
  return rows.filter(r => {
    try {
      r.playersParsed = JSON.parse(r.players);
      r.tapeParsed = JSON.parse(r.tape);
      return SUITS.includes(r.goal) && SUITS.includes(r.twelve) &&
        Array.isArray(r.playersParsed) && [4, 5].includes(r.playersParsed.length) && r.playersParsed.every(p =>
          typeof p.name === 'string' && typeof p.kind === 'string' && counts(p.start) && counts(p.end) && numeric.every(k => Number.isFinite(p[k]))) &&
        Array.isArray(r.tapeParsed) && r.tapeParsed.length <= 900 * r.playersParsed.length && r.tapeParsed.every(t => Array.isArray(t) &&
          Number.isFinite(t[0]) && SUITS.includes(t[1]) && Number.isInteger(t[2]) && t[2] > 0 && t[2] <= 400 && typeof t[3] === 'string' && typeof t[4] === 'string');
    } catch { return false; }
  }).sort((a, b) => b.round_no - a.round_no || a.table_id - b.table_id);
}

async function refreshResults() {
  try {
    fg.results = await loadResults();
    fg.resultsAt = Date.now();
    renderRounds();
    renderReveal();
    renderFelt();
  } catch (err) {
    $("#fg-rounds").innerHTML = `<p class="muted">${esc(err.message)}</p>`;
  }
}

// ---------------------------------------------------------------- render

function setStatus(text, ok) {
  $("#fg-dot").classList.toggle("paused", !ok);
  $("#fg-dot").dataset.state = text;
}

function queue() {
  if (fg.queued) return;
  fg.queued = true;
  requestAnimationFrame(() => {
    fg.queued = false;
    render();
  });
}

function current() {
  const tables = all("figgie_table").sort((a, b) => a.table_id - b.table_id);
  const tbl = tables.find((t) => t.table_id === fg.table) || tables[0];
  return { tables, tbl };
}

function render() {
  const { tables, tbl } = current();
  pickTables(tables);
  if (!tbl) {
    $("#fg-state").textContent = "Waiting for bots";
    $("#fg-meta").textContent = "No active tables";
    $("#fg-log").textContent = "A table starts when at least four bots are connected.";
    if (fg.lastPhase !== "waiting") {
      fg.lastPhase = "waiting";
      $("#fg-felt").replaceChildren();
      $("#fg-book tbody").replaceChildren();
      $("#fg-tape").replaceChildren();
      $("#fg-tape-count").textContent = "";
      renderChart($("#fg-chart"), []);
      if (!fg.results.length) refreshResults();
    }
    renderBoard();
    return;
  }
  if (tbl.phase !== fg.lastPhase) {
    if (tbl.phase === "reveal" || !fg.results.length) refreshResults();
    fg.lastPhase = tbl.phase;
  }
  renderHeader();
  renderFelt();
  renderBook();
  renderChart($("#fg-chart"), roundTrades(tbl).map((t) => [t.at - tbl.started_at, t.suit, t.price, t.buyer, t.seller]), {
    nowMs: tbl.phase === "trading" ? serverNow() - tbl.started_at : null,
    goal: tbl.goal,
  });
  renderTape();
  renderReveal();
  renderBoard();
}

function pickTables(tables) {
  const box = $("#fg-tables");
  const label = box.closest("label");
  label.hidden = tables.length < 2;
  if (Number(box.dataset.count) !== tables.length) {
    box.dataset.count = String(tables.length);
    box.innerHTML = tables.map((t) => `<option value="${t.table_id}">Table ${t.table_id + 1}</option>`).join("");
  }
  if (!tables.some((t) => t.table_id === fg.table) && tables[0]) fg.table = tables[0].table_id;
  box.value = String(fg.table);
}

function roundTrades(tbl) {
  return all("trade").filter((t) => t.table_id === tbl.table_id && t.round_no === tbl.round_no).sort((a, b) => a.at - b.at);
}

function clockText(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function renderHeader() {
  const { tables, tbl } = current();
  if (!tbl) return;
  const now = serverNow();
  const state = tbl.phase === "trading"
    ? `Round ${tbl.round_no} · trading · ${clockText(tbl.ends_at - now)} left`
    : `Round ${tbl.round_no} · bell · next deal in ${clockText(tbl.next_at - now)}`;
  $("#fg-state").textContent = state;
  const seats = all("seat").filter((s) => s.table_id === tbl.table_id);
  const remote = seats.filter((s) => s.kind === "remote").length;
  $("#fg-meta").textContent = `Table ${tbl.table_id + 1} of ${tables.length} · ${seats.length} seats` + (remote ? ` · ${remote} visiting bot${remote > 1 ? "s" : ""}` : " · house bots only");
  $("#fg-log").textContent = tbl.last_trade || "Cards are dealt. Waiting for the first trade.";
  const clock = $("#fg-clock");
  if (clock) {
    clock.textContent = tbl.phase === "trading" ? clockText(tbl.ends_at - now) : "Bell";
    const left = tbl.phase === "trading" ? Math.max(0, (tbl.ends_at - now) / (ROUND_S * 1000)) : 0;
    const ring = $("#fg-ring");
    if (ring) ring.style.setProperty("--left", String(left));
    clock.classList.toggle("hurry", tbl.phase === "trading" && tbl.ends_at - now < 10000);
  }
}

function resultFor(tbl) {
  return fg.results.find((r) => r.table_id === tbl.table_id && r.round_no === tbl.round_no);
}

function renderFelt() {
  const { tbl } = current();
  const root = $("#fg-felt");
  if (!tbl) return;
  const seats = all("seat").filter((s) => s.table_id === tbl.table_id).sort((a, b) => a.seat - b.seat);
  const trades = roundTrades(tbl);
  const quotes = all("quote").filter((q) => q.table_id === tbl.table_id);
  const result = tbl.phase === "reveal" ? resultFor(tbl) : null;
  const goal = tbl.goal;
  const counts = tbl.counts ? tbl.counts.split(",").map(Number) : null;
  root.classList.toggle("five-seats", seats.length === 5);
  const pos = ["n", "e", "s", "w", "extra"];
  const seatHtml = seats.map((s, i) => {
    const flow = Object.fromEntries(SUITS.map((x) => [x, 0]));
    for (const t of trades) {
      if (t.buyer === s.name) flow[t.suit] += 1;
      if (t.seller === s.name) flow[t.suit] -= 1;
    }
    const r = result && result.playersParsed.find((p) => p.name === s.name);
    const mine = quotes.filter((q) => q.name === s.name).sort((a, b) => SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit));
    const cells = SUITS.map((x, k) => {
      if (r) {
        return `<div class="fg-cell${x === goal ? " goal" : ""}">${suitTag(x)}<b>${r.end[k]}</b><small>dealt ${r.start[k]}</small></div>`;
      }
      const f = flow[x];
      return `<div class="fg-cell">${suitTag(x)}<b class="hidden-count">?</b><small class="${f > 0 ? "up" : f < 0 ? "down" : ""}">${f > 0 ? "+" + f : f < 0 ? "−" + -f : "·"}</small></div>`;
    }).join("");
    const pnl = r ? `<div class="fg-pnl ${r.pnl >= 0 ? "up" : "down"}">${money(r.pnl)}${r.bonus ? ` <span class="fg-bonus">bonus</span>` : ""}</div>` : "";
    const quoteLine = r ? `<div class="fg-quotes muted">${r.goalCards} goal · payout $${r.payout} · edge ${money(r.edge)}</div>`
      : `<div class="fg-quotes">${mine.map((q) => `<span class="q-${q.side === "bid" ? "bid" : "ask"}">${q.side === "bid" ? "bid" : "ask"} ${GLYPH[q.suit]} ${q.price}</span>`).join("") || '<span class="muted">no quotes</span>'}</div>`;
    return `<div class="fg-seat fg-${pos[i]}" data-bot="${esc(s.name)}">
      <div class="fg-seat-head"><span class="who">${esc(s.name)}</span><span class="kind kind-${esc(s.kind)}">${s.kind === "remote" ? "live" : esc(s.kind)}</span></div>
      <div class="fg-money"><span>$${s.cash}</span><span class="muted">${s.cards} cards · ${s.buys}B ${s.sells}S</span></div>
      <div class="fg-hand">${cells}</div>
      ${quoteLine}${pnl}
    </div>`;
  }).join("");
  const goalBox = goal
    ? `<div class="fg-goal revealed">Goal ${suitTag(goal)} <span>${esc(goal)}</span></div>
       <div class="fg-counts">${SUITS.map((x, k) => `<span class="${x === goal ? "goal" : ""}">${GLYPH[x]} ${counts ? counts[k] : "?"}</span>`).join("")}</div>`
    : `<div class="fg-goal">Goal suit <span class="muted">hidden</span></div><div class="fg-counts muted">12 · 10 · 10 · 8, order unknown</div>`;
  root.innerHTML = `${seatHtml}
    <div class="fg-center">
      <div class="fg-ring" id="fg-ring"><div class="fg-clock" id="fg-clock"></div></div>
      <div class="fg-pot">pot $${tbl.pot}</div>
      ${goalBox}
    </div>`;
  renderHeader();
}

function bookRows(tbl) {
  const quotes = all("quote").filter((q) => q.table_id === tbl.table_id);
  const trades = roundTrades(tbl);
  return SUITS.map((suit) => {
    const bids = quotes.filter((q) => q.suit === suit && q.side === "bid").sort((a, b) => b.price - a.price || a.at - b.at);
    const asks = quotes.filter((q) => q.suit === suit && q.side === "ask").sort((a, b) => a.price - b.price || a.at - b.at);
    const tr = trades.filter((t) => t.suit === suit);
    const avg = tr.length ? tr.reduce((a, t) => a + t.price, 0) / tr.length : 0;
    return { suit, bids, asks, tr, avg, last: tr.length ? tr[tr.length - 1].price : null };
  });
}

function renderBook() {
  const { tbl } = current();
  if (!tbl) return;
  const rows = bookRows(tbl);
  const totalAvg = rows.reduce((a, r) => a + r.avg, 0);
  $("#fg-book tbody").innerHTML = rows.map((r) => {
    const bid = r.bids[0], ask = r.asks[0];
    const share = totalAvg ? r.avg / totalAvg : 0;
    const depth = (list) => list.slice(1, 4).map((q) => q.price).join(" ");
    return `<tr class="${tbl.goal === r.suit ? "goal" : ""}">
      <td>${suitTag(r.suit)}</td>
      <td class="bid">${bid ? `<b>${bid.price}</b> <span class="muted">${esc(bid.name)}</span>${depth(r.bids) ? `<small class="muted"> · ${depth(r.bids)}</small>` : ""}` : '<span class="muted">—</span>'}</td>
      <td class="ask">${ask ? `<b>${ask.price}</b> <span class="muted">${esc(ask.name)}</span>${depth(r.asks) ? `<small class="muted"> · ${depth(r.asks)}</small>` : ""}` : '<span class="muted">—</span>'}</td>
      <td>${r.last ?? '<span class="muted">—</span>'}</td>
      <td>${r.tr.length}</td>
      <td><div class="implied"><span style="width:${Math.round(share * 100)}%;background:${SUIT_COLOR[r.suit]}"></span></div><small>${totalAvg ? Math.round(share * 100) + "%" : "—"}</small></td>
    </tr>`;
  }).join("");
}

function renderChart(svg, tape, opts = {}) {
  if (!svg) return;
  const W = 640, H = 220, L = 34, R = 10, T = 12, B = 24;
  const maxP = Math.min(400, Math.max(20, ...tape.map((t) => Number(t[2]) || 0))) * 1.1;
  const x = (ms) => L + (Math.max(0, Math.min(ROUND_S * 1000, ms)) / (ROUND_S * 1000)) * (W - L - R);
  const y = (p) => T + (1 - p / maxP) * (H - T - B);
  const grid = [];
  const step = maxP > 60 ? 20 : maxP > 30 ? 10 : 5;
  for (let p = 0; p <= maxP; p += step) {
    grid.push(`<line x1="${L}" x2="${W - R}" y1="${y(p)}" y2="${y(p)}" class="grid"/><text x="${L - 6}" y="${y(p) + 4}" class="tick" text-anchor="end">$${p}</text>`);
  }
  for (let s = 0; s <= ROUND_S; s += 15) grid.push(`<text x="${x(s * 1000)}" y="${H - 6}" class="tick" text-anchor="middle">${s}s</text>`);
  const lines = SUITS.map((suit) => {
    const pts = tape.filter((t) => t[1] === suit);
    if (!pts.length) return "";
    const dim = opts.goal && opts.goal !== suit ? " dim" : "";
    const path = pts.map((t, i) => `${i ? "L" : "M"}${x(t[0]).toFixed(1)},${y(t[2]).toFixed(1)}`).join("");
    const dots = pts.map((t) => `<circle cx="${x(t[0]).toFixed(1)}" cy="${y(t[2]).toFixed(1)}" r="3.2" fill="${SUIT_COLOR[suit]}"><title>${GLYPH[suit]} $${Number(t[2])} · ${esc(t[3])} from ${esc(t[4])}</title></circle>`).join("");
    return `<g class="series${dim}"><path d="${path}" stroke="${SUIT_COLOR[suit]}" fill="none" stroke-width="1.6"/>${dots}</g>`;
  }).join("");
  const now = opts.nowMs != null ? `<line x1="${x(opts.nowMs)}" x2="${x(opts.nowMs)}" y1="${T}" y2="${H - B}" class="now"/>` : "";
  const mark = opts.marker != null && tape[opts.marker]
    ? `<circle cx="${x(tape[opts.marker][0])}" cy="${y(tape[opts.marker][2])}" r="7" class="marker"/>` : "";
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = grid.join("") + now + lines + mark +
    (tape.length ? "" : `<text x="${W / 2}" y="${H / 2}" class="tick" text-anchor="middle">No trades yet</text>`);
}

function renderTape() {
  const { tbl } = current();
  if (!tbl) return;
  const trades = roundTrades(tbl).slice().reverse();
  $("#fg-tape").innerHTML = trades.slice(0, 80).map((t) => `
    <li><span class="muted">${clockText(t.at - tbl.started_at)}</span>
      <span><b>${esc(t.buyer)}</b> buys ${suitTag(t.suit)} from <b>${esc(t.seller)}</b></span>
      <span class="price">$${t.price}</span></li>`).join("") || `<li class="muted">No trades this round yet.</li>`;
  $("#fg-tape-count").textContent = trades.length ? `${trades.length} trades · $${trades.reduce((a, t) => a + t.price, 0)} traded` : "";
}

function resultTable(r) {
  const goal = r.goal;
  const counts = r.counts.split(",").map(Number);
  const head = `<p class="fg-result-head">Round ${r.round_no} · table ${r.table_id + 1} · goal ${suitTag(goal)} <b>${esc(goal)}</b> (${counts[SUITS.indexOf(goal)]} cards) · 12-card suit ${suitTag(r.twelve)} · ${r.trades} trades</p>`;
  const rows = r.playersParsed.slice().sort((a, b) => b.pnl - a.pnl).map((p) => `
    <tr>
      <td class="bot-name">${esc(p.name)} <span class="kind kind-${esc(p.kind)}">${p.kind === "remote" ? "live" : esc(p.kind)}</span></td>
      <td class="hand-cells">${SUITS.map((s, k) => `<span class="${s === goal ? "goal" : ""}">${GLYPH[s]}${p.start[k]}</span>`).join("")}</td>
      <td class="hand-cells">${SUITS.map((s, k) => `<span class="${s === goal ? "goal" : ""}">${GLYPH[s]}${p.end[k]}</span>`).join("")}</td>
      <td>${p.goalCards}</td>
      <td>${p.buys}/${p.sells}</td>
      <td>$${p.cash}</td>
      <td>$${p.payout}${p.bonus ? ` <span class="fg-bonus">+bonus</span>` : ""}</td>
      <td class="${p.edge >= 0 ? "up" : "down"}">${money(p.edge)}</td>
      <td class="${p.pnl >= 0 ? "up" : "down"}"><b>${money(p.pnl)}</b></td>
    </tr>`).join("");
  return `${head}<div class="table-wrap"><table class="board fg-results"><thead><tr>
    <th>Bot</th><th>Dealt</th><th>Final</th><th>Goal</th><th>B/S</th><th>Cash</th><th>Payout</th><th title="Trades valued at the truth: a goal card is worth $10, the rest $0">Edge</th><th>P&amp;L</th>
  </tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderReveal() {
  const { tbl } = current();
  const box = $("#fg-reveal");
  if (!tbl) return;
  const r = fg.results.find((x) => x.table_id === tbl.table_id && (tbl.phase === "reveal" ? x.round_no === tbl.round_no : x.round_no < tbl.round_no));
  const key = r ? `${r.round_no}-${r.table_id}-${tbl.phase}` : `none-${fg.results.length}`;
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  $("#fg-reveal-title").textContent = tbl.phase === "reveal" ? "The bell" : "Last round";
  box.innerHTML = r ? resultTable(r) : `<p class="muted">${fg.results.length ? "Waiting for this table's first bell." : "The first bell has not rung yet."}</p>`;
}

function renderRounds() {
  const list = $("#fg-rounds");
  if (!fg.results.length) {
    list.innerHTML = `<p class="muted">No finished rounds yet.</p>`;
    return;
  }
  list.innerHTML = fg.results.slice(0, 40).map((r) => {
    const best = r.playersParsed.slice().sort((a, b) => b.pnl - a.pnl)[0] || {};
    const key = `${r.round_no}-${r.table_id}`;
    return `<button type="button" class="hand-row${fg.replay.result && fg.replay.key === key ? " on" : ""}" data-key="${key}">
      <strong>#${r.round_no}</strong> table ${r.table_id + 1} · goal ${suitTag(r.goal)} · ${r.trades} trades
      <div class="muted">${esc(best.name)} ${money(best.pnl || 0)} · ${r.playersParsed.map((p) => esc(p.name)).join(" · ")}</div>
    </button>`;
  }).join("");
  $$(".hand-row", list).forEach((b) => b.addEventListener("click", () => openReplay(b.dataset.key)));
  if (!fg.replay.result && fg.results[0]) openReplay(`${fg.results[0].round_no}-${fg.results[0].table_id}`, false);
}

// ---------------------------------------------------------------- replay

function replayFrames(r) {
  const players = r.playersParsed;
  const goalIdx = SUITS.indexOf(r.goal);
  const hands = players.map((p) => [...p.start]);
  const ante = POT / players.length;
  const cash = players.map(() => START_CASH - ante);
  const edge = players.map(() => 0);
  const snap = (line, i) => ({ line, i, hands: hands.map((h) => [...h]), cash: [...cash], edge: [...edge] });
  const frames = [snap(`Cards dealt. Everyone antes $${ante}.`, null)];
  r.tapeParsed.forEach((t, i) => {
    const [ms, suit, price, buyer, seller] = t;
    const s = SUITS.indexOf(suit);
    const b = players.findIndex((p) => p.name === buyer);
    const se = players.findIndex((p) => p.name === seller);
    const value = s === goalIdx ? 10 : 0;
    if (b >= 0) { hands[b][s] += 1; cash[b] -= price; edge[b] += value - price; }
    if (se >= 0) { hands[se][s] -= 1; cash[se] += price; edge[se] += price - value; }
    const verdict = value - price > 0 ? `${buyer} gains $${value - price}` : value - price < 0 ? `${seller} gains $${price - value}` : "fair";
    frames.push(snap(`${clockText(ms)} · ${buyer} buys ${GLYPH[suit]} from ${seller} at $${price} · ${verdict}`, i));
  });
  const last = frames[frames.length - 1];
  frames.push({ ...last, line: `Bell · goal ${GLYPH[r.goal]} ${r.goal} · ` + players.slice().sort((a, b) => b.pnl - a.pnl).map((p) => `${p.name} ${money(p.pnl)}`).join(", "), final: true });
  return frames;
}

function openReplay(key, autoplay = true) {
  const r = fg.results.find((x) => `${x.round_no}-${x.table_id}` === key);
  if (!r) return;
  stopReplay();
  fg.replay = { result: r, key, frames: replayFrames(r), index: 0, timer: null };
  $$("#fg-rounds .hand-row").forEach((b) => b.classList.toggle("on", b.dataset.key === key));
  $("#fg-replay-title").innerHTML = `Round ${r.round_no} · table ${r.table_id + 1} · goal ${suitTag(r.goal)}`;
  showReplay(0);
  if (autoplay) playReplay();
}

function showReplay(index) {
  const rp = fg.replay;
  if (!rp.result) return;
  rp.index = Math.max(0, Math.min(index, rp.frames.length - 1));
  const f = rp.frames[rp.index];
  const r = rp.result;
  const goalIdx = SUITS.indexOf(r.goal);
  $("#fg-replay-log").textContent = f.line;
  const scrub = $("#fg-replay-scrub");
  scrub.max = String(rp.frames.length - 1);
  scrub.value = String(rp.index);
  const most = Math.max(...f.hands.map((h) => h[goalIdx]));
  const seats = $("#fg-replay-seats");
  seats.classList.toggle("five-seats", r.playersParsed.length === 5);
  seats.innerHTML = r.playersParsed.map((p, i) => {
    const t = f.i != null ? r.tapeParsed[f.i] : null;
    const role = t ? (t[3] === p.name ? " buying" : t[4] === p.name ? " selling" : "") : "";
    return `<div class="fg-rseat${role}">
      <div class="fg-seat-head"><span class="who">${esc(p.name)}</span>${f.hands[i][goalIdx] === most && most > 0 ? '<span class="fg-bonus">most goal</span>' : ""}</div>
      <div class="fg-hand">${SUITS.map((s, k) => `<div class="fg-cell${k === goalIdx ? " goal" : ""}">${suitTag(s)}<b>${f.hands[i][k]}</b></div>`).join("")}</div>
      <div class="fg-money"><span>$${f.cash[i]}</span><span class="${f.edge[i] >= 0 ? "up" : "down"}">edge ${money(f.edge[i])}</span></div>
      ${f.final ? `<div class="fg-pnl ${p.pnl >= 0 ? "up" : "down"}">${money(p.pnl)}</div>` : ""}
    </div>`;
  }).join("");
  renderChart($("#fg-replay-chart"), r.tapeParsed, { goal: r.goal, marker: f.i });
}

function stopReplay() {
  clearInterval(fg.replay.timer);
  fg.replay.timer = null;
  const b = $("#fg-replay-play");
  if (b) { b.textContent = "Play"; b.classList.remove("on"); }
}

function playReplay() {
  const rp = fg.replay;
  if (rp.timer) return stopReplay();
  if (rp.index >= rp.frames.length - 1) rp.index = 0;
  $("#fg-replay-play").textContent = "Pause";
  $("#fg-replay-play").classList.add("on");
  rp.timer = setInterval(() => {
    if (rp.index >= rp.frames.length - 1) return stopReplay();
    showReplay(rp.index + 1);
  }, 450);
}

// ---------------------------------------------------------------- leaderboard

function boardRows() {
  return all("player").map((p) => {
    const n = p.rounds || 0;
    const mean = n ? p.pnl / n : 0;
    const variance = n > 1 ? Math.max(0, p.pnl_sq / n - mean * mean) : 0;
    return {
      bot: p.name,
      kind: p.kind,
      rounds: n,
      pnl_rd: mean,
      ci95: n > 1 ? 1.96 * Math.sqrt(variance / n) : 0,
      bonus: n ? (100 * p.bonuses) / n : 0,
      goal_rd: n ? p.goal_cards / n : 0,
      trades_rd: n ? p.trades / n : 0,
      edge_tr: p.trades ? p.edge / p.trades : 0,
      pnl: p.pnl,
      status: p.table_id >= 0 ? `table ${p.table_id + 1}` : p.kind === "house" ? "bench" : p.online ? "waiting" : "offline",
    };
  });
}

function renderBoard() {
  const q = ($("#fg-filter").value || "").trim().toLowerCase();
  const rows = boardRows().sort((a, b) => b.pnl - a.pnl || a.bot.localeCompare(b.bot));
  rows.forEach((r, i) => { r.rank = i + 1; });
  const shown = rows.filter((r) => !q || r.bot.includes(q)).sort((a, b) => {
    const av = a[fg.sortKey], bv = b[fg.sortKey];
    return (typeof av === "string" ? av.localeCompare(bv) : av - bv) * fg.sortDir;
  });
  const html = shown.map((r) => `
    <tr data-bot="${esc(r.bot)}" class="${r.bot === fg.selected ? "selected" : ""}">
      <td>${r.rank}</td>
      <td class="bot-name">${esc(r.bot)} <span class="kind kind-${esc(r.kind)}">${r.kind === "remote" ? "live" : esc(r.kind)}</span></td>
      <td class="${r.pnl >= 0 ? "up" : "down"}">${money(r.pnl)}</td>
      <td>${r.rounds}</td>
      <td class="${r.pnl_rd >= 0 ? "up" : "down"}">${money(r.pnl_rd)}</td>
      <td>${r.ci95 ? "±" + r.ci95.toFixed(0) : "—"}</td>
      <td>${r.bonus.toFixed(0)}%</td>
      <td>${r.goal_rd.toFixed(1)}</td>
      <td>${r.trades_rd.toFixed(1)}</td>
      <td class="${r.edge_tr >= 0 ? "up" : "down"}">${r.edge_tr >= 0 ? "+" : "−"}$${Math.abs(r.edge_tr).toFixed(2)}</td>
      <td class="muted">${r.status}</td>
    </tr>`).join("") || `<tr><td colspan="11">No bots yet.</td></tr>`;
  const body = $("#fg-lb tbody");
  if (body.dataset.html !== html) {
    body.innerHTML = html;
    body.dataset.html = html;
    $$("tr[data-bot]", body).forEach((tr) => tr.addEventListener("click", () => selectBot(tr.dataset.bot)));
  }
  if (!fg.selected && rows[0]) selectBot(rows[0].bot);
}

async function selectBot(name) {
  fg.selected = name;
  $$("#fg-lb tbody tr[data-bot]").forEach((tr) => tr.classList.toggle("selected", tr.dataset.bot === name));
  const card = $("#fg-bot-card");
  const p = boardRows().find((r) => r.bot === name);
  card.innerHTML = `<h2>${esc(name)}</h2><p class="muted">Loading rounds…</p>`;
  let rounds = [];
  try {
    rounds = (await loadResults(240)).filter((r) => r.playersParsed.some((x) => x.name === name)).reverse();
  } catch (err) {
    card.innerHTML = `<h2>${esc(name)}</h2><p>${esc(err.message)}</p>`;
    return;
  }
  if (fg.selected !== name) return;
  const mine = rounds.map((r) => ({ r, me: r.playersParsed.find((x) => x.name === name) }));
  let run = 0;
  const curve = mine.map((m) => (run += m.me.pnl));
  const bySuit = { buys: 0, goalBuys: 0, sells: 0, goalSells: 0 };
  for (const { r } of mine) {
    for (const t of r.tapeParsed) {
      if (t[3] === name) { bySuit.buys++; if (t[1] === r.goal) bySuit.goalBuys++; }
      if (t[4] === name) { bySuit.sells++; if (t[1] === r.goal) bySuit.goalSells++; }
    }
  }
  const pct = (a, b) => (b ? Math.round((100 * a) / b) + "%" : "—");
  card.innerHTML = `
    <h2>${esc(name)} <span class="kind kind-${esc(p?.kind)}">${p?.kind === "remote" ? "live" : esc(p?.kind || "")}</span></h2>
    <p><b class="${(p?.pnl || 0) >= 0 ? "up" : "down"}">${money(p?.pnl || 0)}</b> total · ${p?.rounds || 0} rounds · ${money(p?.pnl_rd || 0)} a round</p>
    ${spark(curve)}
    <div class="fg-stats">
      <div class="stat"><b>${pct(bySuit.goalBuys, bySuit.buys)}</b><span>of buys were the goal suit</span></div>
      <div class="stat"><b>${pct(bySuit.goalSells, bySuit.sells)}</b><span>of sells were the goal suit</span></div>
      <div class="stat"><b>${p ? p.bonus.toFixed(0) : 0}%</b><span>rounds with the bonus</span></div>
    </div>
    <h2>Recent rounds</h2>
    ${mine.slice(-10).reverse().map(({ r, me }) => `
      <button type="button" class="script-line" data-key="${r.round_no}-${r.table_id}">#${r.round_no} · goal ${GLYPH[r.goal]} · held ${me.goalCards} ·
        <span class="${me.pnl >= 0 ? "up" : "down"}">${money(me.pnl)}</span> · edge ${money(me.edge)} · ${me.buys}B/${me.sells}S</button>`).join("") || "<p class='muted'>No finished rounds in the recent window.</p>"}
    <p class="muted">Click a round to replay it. Edge values each trade at the truth: a goal card is worth $10, any other card $0.</p>`;
  $$("button.script-line", card).forEach((b) => b.addEventListener("click", async () => {
    if (!fg.results.find((x) => `${x.round_no}-${x.table_id}` === b.dataset.key)) {
      const extra = rounds.find((x) => `${x.round_no}-${x.table_id}` === b.dataset.key);
      if (extra) fg.results.push(extra);
    }
    openReplay(b.dataset.key);
    $("#fg-replay").scrollIntoView({ behavior: "smooth", block: "start" });
  }));
}

function spark(values) {
  if (values.length < 2) return "";
  const w = 280, h = 72;
  const min = Math.min(0, ...values), max = Math.max(0, ...values);
  const sx = (i) => (i / (values.length - 1)) * (w - 8) + 4;
  const sy = (v) => h - 8 - ((v - min) / (max - min || 1)) * (h - 16);
  const pts = values.map((v, i) => `${sx(i)},${sy(v)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-label="Cumulative P&L"><line x1="4" x2="${w - 4}" y1="${sy(0)}" y2="${sy(0)}" stroke="#2c3428"/><polyline fill="none" stroke="#e4c27a" stroke-width="2" points="${pts}"></polyline></svg>`;
}

// ---------------------------------------------------------------- hosting

function bindOnce() {
  const root = $("#figgie");
  if (root.dataset.bound) return;
  root.dataset.bound = "1";
  $("#fg-tables").addEventListener("change", (ev) => {
    fg.table = Number(ev.target.value) || 0;
    fg.lastPhase = "";
    queue();
  });
  $("#fg-filter").addEventListener("input", () => { $("#fg-lb tbody").dataset.html = ""; renderBoard(); });
  $$("#fg-lb th").forEach((th) => th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (!key) return;
    fg.sortDir = fg.sortKey === key ? -fg.sortDir : key === "bot" || key === "rank" ? 1 : -1;
    fg.sortKey = key;
    $("#fg-lb tbody").dataset.html = "";
    renderBoard();
  }));
  $("#fg-felt").addEventListener("click", (ev) => {
    const seat = ev.target.closest("[data-bot]");
    if (seat) {
      selectBot(seat.dataset.bot);
      $("#fg-board-block").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
  $("#fg-replay-play").addEventListener("click", playReplay);
  $("#fg-replay-prev").addEventListener("click", () => { stopReplay(); showReplay(fg.replay.index - 1); });
  $("#fg-replay-next").addEventListener("click", () => { stopReplay(); showReplay(fg.replay.index + 1); });
  $("#fg-replay-scrub").addEventListener("input", (ev) => { stopReplay(); showReplay(Number(ev.target.value)); });
}

export function startFiggie() {
  bindOnce();
  if (fg.active) return;
  fg.active = true;
  fg.lastPhase = "";
  connect();
  fg.clock = setInterval(() => {
    renderHeader();
    const { tbl } = current();
    if (tbl && tbl.phase === "trading") {
      renderChart($("#fg-chart"), roundTrades(tbl).map((t) => [t.at - tbl.started_at, t.suit, t.price, t.buyer, t.seller]), {
        nowMs: serverNow() - tbl.started_at,
      });
    }
  }, 250);
}

export function stopFiggie() {
  fg.active = false;
  clearInterval(fg.clock);
  stopPoll();
  stopReplay();
  if (fg.ws) {
    const ws = fg.ws;
    fg.ws = null;
    ws.onclose = null;
    ws.close();
  }
}
