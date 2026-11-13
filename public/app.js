const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const params = new URLSearchParams(location.search);
const API = (params.get("api") || window.POKERARENA_API || "").replace(/\/$/, "");

const BUILTINS = ["tag", "lag", "nit", "equity", "equity_lag", "rock", "calling_station", "maniac", "random"];
const SEAT_POS = {
  2: [[50, 82], [50, 18]],
  6: [[50, 86], [14, 70], [14, 28], [50, 14], [86, 28], [86, 70]],
  9: [[50, 88], [20, 80], [8, 54], [16, 24], [38, 10], [62, 10], [84, 24], [92, 54], [80, 80]],
};

let leaderboard = [];
let sortKey = "elo";
let sortDir = -1;
let selectedBot = null;
let live = { seed: 7, cursor: 0, hands: 4, names: BUILTINS.slice(0, 6), timer: null, playing: false };
let showHoles = true;

function api(path, opts) {
  return fetch(API + path, opts).then(async (res) => {
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
  const name = (location.hash || "#rankings").slice(1) || "rankings";
  $$(".view").forEach((v) => { v.hidden = v.id !== name; });
  $$("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === name));
  if (name === "hands" && !$("#hand-list").dataset.loaded) loadHands();
  if (name === "connect" && !$("#bot-sample").textContent) loadConnect();
  if (name === "live" && !live.frame) pullFrame();
}

function emptyFrame() {
  return { phase: "deal", board: [], pot: 0, seats: [], actor: null };
}

async function boot() {
  route();
  window.addEventListener("hashchange", route);
  try {
    await api("/api/health");
    $("#api-pill").textContent = "API live";
    $("#api-pill").className = "api-pill ok";
  } catch (err) {
    $("#api-pill").textContent = "API offline";
    $("#api-pill").className = "api-pill bad";
    $("#api-pill").title = String(err);
  }
  bindRankings();
  bindLive();
  await refreshLeaderboard();
  buildSeatPicker();
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
    const data = await api("/api/leaderboard?min_hands=" + min);
    leaderboard = data.bots || [];
  } catch (err) {
    leaderboard = [];
    $("#lb tbody").innerHTML = `<tr><td colspan="11">Could not load rankings. ${err.message}</td></tr>`;
  }
  const top = leaderboard[0];
  $("#hero-stats").innerHTML = [
    ["Bots", leaderboard.length],
    ["Leader", top ? top.bot : "—"],
    ["Top Elo", top ? Math.round(top.elo) : "—"],
  ].map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join("");
  renderLeaderboard();
  drawEloChart();
  if (leaderboard[0]) selectBot(leaderboard[0].bot);
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
    <tr data-bot="${r.bot}" class="${r.bot === selectedBot ? "selected" : ""}">
      <td>${r.rank}</td>
      <td class="bot-name">${r.bot}</td>
      <td>${Math.round(r.elo)}</td>
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

function drawEloChart() {
  const svg = $("#elo-chart");
  const rows = leaderboard.slice(0, 12);
  svg.innerHTML = "";
  if (!rows.length) return;
  const w = 640, h = 280, pad = 36;
  const min = Math.min(...rows.map((r) => r.elo)) - 20;
  const max = Math.max(...rows.map((r) => r.elo)) + 20;
  const bw = (w - pad * 2) / rows.length;
  rows.forEach((r, i) => {
    const bh = ((r.elo - min) / (max - min || 1)) * (h - 70);
    const x = pad + i * bw + 8;
    const y = h - 28 - bh;
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", x); rect.setAttribute("y", y);
    rect.setAttribute("width", bw - 16); rect.setAttribute("height", bh);
    rect.setAttribute("rx", 6); rect.setAttribute("fill", i === 0 ? "#e4c27a" : "#2f8f5b");
    svg.appendChild(rect);
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", x + (bw - 16) / 2); label.setAttribute("y", h - 10);
    label.setAttribute("text-anchor", "middle"); label.setAttribute("fill", "#a8a292");
    label.setAttribute("font-size", "11");
    label.textContent = r.bot.length > 8 ? r.bot.slice(0, 7) + "…" : r.bot;
    svg.appendChild(label);
  });
}

async function selectBot(name) {
  selectedBot = name;
  renderLeaderboard();
  const card = $("#bot-card");
  card.innerHTML = `<h2>${name}</h2><p class="muted">Loading…</p>`;
  try {
    const d = await api("/api/bots/" + encodeURIComponent(name));
    const hist = d.history || [];
    card.innerHTML = `
      <h2>${d.bot}</h2>
      <p class="muted">${d.description || "Custom bot"}</p>
      <p><b>${Math.round(d.elo)}</b> Elo · ${d.matches} matches · ${d.hands.toLocaleString()} hands</p>
      ${sparkline(hist.map((h) => h.elo_after))}
      <h2>Recent matches</h2>
      ${(d.recent_matches || []).slice(0, 8).map((m) => `
        <div class="script-line">${m.played_at || ""} · rank ${m.rank} ·
          <span class="${m.net_chips >= 0 ? "up" : "down"}">${money(m.net_chips)}</span>
          · Elo ${Math.round(m.elo_before)} → ${Math.round(m.elo_after)}
        </div>`).join("") || "<p class='muted'>No matches yet.</p>"}
      <p><a href="#hands" id="see-hands">See this bot's hands</a></p>`;
    $("#see-hands").addEventListener("click", () => {
      location.hash = "hands";
      loadHands(name);
    });
  } catch (err) {
    card.innerHTML = `<h2>${name}</h2><p>${err.message}</p>`;
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

function buildSeatPicker() {
  const box = $("#seat-picker");
  box.innerHTML = "";
  BUILTINS.forEach((name) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = name;
    b.className = live.names.includes(name) ? "on" : "";
    b.addEventListener("click", () => {
      if (live.names.includes(name)) live.names = live.names.filter((n) => n !== name);
      else if (live.names.length < 6) live.names.push(name);
      b.classList.toggle("on", live.names.includes(name));
    });
    box.appendChild(b);
  });
}

function bindLive() {
  $("#deal").addEventListener("click", () => {
    live.seed = Math.floor(Math.random() * 1e9);
    live.cursor = 0;
    pullFrame();
  });
  $("#step").addEventListener("click", () => { live.cursor += 1; pullFrame(); });
  $("#play").addEventListener("click", togglePlay);
$("#speed").addEventListener("input", () => { if (live.playing) { togglePlay(); togglePlay(); } });
  $("#show-holes").addEventListener("change", (e) => {
    showHoles = e.target.checked;
    if (live.frame) renderFelt($("#felt"), live.frame);
  });
}

function togglePlay() {
  live.playing = !live.playing;
  $("#play").textContent = live.playing ? "Pause" : "Play";
  clearInterval(live.timer);
  if (!live.playing) return;
  const ms = [1400, 900, 600, 380, 220][Number($("#speed").value) - 1];
  live.timer = setInterval(() => {
    if (live.done) { togglePlay(); return; }
    if (live.busy) return;
    live.cursor += 1;
    pullFrame();
  }, ms);
}

async function pullFrame() {
  if (live.names.length < 2) {
    $("#action-log").textContent = "Pick at least two bots.";
    return;
  }
  live.busy = true;
  try {
    const data = await api("/api/live/frame", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bots: live.names, seed: live.seed, hands: live.hands, cursor: live.cursor,
      }),
    });
    live.cursor = data.cursor;
    live.done = data.done;
    live.frame = data.frame;
    renderFelt($("#felt"), data.frame);
    $("#action-log").textContent = describe(data.frame, data);
  } catch (err) {
    $("#action-log").textContent = err.message;
  } finally {
    live.busy = false;
  }
}

const VERBS = {
  sb: "posts the small blind", bb: "posts the big blind", fold: "folds", check: "checks",
  call: "calls", bet: "bets", raise: "raises to",
};

function describe(frame, meta) {
  if (!frame || frame.type === "session_end") return "Shoe finished. Deal again for a new seed.";
  const last = frame.last;
  let who = frame.phase;
  if (last && last.bot) {
    const verb = VERBS[last.kind] || last.kind;
    const amt = last.kind === "raise" || last.kind === "bet" ? " " + last.to_total : (last.amount ? " " + last.amount : "");
    who = `${last.bot} ${verb}${amt}`;
  } else if (frame.phase === "board") {
    who = "board " + (frame.board || []).join(" ");
  }
  return `Hand ${frame.hand_no + 1} · ${who} · step ${meta.cursor + 1}/${meta.total}`;
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
      <div class="who">${s.bot}</div>
      <div class="meta">${s.position}${s.all_in ? " · ALL-IN" : ""}</div>
      <div class="stack">${(s.stack || 0).toLocaleString()}${s.category ? " · " + s.category : ""}</div>
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
      <button type="button" class="hand-row" data-id="${h.hand_id}">
        <strong>#${h.hand_id}</strong> match ${h.match_id}
        · pot ${h.pot.toLocaleString()} ${h.showdown ? "· showdown" : ""}
        <div class="muted">${h.players.map((p) => p.bot).join(" · ")}</div>
      </button>`).join("");
    $$(".hand-row", list).forEach((b) => b.addEventListener("click", () => openHand(b.dataset.id)));
    openHand(data.hands[0].hand_id);
  } catch (err) {
    list.innerHTML = `<p>${err.message}</p>`;
  }
}

async function openHand(id) {
  const data = await api("/api/hands/" + id);
  const script = $("#replay-script");
  let street = -1;
  const lines = [`<h2>Hand #${data.hand_id}</h2>`];
  data.actions.forEach((a) => {
    if (a.street !== street) {
      street = a.street;
      const shown = data.board.slice(0, [0, 3, 4, 5][a.street]).join(" ");
      lines.push(`<div class="street">${a.street_name.toUpperCase()} ${shown}</div>`);
    }
    const amt = a.kind === "raise" || a.kind === "bet" ? " " + a.to_total : (a.amount ? " " + a.amount : "");
    lines.push(`<div class="script-line">${a.bot} ${a.kind}${amt}${a.all_in ? " (all-in)" : ""}</div>`);
  });
  lines.push(`<div class="street">RESULT</div>`);
  data.players.forEach((p) => {
    lines.push(`<div class="script-line">${p.bot} [${p.hole.join(" ")}] <span class="${p.net >= 0 ? "up" : "down"}">${money(p.net)}</span>${p.category ? " · " + p.category : ""}</div>`);
  });
  script.innerHTML = lines.join("");
  renderFelt($("#replay-felt"), {
    phase: "result",
    board: data.board,
    pot: data.pot,
    actor: null,
    seats: data.players.map((p) => ({
      seat: p.seat, bot: p.bot, position: p.position, stack: p.final_stack,
      bet: 0, folded: p.folded_street >= 0, hole: p.hole, net: p.net,
      is_button: p.seat === data.button, category: p.category,
    })),
  });
}

async function loadConnect() {
  let guide;
  try {
    guide = await api("/api/connect");
  } catch (err) {
    $("#bot-sample").textContent = err.message;
    return;
  }
  $("#connect-steps").innerHTML = (guide.run || []).map((cmd, i) => `
    <div class="step"><em>0${i + 1}</em><pre class="code">${cmd}</pre></div>`).join("");
  $("#bot-sample").textContent = guide.minimal_bot || "";
  $("#obs-list").innerHTML = (guide.observation || []).map((t) => `<li>${t}</li>`).join("");
  $("#hook-list").innerHTML = (guide.hooks || []).map((t) => `<li>${t}</li>`).join("");
  $("#safety").textContent = guide.safety || "";
}

boot();
