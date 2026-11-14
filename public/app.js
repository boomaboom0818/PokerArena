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
let live = { table: 0, cursor: -1, timer: null };
let replay = { frames: [], index: 0, timer: null, id: null };
const showHoles = true;

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
  window.scrollTo(0, 0);
  if (name === "hands" && !$("#hand-list").dataset.loaded) loadHands();
  if (name === "connect" && !$("#bot-sample").textContent) loadConnect();
  if (name === "live") startBroadcast();
  else stopBroadcast();
  if (name !== "hands") stopReplay();
}

function emptyFrame() {
  return { phase: "deal", board: [], pot: 0, seats: [], actor: null };
}

async function boot() {
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  window.scrollTo(0, 0);
  route();
  requestAnimationFrame(() => window.scrollTo(0, 0));
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
  await refreshLeaderboard();
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

function startBroadcast() {
  if (live.timer) return;
  tune();
  live.timer = setInterval(tune, 220);
}

function stopBroadcast() {
  clearInterval(live.timer);
  live.timer = null;
}

function showTables(n) {
  const box = $("#table-tabs");
  if (Number(box.dataset.count) === n) {
    if (Number(box.value) !== live.table) box.value = String(live.table);
    return;
  }
  box.dataset.count = String(n);
  box.innerHTML = "";
  for (let i = 0; i < n; i++) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = "Table " + (i + 1);
    box.appendChild(opt);
  }
  box.value = String(Math.min(live.table, n - 1));
  if (!box.dataset.bound) {
    box.dataset.bound = "1";
    box.addEventListener("change", () => {
      live.table = Number(box.value) || 0;
      live.cursor = -1;
      tune();
    });
  }
}

async function tune() {
  if (live.busy) return;
  live.busy = true;
  try {
    const data = await api("/api/live?table=" + live.table);
    showTables(data.tables || 1);
    if (data.cursor === live.cursor && data.shoe === live.shoe) return;
    live.cursor = data.cursor;
    live.shoe = data.shoe;
    live.frame = data.frame;
    renderFelt($("#felt"), data.frame);
    $("#action-log").textContent = describe(data.frame);
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
  const on = $("#replay-script .script-line.on");
  if (on) on.scrollIntoView({ block: "nearest" });
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
  const lines = [`<h2>Hand #${data.hand_id}</h2>`];
  data.actions.forEach((a, i) => {
    if (a.street !== street) {
      street = a.street;
      const shown = data.board.slice(0, [0, 3, 4, 5][a.street]).join(" ");
      lines.push(`<div class="street">${a.street_name.toUpperCase()} ${shown}</div>`);
    }
    const amt = a.kind === "raise" || a.kind === "bet" ? " " + a.to_total : (a.amount ? " " + a.amount : "");
    lines.push(`<button type="button" class="script-line" data-step="${i + 1}">${a.bot} ${a.kind}${amt}${a.all_in ? " (all-in)" : ""}</button>`);
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
  playReplay();
}

function botSlug(raw) {
  const slug = (raw || "my_bot").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return slug && !/^[0-9]/.test(slug) ? slug.slice(0, 32) : "my_bot";
}

function refreshJoin() {
  const name = botSlug($("#bot-name").value);
  $("#join-cmd").textContent = "python -m pokerarena join " + name + ".py";
}

async function loadConnect() {
  const form = $("#join-form");
  if (!form.dataset.bound) {
    form.dataset.bound = "1";
    $("#bot-name").addEventListener("input", refreshJoin);
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const name = botSlug($("#bot-name").value);
      $("#bot-name").value = name;
      refreshJoin();
      const status = $("#join-status");
      status.textContent = "Preparing the file…";
      try {
        const res = await fetch(API + "/api/connect/starter?name=" + encodeURIComponent(name));
        if (!res.ok) throw new Error("could not build the starter");
        const kind = res.headers.get("content-type") || "";
        let blob = null;
        let filename = name + ".py";
        if (kind.includes("json")) {
          const data = await res.json();
          blob = new Blob([data.source || ""], { type: "text/x-python" });
          filename = (data.filename || name).replace(/[^\w.-]+/g, "_") + ".py";
        } else {
          blob = await res.blob();
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        status.textContent = "Downloaded " + name + ".py. Put it in the PokerArena folder, then run the command below.";
      } catch (err) {
        status.textContent = err.message;
      }
    });
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
  refreshJoin();
  try {
    const guide = await api("/api/connect");
    if (guide.repo) {
      $("#clone-cmd").textContent = "git clone " + guide.repo + ".git\ncd PokerArena";
    }
    $("#obs-list").innerHTML = (guide.observation || []).map((t) => `<li>${t}</li>`).join("");
    $("#safety").textContent = guide.safety || "";
  } catch (err) {
    $("#join-status").textContent = err.message;
  }
}

boot();
