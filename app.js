/* =========================================================
   MTG Draft Night — vanilla JS + Firebase Realtime Database
========================================================= */

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

let eventCode = null;
let eventRef = null;
let state = {}; // live mirror of the event's DB node
let activeTab = "players";

/* ---------------------------------------------------------
   Join / create event
--------------------------------------------------------- */
const joinScreen = document.getElementById("joinScreen");
const appRoot = document.getElementById("app");
const joinCodeInput = document.getElementById("joinCodeInput");

function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function openEvent(code) {
  eventCode = code.trim().toUpperCase();
  if (!eventCode) eventCode = randomCode();
  eventRef = db.ref("events/" + eventCode);

  // seed defaults if this event doesn't exist yet, without clobbering an existing one
  eventRef.once("value").then((snap) => {
    if (!snap.exists()) {
      eventRef.set({
        eventName: eventCode,
        players: {},
        totalRounds: 3,
        started: false,
        rounds: {},
        prizePool: {},
        orderMode: "winner-first",
        manualOrder: null,
        draftStarted: false,
        claims: {},
      });
    }
  });

  eventRef.on("value", (snap) => {
    state = snap.val() || {};
    joinScreen.style.display = "none";
    appRoot.style.display = "block";
    render();
  });

  const url = new URL(window.location.href);
  url.searchParams.set("event", eventCode);
  window.history.replaceState({}, "", url);
}

document.getElementById("joinBtn").addEventListener("click", () => openEvent(joinCodeInput.value));
joinCodeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") openEvent(joinCodeInput.value); });

document.getElementById("codeBadge").addEventListener("click", () => {
  if (eventRef) eventRef.off();
  eventCode = null; eventRef = null; state = {};
  const url = new URL(window.location.href);
  url.searchParams.delete("event");
  window.history.replaceState({}, "", url);
  appRoot.style.display = "none";
  joinScreen.style.display = "block";
  joinCodeInput.value = "";
});

// auto-join if ?event=CODE is in the URL
(function initFromUrl() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("event");
  if (code) openEvent(code);
})();

/* ---------------------------------------------------------
   Helpers: pull arrays out of the Firebase object shape
--------------------------------------------------------- */
function playersArray() {
  const p = state.players || {};
  return Object.entries(p)
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
}
function nameOf(id) {
  const p = (state.players || {})[id];
  return p ? p.name : "—";
}
function roundKeys() {
  return Object.keys(state.rounds || {}).sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));
}
function roundsArray() {
  return roundKeys().map((k) => ({
    key: k,
    matches: Object.entries((state.rounds[k] || {}).matches || {}).map(([id, m]) => ({ id, ...m })),
  }));
}
function newKey(path) { return db.ref(path).push().key; }

/* ---------------------------------------------------------
   Swiss pairing + standings
--------------------------------------------------------- */
function computeStandings() {
  const players = playersArray();
  const rounds = roundsArray();
  const stats = {};
  players.forEach((p) => { stats[p.id] = { id: p.id, name: p.name, points: 0, wins: 0, losses: 0, draws: 0, byes: 0, opponents: [] }; });
  rounds.forEach((round) => {
    round.matches.forEach((m) => {
      if (m.bye) {
        if (stats[m.p1]) { stats[m.p1].points += 3; stats[m.p1].wins += 1; stats[m.p1].byes += 1; }
        return;
      }
      const p1Wins = m.p1Wins || 0;
      const p2Wins = m.p2Wins || 0;
      if (p1Wins + p2Wins === 0 || !stats[m.p1] || !stats[m.p2]) return;
      stats[m.p1].opponents.push(m.p2);
      stats[m.p2].opponents.push(m.p1);
      if (p1Wins > p2Wins) { stats[m.p1].points += 3; stats[m.p1].wins += 1; stats[m.p2].losses += 1; }
      else if (p2Wins > p1Wins) { stats[m.p2].points += 3; stats[m.p2].wins += 1; stats[m.p1].losses += 1; }
      else { stats[m.p1].points += 1; stats[m.p2].points += 1; stats[m.p1].draws += 1; stats[m.p2].draws += 1; }
    });
  });
  const list = Object.values(stats);
  list.forEach((s) => {
    const oppPts = s.opponents.map((oid) => stats[oid]?.points ?? 0);
    s.tiebreak = oppPts.length ? oppPts.reduce((a, b) => a + b, 0) / oppPts.length : 0;
  });
  list.sort((a, b) => b.points - a.points || b.tiebreak - a.tiebreak || a.name.localeCompare(b.name));
  return list;
}
function playedBefore(rounds, a, b) {
  return rounds.some((r) => r.matches.some((m) => !m.bye && ((m.p1 === a && m.p2 === b) || (m.p1 === b && m.p2 === a))));
}
function hadBye(rounds, id) {
  return rounds.some((r) => r.matches.some((m) => m.bye && m.p1 === id));
}
function generatePairings() {
  const rounds = roundsArray();
  const standings = computeStandings().map((s) => ({ ...s, noise: Math.random() }));
  standings.sort((a, b) => b.points - a.points || b.tiebreak - a.tiebreak || b.noise - a.noise);
  let pool = standings.map((s) => s.id);
  const matches = [];
  if (pool.length % 2 === 1) {
    let byeIdx = -1;
    for (let i = pool.length - 1; i >= 0; i--) if (!hadBye(rounds, pool[i])) { byeIdx = i; break; }
    if (byeIdx === -1) byeIdx = pool.length - 1;
    const byeId = pool[byeIdx];
    pool.splice(byeIdx, 1);
    matches.push({ p1: byeId, p2: null, bye: true });
  }
  const unpaired = [...pool];
  while (unpaired.length > 0) {
    const a = unpaired.shift();
    let bIdx = unpaired.findIndex((b) => !playedBefore(rounds, a, b));
    if (bIdx === -1) bIdx = 0;
    const b = unpaired.splice(bIdx, 1)[0];
    if (b !== undefined) matches.push({ p1: a, p2: b, bye: false, p1Wins: 0, p2Wins: 0 });
  }
  return matches;
}

/* ---------------------------------------------------------
   Write actions
--------------------------------------------------------- */
function setEventName(name) { eventRef.child("eventName").set(name); }

function addPlayer(name) {
  if (!name.trim() || state.started) return;
  const key = newKey("events/" + eventCode + "/players");
  eventRef.child("players/" + key).set({ name: name.trim(), addedAt: Date.now() });
}
function removePlayer(id) { if (!state.started) eventRef.child("players/" + id).remove(); }

function setTotalRounds(n) { eventRef.child("totalRounds").set(Math.max(1, Math.min(9, n))); }

function startTournament() {
  const players = playersArray();
  if (players.length < 2) return;
  const matches = generatePairings();
  const roundObj = {};
  matches.forEach((m) => { roundObj[newKey("events/" + eventCode + "/rounds/r0/matches")] = m; });
  eventRef.update({ started: true, rounds: { r0: { matches: roundObj } } });
  activeTab = "tournament"; render();
}

function setGameWins(roundKey, matchId, side, delta) {
  const field = side === "p1" ? "p1Wins" : "p2Wins";
  const match = ((state.rounds || {})[roundKey]?.matches || {})[matchId] || {};
  const next = Math.max(0, Math.min(2, (match[field] || 0) + delta));
  eventRef.child("rounds/" + roundKey + "/matches/" + matchId + "/" + field).set(next);
}
function matchComplete(m) { return m.bye || (m.p1Wins || 0) >= 2 || (m.p2Wins || 0) >= 2; }

function nextRound() {
  const rounds = roundsArray();
  if (rounds.length >= (state.totalRounds || 3)) return;
  const last = rounds[rounds.length - 1];
  const complete = last.matches.every(matchComplete);
  if (!complete) return;
  const matches = generatePairings();
  const key = "r" + rounds.length;
  const roundObj = {};
  matches.forEach((m) => { roundObj[newKey("events/" + eventCode + "/rounds/" + key + "/matches")] = m; });
  eventRef.child("rounds/" + key).set({ matches: roundObj });
}

function resetTournament() { eventRef.update({ started: false, rounds: {} }); }

/* Scryfall is the standard free, keyless MTG card database/API.
   We look up each card by name to grab its art; anything that isn't a
   real card name (booster packs, "mystery prize", etc.) just won't
   find a match and falls back to a placeholder tile. */
async function fetchCardImage(name) {
  try {
    const res = await fetch("https://api.scryfall.com/cards/named?fuzzy=" + encodeURIComponent(name));
    if (!res.ok) return null;
    const data = await res.json();
    if (data.image_uris && data.image_uris.normal) return data.image_uris.normal;
    if (data.card_faces && data.card_faces[0] && data.card_faces[0].image_uris) return data.card_faces[0].image_uris.normal;
    return null;
  } catch (e) { return null; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function addBulkCards(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return;
  const entries = lines.map((name) => ({ key: newKey("events/" + eventCode + "/prizePool"), name }));
  const updates = {};
  entries.forEach((e2) => { updates["prizePool/" + e2.key] = { name: e2.name, addedAt: Date.now(), imageStatus: "loading" }; });
  eventRef.update(updates);
  // Scryfall asks for polite spacing between requests, so we look these up
  // one at a time in the background rather than all at once.
  for (const e2 of entries) {
    const img = await fetchCardImage(e2.name);
    eventRef.child("prizePool/" + e2.key).update({ imageUrl: img, imageStatus: img ? "found" : "none" });
    await sleep(100);
  }
}
async function addSingleCard(name) {
  name = name.trim();
  if (!name) return;
  const key = newKey("events/" + eventCode + "/prizePool");
  eventRef.child("prizePool/" + key).set({ name, addedAt: Date.now(), imageStatus: "loading" });
  const img = await fetchCardImage(name);
  eventRef.child("prizePool/" + key).update({ imageUrl: img, imageStatus: img ? "found" : "none" });
}
function removeCard(id) { if (!state.draftStarted) eventRef.child("prizePool/" + id).remove(); }
function clearPool() { if (!state.draftStarted) eventRef.child("prizePool").remove(); }

function setOrderMode(mode) { eventRef.update({ orderMode: mode, manualOrder: null }); }
function setManualOrder(arr) { eventRef.child("manualOrder").set(arr); }
function resetOrderToStandings() { eventRef.child("manualOrder").set(null); }

function computeBaseOrder() {
  const standingsIds = computeStandings().map((s) => s.id);
  if (state.manualOrder && state.manualOrder.length === playersArray().length) return state.manualOrder;
  const ids = [...standingsIds];
  if (state.orderMode === "last-first") ids.reverse();
  return ids;
}

function beginDraft() {
  const pool = state.prizePool || {};
  const players = playersArray();
  if (Object.keys(pool).length === 0 || players.length === 0) return;
  eventRef.update({ draftStarted: true, claims: {}, pickOrderSnapshot: computeBaseOrder() });
}

function currentPickerId() {
  const order = state.pickOrderSnapshot || computeBaseOrder();
  const claimsCount = Object.keys(state.claims || {}).length;
  const n = order.length;
  if (n === 0) return null;
  const round = Math.floor(claimsCount / n);
  let pos = claimsCount % n;
  if (round % 2 === 1) pos = n - 1 - pos;
  return order[pos];
}

function claimCard(cardId) {
  const key = newKey("events/" + eventCode + "/claims");
  eventRef.child("claims/" + key).set({ cardId, playerId: currentPickerId(), ts: Date.now() });
}
function undoLastPick() {
  const claims = Object.entries(state.claims || {}).sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
  if (!claims.length) return;
  eventRef.child("claims/" + claims[claims.length - 1][0]).remove();
}
function resetPrizeDraft() { eventRef.update({ draftStarted: false, claims: {}, pickOrderSnapshot: null }); }

/* ---------------------------------------------------------
   Render
--------------------------------------------------------- */
function el(html) { const d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstChild; }
function esc(s) { return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

function cardVisualHTML(c, kind) {
  // kind: "thumb" (pool list row), "tile" (draft grid), "mini" (results list)
  const cls = kind === "tile" ? "card-tile-art" : kind === "mini" ? "result-thumb" : "card-thumb";
  if (c.imageUrl) return `<div class="${cls}"><img src="${c.imageUrl}" alt="${esc(c.name)}" loading="lazy" /></div>`;
  if (c.imageStatus === "loading") return `<div class="${cls} ph">⏳</div>`;
  return `<div class="${cls} ph">📦</div>`;
}

function render() {
  // header
  const nameInput = document.getElementById("eventNameInput");
  if (document.activeElement !== nameInput) nameInput.value = state.eventName || "";
  const players = playersArray();
  document.getElementById("eventMeta").textContent =
    `${players.length} player${players.length === 1 ? "" : "s"}` +
    (state.started ? ` · round ${roundKeys().length}/${state.totalRounds || 3}` : "");
  document.getElementById("codeBadge").textContent = "Event code: " + eventCode + " (tap to change)";

  renderPlayers();
  renderTournament();
  renderPrizes();

  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === activeTab));
  document.querySelectorAll(".tab-page").forEach((p) => p.classList.toggle("active", p.id === "page-" + activeTab));
}

function renderPlayers() {
  const players = playersArray();
  document.getElementById("playersSub").textContent = state.started
    ? "Player list is locked once the tournament has started."
    : "Add everyone who's drafting.";
  document.getElementById("addPlayerRow").style.display = state.started ? "none" : "flex";

  const list = document.getElementById("playersList");
  list.innerHTML = "";
  if (players.length === 0) {
    list.appendChild(el(`<p style="color:var(--ink-soft);font-size:14px;">No players yet — add a name above to get started.</p>`));
    return;
  }
  players.forEach((p, i) => {
    const row = el(`
      <div class="list-item">
        <span><span style="color:var(--ink-soft);margin-right:6px;font-size:12.5px;">${i + 1}.</span>${esc(p.name)}</span>
        ${state.started ? "" : `<button class="x-btn" data-remove-player="${p.id}">✕</button>`}
      </div>`);
    list.appendChild(row);
  });
}

function renderTournament() {
  const players = playersArray();
  document.getElementById("roundsCount").textContent = state.totalRounds || 3;
  document.getElementById("needPlayersMsg").style.display = players.length < 2 ? "block" : "none";
  document.getElementById("startTournamentBtn").disabled = players.length < 2;

  const running = !!state.started;
  document.getElementById("setupView").style.display = running ? "none" : "block";
  document.getElementById("runningView").style.display = running ? "block" : "none";
  if (!running) return;

  const rounds = roundsArray();
  const totalRounds = state.totalRounds || 3;
  const last = rounds[rounds.length - 1];
  const complete = last ? last.matches.every(matchComplete) : true;
  const done = rounds.length >= totalRounds && complete;

  document.getElementById("roundTitle").textContent = done ? "Final round" : `Round ${rounds.length} of ${totalRounds}`;
  document.getElementById("roundSub").textContent = done ? "All rounds complete — head to Prize draft when you're ready." : "Record games won by each player (best of 3).";

  const matchesList = document.getElementById("matchesList");
  matchesList.innerHTML = "";
  if (last) {
    last.matches.forEach((m) => {
      if (m.bye) {
        matchesList.appendChild(el(`
          <div class="match-row">
            <span class="pname">${esc(nameOf(m.p1))}</span>
            <span style="font-size:12.5px;color:var(--ink-soft);font-style:italic;">bye — automatic win</span>
          </div>`));
      } else {
        const p1w = m.p1Wins || 0, p2w = m.p2Wins || 0;
        matchesList.appendChild(el(`
          <div class="match-row">
            <span class="pname">${esc(nameOf(m.p1))}</span>
            <div class="games-stepper">
              <button class="icon-btn" data-game="${last.key}|${m.id}|p1|-1" ${p1w <= 0 ? "disabled" : ""}>−</button>
              <span class="games-count ${p1w > p2w ? "ahead" : ""}">${p1w}</span>
              <button class="icon-btn" data-game="${last.key}|${m.id}|p1|1" ${p1w >= 2 ? "disabled" : ""}>+</button>
            </div>
            <span style="color:var(--ink-soft);font-size:13px;">games won</span>
            <div class="games-stepper">
              <button class="icon-btn" data-game="${last.key}|${m.id}|p2|-1" ${p2w <= 0 ? "disabled" : ""}>−</button>
              <span class="games-count ${p2w > p1w ? "ahead" : ""}">${p2w}</span>
              <button class="icon-btn" data-game="${last.key}|${m.id}|p2|1" ${p2w >= 2 ? "disabled" : ""}>+</button>
            </div>
            <span class="pname right">${esc(nameOf(m.p2))}</span>
          </div>`));
      }
    });
  }
  document.getElementById("nextRoundBtn").style.display = done ? "none" : "inline-block";
  document.getElementById("nextRoundBtn").disabled = !complete;
  document.getElementById("nextRoundBtn").textContent = rounds.length === 0 ? "Generate round 1" : "Generate next round";

  const standingsList = document.getElementById("standingsList");
  standingsList.innerHTML = "";
  computeStandings().forEach((s, i) => {
    standingsList.appendChild(el(`
      <div class="standing-row ${i === 0 ? "lead" : ""}">
        <span style="color:var(--ink);"><span style="color:var(--ink-soft);margin-right:6px;">${i + 1}.</span>${esc(s.name)}</span>
        <span class="pts">${s.wins}-${s.losses}${s.draws ? "-" + s.draws : ""} · ${s.points} pts</span>
      </div>`));
  });
}

function renderPrizes() {
  const players = playersArray();
  const pool = Object.entries(state.prizePool || {}).map(([id, v]) => ({ id, ...v })).sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
  const draftStarted = !!state.draftStarted;

  document.getElementById("prizeSetupView").style.display = draftStarted ? "none" : "block";
  document.getElementById("prizeActiveView").style.display = draftStarted ? "block" : "none";

  if (!draftStarted) {
    const header = document.getElementById("poolHeader");
    header.innerHTML = pool.length
      ? `<span style="font-size:13px;color:var(--ink-soft);">${pool.length} card${pool.length === 1 ? "" : "s"} in the pool</span>
         <button id="clearPoolBtn" style="background:none;border:none;color:var(--wine);font-size:12.5px;cursor:pointer;">Clear all</button>`
      : "";
    const poolList = document.getElementById("poolList");
    poolList.innerHTML = "";
    pool.forEach((c) => {
      poolList.appendChild(el(`
        <div class="list-item">
          <span style="display:flex;align-items:center;gap:9px;">
            ${cardVisualHTML(c, "thumb")}
            ${esc(c.name)}
          </span>
          <button class="x-btn" data-remove-card="${c.id}">✕</button>
        </div>`));
    });

    document.getElementById("orderWinnerBtn").classList.toggle("active", state.orderMode === "winner-first" && !state.manualOrder);
    document.getElementById("orderLastBtn").classList.toggle("active", state.orderMode === "last-first" && !state.manualOrder);

    const order = computeBaseOrder();
    const orderList = document.getElementById("orderList");
    orderList.innerHTML = "";
    order.forEach((id, i) => {
      orderList.appendChild(el(`
        <div class="order-row">
          <span><span style="color:var(--ink-soft);margin-right:6px;">${i + 1}.</span>${esc(nameOf(id))}</span>
          <div class="btns">
            <button class="icon-btn" data-move="${i}|-1" ${i === 0 ? "disabled" : ""}>▲</button>
            <button class="icon-btn" data-move="${i}|1" ${i === order.length - 1 ? "disabled" : ""}>▼</button>
          </div>
        </div>`));
    });
    if (state.manualOrder) {
      orderList.appendChild(el(`<button id="resetOrderBtn" style="background:none;border:none;color:var(--ink-soft);font-size:12.5px;cursor:pointer;margin-top:4px;">Reset to standings order</button>`));
    }
    document.getElementById("beginDraftBtn").disabled = pool.length === 0 || players.length === 0;
    return;
  }

  // active / complete draft
  const claims = Object.entries(state.claims || {}).map(([id, v]) => ({ id, ...v })).sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const claimedCardIds = new Set(claims.map((c) => c.cardId));
  const remaining = pool.filter((c) => !claimedCardIds.has(c.id));
  const draftComplete = remaining.length === 0;

  document.getElementById("prizeTitle").textContent = draftComplete ? "Prize draft complete" : "Prize draft";
  document.getElementById("prizeSub").textContent = draftComplete ? "Every card has a home." : `Pick ${claims.length + 1} · ${remaining.length} card${remaining.length === 1 ? "" : "s"} left`;
  document.getElementById("undoPickBtn").disabled = claims.length === 0;

  const banner = document.getElementById("pickerBanner");
  if (!draftComplete) {
    banner.style.display = "block";
    banner.textContent = "Now picking: " + nameOf(currentPickerId());
  } else {
    banner.style.display = "none";
  }

  const cardsGrid = document.getElementById("cardsGrid");
  cardsGrid.innerHTML = "";
  cardsGrid.style.display = draftComplete ? "none" : "grid";
  if (!draftComplete) {
    remaining.forEach((c) => {
      cardsGrid.appendChild(el(`
        <button class="card-tile" data-claim="${c.id}">
          ${cardVisualHTML(c, "tile")}
          <div class="card-tile-name">${esc(c.name)}</div>
        </button>`));
    });
  }

  document.getElementById("resultsSub").textContent = draftComplete ? "Final haul for each drafter." : "Filled in as picks happen.";
  const resultsGrid = document.getElementById("resultsGrid");
  resultsGrid.innerHTML = "";
  players.forEach((p) => {
    const cards = claims.filter((c) => c.playerId === p.id).map((c) => pool.find((x) => x.id === c.cardId)).filter(Boolean);
    resultsGrid.appendChild(el(`
      <div class="result-card">
        <div class="pname">${esc(p.name)}</div>
        ${cards.length === 0 ? `<p class="empty">No picks yet</p>` : cards.map((c) => `
          <div class="result-card-item">${cardVisualHTML(c, "mini")}<span>${esc(c.name)}</span></div>`).join("")}
      </div>`));
  });
}

/* ---------------------------------------------------------
   Static event bindings (inputs etc. that don't get re-rendered)
--------------------------------------------------------- */
document.getElementById("eventNameInput").addEventListener("change", (e) => setEventName(e.target.value));

document.getElementById("addPlayerBtn").addEventListener("click", () => {
  const input = document.getElementById("newPlayerInput");
  addPlayer(input.value); input.value = "";
});
document.getElementById("newPlayerInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { addPlayer(e.target.value); e.target.value = ""; }
});

document.getElementById("roundsMinus").addEventListener("click", () => setTotalRounds((state.totalRounds || 3) - 1));
document.getElementById("roundsPlus").addEventListener("click", () => setTotalRounds((state.totalRounds || 3) + 1));
document.getElementById("startTournamentBtn").addEventListener("click", startTournament);
document.getElementById("nextRoundBtn").addEventListener("click", nextRound);
document.getElementById("resetTournamentBtn").addEventListener("click", () => {
  if (confirm("Reset the tournament? This clears all rounds and results.")) resetTournament();
});

document.getElementById("addBulkBtn").addEventListener("click", () => {
  const ta = document.getElementById("bulkCardsInput");
  addBulkCards(ta.value); ta.value = "";
});
document.getElementById("addSingleBtn").addEventListener("click", () => {
  const input = document.getElementById("singleCardInput");
  addSingleCard(input.value); input.value = "";
});
document.getElementById("singleCardInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { addSingleCard(e.target.value); e.target.value = ""; }
});
document.getElementById("orderWinnerBtn").addEventListener("click", () => setOrderMode("winner-first"));
document.getElementById("orderLastBtn").addEventListener("click", () => setOrderMode("last-first"));
document.getElementById("beginDraftBtn").addEventListener("click", beginDraft);
document.getElementById("undoPickBtn").addEventListener("click", undoLastPick);
document.getElementById("restartDraftBtn").addEventListener("click", () => {
  if (confirm("Restart the prize draft? This clears all picks.")) resetPrizeDraft();
});

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => { activeTab = tab.dataset.tab; render(); });
});

// delegated clicks for dynamically rendered lists
document.getElementById("app").addEventListener("click", (e) => {
  const rm = e.target.closest("[data-remove-player]");
  if (rm) return removePlayer(rm.dataset.removePlayer);

  const gm = e.target.closest("[data-game]");
  if (gm) { const [rk, mid, side, delta] = gm.dataset.game.split("|"); return setGameWins(rk, mid, side, parseInt(delta)); }

  const rc = e.target.closest("[data-remove-card]");
  if (rc) return removeCard(rc.dataset.removeCard);

  const cp = e.target.id === "clearPoolBtn" ? true : e.target.closest("#clearPoolBtn");
  if (cp) { if (confirm("Remove all cards from the prize pool?")) clearPool(); return; }

  const mv = e.target.closest("[data-move]");
  if (mv) {
    const [idx, dir] = mv.dataset.move.split("|").map(Number);
    const order = computeBaseOrder();
    const j = idx + dir;
    if (j < 0 || j >= order.length) return;
    [order[idx], order[j]] = [order[j], order[idx]];
    return setManualOrder(order);
  }

  const ro = e.target.id === "resetOrderBtn" ? true : e.target.closest("#resetOrderBtn");
  if (ro) return resetOrderToStandings();

  const cc = e.target.closest("[data-claim]");
  if (cc) return claimCard(cc.dataset.claim);
});
