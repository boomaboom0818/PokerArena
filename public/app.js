import { headsUpDb, leaderboard as stdbBoard, liveTable, pickTable, arenaPreview } from "./stdb.js?v=6";
import { startFiggie, stopFiggie } from "./figgie.js?v=8";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const BUILTINS = ["tag", "lag", "nit", "equity", "equity_lag", "rock", "calling_station", "maniac", "random"];
const SEAT_POS = {
  2: [[50, 82], [50, 18]],
  6: [[50, 86], [14, 70], [14, 28], [50, 14], [86, 28], [86, 70]],
  9: [[50, 88], [20, 80], [8, 54], [16, 24], [38, 10], [62, 10], [84, 24], [92, 54], [80, 80]],
};

let leaderboard = [];
let sortKey = "chips";
let sortDir = -1;
let selectedBot = null;
let live = { table: 0, cursor: -1, timer: null };
let replay = { frames: [], index: 0, timer: null, id: null };
const showHoles = true;
let overviewTimer = null;
let overviewBusy = false;
let sixMaxReady = false;

function api(path, opts) {
  return fetch(path, opts).then(async (res) => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  });
}

function money(n) {
  const v = Number(n) || 0;
  return (v > 0 ? "+" : "") + v.toLocaleString();
}

function cardEl(code, large) {
  const el = document.createElement("div");
  const hidden = !code || code === "??";
  el.className = "card" + (large ? " lg" : "") + (hidden ? " back" : "");
  if (!hidden) {
    el.textContent = code[0] + { c: "♣", d: "♦", h: "♥", s: "♠" }[code[1]];
    if (code[1] === "h" || code[1] === "d") el.classList.add("red");
    el.title = code;
  }
  return el;
}

function route() {
  const hash = location.hash.slice(1);
  let name = hash || "home";
  if (["6-max", "rankings", "live", "hands"].includes(name)) name = "six-max";
  if (!["six-max", "heads-up", "figgie", "connect"].includes(name)) name = "home";
  $$(".view").forEach((v) => { v.hidden = v.id !== name; });
  $$("[data-nav]").forEach((a) => {
    const active = a.dataset.nav === name;
    a.classList.toggle("active", active);
    if (active) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  if (["games", "rankings", "hands"].includes(hash)) $("#" + hash).scrollIntoView();
  else window.scrollTo(0, 0);
  if (name === "connect") bindConnect();
  if (name === "home") startOverview();
  else stopOverview();
  if (name === "six-max") {
    if (!sixMaxReady) {
      sixMaxReady = true;
      bindRankings();
      loadHands();
      refreshLeaderboard();
    }
    startBroadcast();
  } else {
    stopBroadcast();
    stopReplay();
  }
  if (name === "heads-up") startHeadsUp();
  else stopHeadsUp();
  if (name === "figgie") startFiggie();
  else stopFiggie();
}

async function refreshOverview() {
  if (overviewBusy || document.hidden) return;
  overviewBusy = true;
  try {
    await Promise.all($$("[data-preview]").map(async card => {
      const data = await arenaPreview(card.dataset.preview).catch(() => ({
        state: "offline", label: "Status unavailable", note: "You can still open the arena page.",
      }));
      const status = $(".preview-status", card);
      status.dataset.state = data.state;
      status.textContent = data.label;
      const note = $(".preview-note", card);
      note.textContent = data.note || "";
      note.hidden = !data.note;
    }));
  } finally { overviewBusy = false; }
}

function startOverview() {
  if (overviewTimer) return;
  refreshOverview();
  overviewTimer = setInterval(refreshOverview, 15000);
}

function stopOverview() {
  clearInterval(overviewTimer);
  overviewTimer = null;
}

function emptyFrame() {
  return { phase: "deal", board: [], pot: 0, seats: [], actor: null };
}

function boot() {
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  window.scrollTo(0, 0);
  route();
  window.addEventListener("hashchange", route);
}

function bindRankings() {
  $("#bot-filter").addEventListener("input", () => {
    renderLeaderboard();
    $("#lb").dataset.matches = String($$("#lb tbody tr[data-bot]").length);
  });
  $("#min-hands").addEventListener("change", refreshLeaderboard);
  $$("#lb th").forEach((th) => th.addEventListener("click", () => {
    const key = th.dataset.sort;
    sortDir = sortKey === key ? -sortDir : (key === "bot" ? 1 : -1);
    sortKey = key;
    renderLeaderboard();
  }));
}

async function refreshLeaderboard() {
  const min = $("#min-hands").checked ? 100 : 0;
  try {
    const data = await stdbBoard();
    leaderboard = data.bots || [];
  } catch (err) {
    leaderboard = [];
    $("#lb tbody").innerHTML = `<tr><td colspan="11">Could not load rankings. ${esc(err.message)}</td></tr>`;
  }
  renderLeaderboard();
  if (!selectedBot && leaderboard[0]) selectBot(leaderboard[0].bot);
}

function renderLeaderboard() {
  const q = $("#bot-filter").value.trim().toLowerCase();
  const rows = leaderboard
    .filter((r) => !q || r.bot.toLowerCase().includes(q))
    .slice()
    .sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      if (typeof av === "string") return av.localeCompare(bv) * sortDir;
      return (av - bv) * sortDir;
    });
  $("#lb tbody").innerHTML = rows.map((r) => `
    <tr data-bot="${esc(r.bot)}" class="${r.bot === selectedBot ? "selected" : ""}">
      <td>${r.rank}</td>
      <td class="bot-name">${esc(r.bot)}</td>
      <td class="${r.chips >= 0 ? "up" : "down"}">${money(r.chips)}</td>
      <td>${r.matches}</td>
      <td>${r.hands.toLocaleString()}</td>
      <td class="${r.bb100 >= 0 ? "up" : "down"}">${r.bb100.toFixed(1)}</td>
      <td>${r.ci95.toFixed(1)}</td>
      <td>${r.vpip.toFixed(0)}</td>
      <td>${r.pfr.toFixed(0)}</td>
      <td>${r.af.toFixed(1)}</td>
      <td>${r.match_wins}</td>
    </tr>`).join("") || `<tr><td colspan="11">No bots yet. Run a tournament, then refresh.</td></tr>`;
  $$("#lb tbody tr[data-bot]").forEach((tr) => {
    tr.addEventListener("click", () => selectBot(tr.dataset.bot));
  });
}

async function selectBot(name) {
  if (name === selectedBot && $("#bot-card").dataset.ready === name) {
    $$("#lb tbody tr[data-bot]").forEach((tr) => tr.classList.toggle("selected", tr.dataset.bot === name));
    return;
  }
  selectedBot = name;
  renderLeaderboard();
  const card = $("#bot-card");
  card.dataset.ready = "";
  card.innerHTML = `<h2>${esc(name)}</h2><p class="muted">Loading…</p>`;
  try {
    const d = await api("/api/bots/" + encodeURIComponent(name));
    const hist = d.history || [];
    card.innerHTML = `
      <h2>${esc(d.bot)}</h2>
      <p><b class="${d.chips >= 0 ? "up" : "down"}">${money(d.chips)}</b> chips · ${Number(d.matches)} matches · ${Number(d.hands).toLocaleString()} hands</p>
      ${sparkline(hist.map((h) => h.chips_after))}
      <h2>Recent matches</h2>
      ${(d.recent_matches || []).slice(0, 8).map((m) => `
        <div class="script-line">${esc(m.played_at)} · rank ${Number(m.rank)} ·
          <span class="${m.net_chips >= 0 ? "up" : "down"}">${money(m.net_chips)}</span>
        </div>`).join("") || "<p class='muted'>No matches yet.</p>"}
      <p><a href="#hands" id="see-hands">See this bot's hands</a></p>`;
    card.dataset.ready = name;
    $("#see-hands").addEventListener("click", (ev) => {
      ev.preventDefault();
      loadHands(name);
      $("#hands").scrollIntoView({ behavior: "smooth" });
    });
  } catch (err) {
    card.innerHTML = `<h2>${esc(name)}</h2><p>${esc(err.message)}</p>`;
  }
}

function sparkline(values) {
  if (values.length < 2) return "";
  const w = 280, h = 72;
  const min = Math.min(...values), max = Math.max(...values);
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * (w - 8) + 4;
    const y = h - 8 - ((v - min) / (max - min || 1)) * (h - 16);
    return `${x},${y}`;
  }).join(" ");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}"><polyline fill="none" stroke="#e4c27a" stroke-width="2" points="${pts}"></polyline></svg>`;
}

function startBroadcast() {
  if (live.timer) return;
  tune();
  live.timer = setInterval(tune, 1000);
}

let headsUp = { timer: null, stamp: "" };

function startHeadsUp() {
  if (headsUp.timer) return;
  tuneHeadsUp();
  loadHeadsUpBoard();
  headsUp.timer = setInterval(() => { tuneHeadsUp(); loadHeadsUpBoard(); }, 1000);
}
function stopHeadsUp() {
  clearInterval(headsUp.timer);
  headsUp.timer = null;
}
async function tuneHeadsUp() {
  try {
    const data = await liveTable(headsUpDb);
    const frame = data.frame || {};
    showTables($("#hu-tables"), data, headsUpDb, tuneHeadsUp);
    const stamp = JSON.stringify([data.table, data.playing, data.paused, data.hands_saved, frame.log, frame.pot, frame.actor]);
    if (stamp === headsUp.stamp) return;
    headsUp.stamp = stamp;
    renderFelt($("#hu-felt"), frame.seats ? frame : emptyFrame());
    $("#hu-log").textContent = frame.log || (data.tables ? describe(frame) : "A table starts when two bots are connected.");
    $("#hu-meta").textContent = `${data.hands_saved || 0} hands saved`;
    $("#hu-state").textContent = data.paused ? "Paused" : data.playing ? "Live now" : "Waiting for bots";
    $("#hu-dot").classList.toggle("paused", !data.playing);
  } catch (err) {
    $("#hu-log").textContent = err.message;
  }
}
async function loadHeadsUpBoard() {
  try {
    const data = await stdbBoard(headsUpDb);
    const rows = data.bots || [];
    $("#hu-lb tbody").innerHTML = rows.map((r) => `
      <tr>
        <td>${r.rank}</td><td class="bot-name">${esc(r.bot)}</td><td class="${r.chips >= 0 ? "up" : "down"}">${money(r.chips)}</td>
        <td>${r.matches}</td><td>${r.hands.toLocaleString()}</td>
        <td class="${r.bb100 >= 0 ? "up" : "down"}">${r.bb100.toFixed(1)}</td>
      </tr>`).join("") || `<tr><td colspan="6">No heads-up matches yet.</td></tr>`;
  } catch (err) {
    $("#hu-lb tbody").innerHTML = `<tr><td colspan="6">${esc(err.message)}</td></tr>`;
  }
}

function stopBroadcast() {
  clearInterval(live.timer);
  live.timer = null;
}

function showTables(box, data, db, refresh) {
  const ids = data.tableIds || [];
  if (box.dataset.ids !== ids.join(',')) {
    box.dataset.ids = ids.join(',');
    box.replaceChildren(...ids.map(i => new Option('Table ' + (i+1), String(i))));
  }
  box.value = String(data.table ?? 0);
  if (!box.dataset.bound) {
    box.dataset.bound = "1";
    box.addEventListener("change", () => {
      pickTable(box.value, db);
      refresh();
    });
  }
}

async function tune() {
  if (live.busy) return;
  live.busy = true;
  try {
    const data = await liveTable();
    showTables($("#table-tabs"), data, undefined, tune);
    const stamp = JSON.stringify([data.table, data.playing, data.paused, data.hands_saved, data.hand_no, data.frame?.phase, data.frame?.pot, data.frame?.actor, data.frame?.log]);
    if (stamp === live.stamp) return;
    live.stamp = stamp;
    live.frame = data.frame;
    renderFelt($("#felt"), data.frame || emptyFrame());
    const frame = data.frame || {};
    $("#action-log").textContent = frame.log || (data.tables ? describe(frame) : "A table starts when six bots are connected.");
    $("#live-meta").textContent = `Table ${(data.table || 0) + 1} · ${data.hands_saved || 0} hands saved`;
    $("#live-state").textContent = data.paused ? "Paused" : data.playing ? "Live now" : "Waiting for bots";
    $("#live-dot").classList.toggle("paused", !data.playing);
    if (data.playing && data.hands_saved && data.hands_saved !== live.saved) {
      live.saved = data.hands_saved;
      refreshLeaderboard();
    }
  } catch (err) {
    $("#action-log").textContent = err.message;
  } finally {
    live.busy = false;
  }
}

function chips(n) {
  const v = Math.abs(Math.round(Number(n) || 0));
  return "$" + v.toLocaleString();
}

function describe(frame) {
  if (!frame || frame.type === "session_end") return "Next hand is coming up";
  const last = frame.last;
  if (last && last.kind === "result") {
    const winners = (frame.seats || []).filter((s) => s.net > 0);
    if (!winners.length) return "Hand over";
    return winners.map((s) => `${s.bot} wins ${chips(s.net)}`).join(", ");
  }
  if (last && last.bot) {
    const name = last.bot;
    const paid = last.amount || 0;
    if (last.kind === "fold") return `${name} folds`;
    if (last.kind === "check") return `${name} checks`;
    if (last.kind === "call") return paid ? `${name} calls ${chips(paid)}` : `${name} calls`;
    if (last.kind === "bet") return `${name} bets ${chips(paid || last.to_total)}`;
    if (last.kind === "raise") return `${name} raises to ${chips(last.to_total)}`;
    if (last.kind === "sb") return `${name} posts the small blind`;
    if (last.kind === "bb") return `${name} posts the big blind`;
    return `${name} ${last.kind}`;
  }
  if (frame.phase === "board") {
    const n = (frame.board || []).length;
    const street = n >= 5 ? "River" : n === 4 ? "Turn" : "Flop";
    return `${street}: ${(frame.board || []).join(" ")}`;
  }
  if (frame.phase === "deal") return "Dealing the next hand";
  return "Waiting for the next action";
}

function renderFelt(root, frame) {
  root.innerHTML = "";
  const seats = frame.seats || [];
  const n = seats.length || 6;
  const layout = SEAT_POS[n] || SEAT_POS[6];
  seats.forEach((s, i) => {
    const [x, y] = layout[i] || [50, 50];
    const node = document.createElement("div");
    node.className = "seat" + (frame.actor === s.seat ? " actor" : "") + (s.folded ? " folded" : "");
    node.style.left = x + "%";
    node.style.top = y + "%";
    const holes = document.createElement("div");
    holes.className = "cards";
    const reveal = showHoles || frame.phase === "result";
    (s.hole || ["??", "??"]).forEach((c) => holes.appendChild(cardEl(reveal ? c : "??")));
    const box = document.createElement("div");
    box.className = "seat-box";
    box.appendChild(holes);
    const info = document.createElement("div");
    info.className = "seat-info";
    const net = s.net != null ? `<div class="${s.net >= 0 ? "net-pos" : "net-neg"}">${money(s.net)}</div>` : "";
    info.innerHTML = `
      <div class="who">${esc(s.bot)}</div>
      <div class="meta">${esc(s.position)}${s.all_in ? " · ALL-IN" : ""}</div>
      <div class="stack">${Number(s.stack || 0).toLocaleString()}${s.category ? " · " + esc(s.category) : ""}</div>
      ${net}`;
    box.appendChild(info);
    node.appendChild(box);
    if (s.bet) {
      const chip = document.createElement("div");
      chip.className = "bet-chip";
      chip.textContent = s.bet.toLocaleString();
      node.appendChild(chip);
    }
    root.appendChild(node);
  });
  const board = document.createElement("div");
  board.className = "board-cards";
  (frame.board || []).forEach((c) => board.appendChild(cardEl(c, true)));
  for (let i = (frame.board || []).length; i < 5; i++) board.appendChild(cardEl("??", true));
  root.insertBefore(board, root.firstChild);
  const pot = document.createElement("div");
  pot.className = "pot-label";
  pot.textContent = frame.pot ? `pot ${Number(frame.pot).toLocaleString()}` : "";
  root.insertBefore(pot, board.nextSibling);
}

async function loadHands(bot) {
  const list = $("#hand-list");
  list.dataset.loaded = "1";
  list.innerHTML = "<p class='muted'>Loading hands…</p>";
  try {
    const q = bot ? "?bot=" + encodeURIComponent(bot) + "&limit=40" : "?limit=40";
    const data = await api("/api/hands" + q);
    if (!data.hands.length) {
      list.innerHTML = "<p class='muted'>No hands in the database yet. Run a tournament first.</p>";
      return;
    }
    list.innerHTML = data.hands.map((h) => `
      <button type="button" class="hand-row" data-id="${Number(h.hand_id)}">
        <strong>#${Number(h.hand_id)}</strong> match ${Number(h.match_id)}
        · pot ${Number(h.pot).toLocaleString()} ${h.showdown ? "· showdown" : ""}
        <div class="muted">${h.players.map((p) => esc(p.bot)).join(" · ")}</div>
      </button>`).join("");
    $$(".hand-row", list).forEach((b) => b.addEventListener("click", () => openHand(b.dataset.id)));
    openHand(data.hands[0].hand_id);
  } catch (err) {
    list.textContent = err.message;
  }
}

function stopReplay() {
  clearInterval(replay.timer);
  replay.timer = null;
  const play = $("#replay-play");
  if (play) play.classList.remove("on");
}

function handFrames(data) {
  const players = data.players.slice().sort((a, b) => a.seat - b.seat);
  const seats = players.map((p) => ({
    seat: p.seat,
    bot: p.bot,
    position: p.position,
    stack: p.stack,
    bet: 0,
    folded: false,
    all_in: false,
    hole: p.hole,
    is_button: p.seat === data.button,
  }));
  const bySeat = Object.fromEntries(seats.map((s) => [s.seat, s]));
  const frames = [{
    phase: "deal",
    board: [],
    pot: 0,
    actor: null,
    last: null,
    seats: seats.map((s) => ({ ...s })),
  }];
  let pot = 0;
  for (const a of data.actions) {
    const seat = bySeat[a.seat];
    if (!seat) continue;
    if (a.street > 0 && frames[frames.length - 1].board.length < [0, 3, 4, 5][a.street]) {
      for (const s of seats) s.bet = 0;
      frames.push({
        phase: "board",
        board: data.board.slice(0, [0, 3, 4, 5][a.street]),
        pot,
        actor: null,
        last: null,
        seats: seats.map((s) => ({ ...s })),
      });
    }
    const paid = a.amount || 0;
    if (a.stack_before != null) seat.stack = a.stack_before - paid;
    else seat.stack = Math.max(0, seat.stack - paid);
    seat.bet = a.to_total || 0;
    seat.all_in = !!a.all_in;
    if (a.kind === "fold") seat.folded = true;
    pot = (a.pot_before || 0) + paid;
    frames.push({
      phase: a.street_name,
      board: data.board.slice(0, [0, 3, 4, 5][a.street] || 0),
      pot,
      actor: a.seat,
      last: a,
      seats: seats.map((s) => ({ ...s })),
    });
  }
  frames.push({
    phase: "result",
    board: data.board,
    pot: data.pot,
    actor: null,
    last: { kind: "result" },
    seats: players.map((p) => ({
      seat: p.seat, bot: p.bot, position: p.position, stack: p.final_stack,
      bet: 0, folded: p.folded_street >= 0, hole: p.hole, net: p.net,
      is_button: p.seat === data.button, category: p.category,
    })),
  });
  return frames;
}

function showReplay(index) {
  if (!replay.frames.length) return;
  replay.index = Math.max(0, Math.min(index, replay.frames.length - 1));
  const frame = replay.frames[replay.index];
  renderFelt($("#replay-felt"), frame);
  $("#replay-log").textContent = describe(frame);
  const scrub = $("#replay-scrub");
  scrub.max = String(replay.frames.length - 1);
  scrub.value = String(replay.index);
  $$("#replay-script .script-line").forEach((line) => {
    line.classList.toggle("on", Number(line.dataset.step) === replay.index);
  });
}

function playReplay() {
  if (replay.timer) {
    stopReplay();
    return;
  }
  if (replay.index >= replay.frames.length - 1) replay.index = 0;
  $("#replay-play").classList.add("on");
  $("#replay-play").textContent = "Pause";
  replay.timer = setInterval(() => {
    if (replay.index >= replay.frames.length - 1) {
      stopReplay();
      $("#replay-play").textContent = "Play";
      return;
    }
    showReplay(replay.index + 1);
  }, 700);
}

function bindReplay() {
  const play = $("#replay-play");
  if (play.dataset.bound) return;
  play.dataset.bound = "1";
  play.addEventListener("click", () => {
    playReplay();
    if (!replay.timer) play.textContent = "Play";
  });
  $("#replay-prev").addEventListener("click", () => { stopReplay(); $("#replay-play").textContent = "Play"; showReplay(replay.index - 1); });
  $("#replay-next").addEventListener("click", () => { stopReplay(); $("#replay-play").textContent = "Play"; showReplay(replay.index + 1); });
  $("#replay-scrub").addEventListener("input", (ev) => {
    stopReplay();
    $("#replay-play").textContent = "Play";
    showReplay(Number(ev.target.value));
  });
}

async function openHand(id) {
  bindReplay();
  stopReplay();
  const data = await api("/api/hands/" + id);
  replay.frames = handFrames(data);
  replay.index = 0;
  replay.id = id;
  const script = $("#replay-script");
  let street = -1;
  const lines = [`<h2>Hand #${Number(data.hand_id)}</h2>`];
  data.actions.forEach((a, i) => {
    if (a.street !== street) {
      street = a.street;
      const shown = data.board.slice(0, [0, 3, 4, 5][a.street]).join(" ");
      lines.push(`<div class="street">${esc(a.street_name.toUpperCase())} ${esc(shown)}</div>`);
    }
    const amt = a.kind === "raise" || a.kind === "bet" ? " " + a.to_total : (a.amount ? " " + a.amount : "");
    lines.push(`<button type="button" class="script-line" data-step="${i + 1}">${esc(a.bot)} ${esc(a.kind)}${esc(amt)}${a.all_in ? " (all-in)" : ""}</button>`);
  });
  lines.push(`<button type="button" class="script-line" data-step="${replay.frames.length - 1}">Showdown</button>`);
  script.innerHTML = lines.join("");
  $$(".script-line", script).forEach((line) => {
    line.addEventListener("click", () => {
      stopReplay();
      $("#replay-play").textContent = "Play";
      showReplay(Number(line.dataset.step));
    });
  });
  $("#replay-play").textContent = "Play";
  showReplay(0);
  if (!$("#six-max").hidden) playReplay();
}

function bindConnect() {
  const root = $("#connect");
  if (root.dataset.bound) return;
  root.dataset.bound = "1";
  $$("[data-jump]").forEach((b) => b.addEventListener("click", () => {
    $("#" + b.dataset.jump).scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  $$(".copy").forEach((btn) => btn.addEventListener("click", async () => {
    const text = $("#" + btn.dataset.copy).textContent;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "Copied";
      setTimeout(() => { btn.textContent = "Copy"; }, 1200);
    } catch (err) {
      btn.textContent = "Select the command";
    }
  }));
}

boot();
