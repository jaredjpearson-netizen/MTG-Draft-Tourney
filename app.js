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
        eventName: "Friday Night Draft",
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
      if (!m.result || !stats[m.p1] || !stats[m.p2]) return;
      stats[m.p1].opponents.push(m.p2);
      stats[m.p2].opponents.push(m.p1);
      if (m.result === "p1") { stats[m.p1].points += 3; stats[m.p1].wins += 1; stats[m.p2].losses += 1; }
      else if (m.result === "p2") { stats[m.p2].points += 3; stats[m.p2].wins += 1; stats[m.p1].losses += 1; }
      else if (m.result === "draw") { stats[m.p1].points += 1; stats[m.p2].points += 1; stats[m.p1].draws += 1; stats[m.p2].draws += 1; }
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
    matches.push({ p1: byeId, p2: null, bye: true, result: "p1" });
  }
  const unpaired = [...pool];
  while (unpaired.length > 0) {
    const a = unpaired.shift();
    let bIdx = unpaired.findIndex((b) => !playedBefore(rounds, a, b));
    if (bIdx === -1) bIdx = 0;
    const b = unpaired.splice(bIdx, 1)[0];
    if (b !== undefined) matches.push({ p1: a, p2: b, bye: false, result: null });
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

function setResult(roundKey, matchId, result) {
  const path = "rounds/" + roundKey + "/matches/" + matchId + "/result";
  const current = ((state.rounds || {})[roundKey]?.matches || {})[matchId]?.result;
  eventRef.child(path).set(current === result ? null : result);
}

function nextRound() {
  const rounds = roundsArray();
  if (rounds.length >= (state.totalRounds || 3)) return;
  const last = rounds[rounds.length - 1];
  const complete = last.matches.every((m) => m.bye || m.result);
  if (!complete) return;
  const matches = generatePairings();
  const key = "r" + rounds.length;
  const roundObj = {};
  matches.forEach((m) => { roundObj[newKey("events/" + eventCode + "/rounds/" + key + "/matches")] = m; });
  eventRef.child("rounds/" + key).set({ matches: roundObj });
}

function resetTournament() { eventRef.update({ started: false, rounds: {} }); }

function addBulkCards(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return;
  const updates = {};
  lines.forEach((name) => { updates["prizePool/" + newKey("events/" + eventCode + "/prizePool")] = { name, addedAt: Date.now() }; });
  eventRef.update(updates);
}
function addSingleCard(name) {
  if (!name.trim()) return;
  const key = newKey("events/" + eventCode + "/prizePool");
  eventRef.child("prizePool/" + key).set({ name: name.trim(), addedAt: Date.now() });
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
    : "Add everyone who's drafting tonight.";
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
  const complete = last ? last.matches.every((m) => m.bye || m.result) : true;
  const done = rounds.length >= totalRounds && complete;

  document.getElementById("roundTitle").textContent = done ? "Final round" : `Round ${rounds.length} of ${totalRounds}`;
  document.getElementById("roundSub").textContent = done ? "All rounds complete — head to Prize draft when you're ready." : "Tap a result to record it.";

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
        matchesList.appendChild(el(`
          <div class="match-row">
            <span class="pname">${esc(nameOf(m.p1))}</span>
            <div class="result-btns">
              <button class="btn small ${m.result === "p1" ? "active" : ""}" data-result="${last.key}|${m.id}|p1">Win</button>
              <button class="btn small wine ${m.result === "draw" ? "active" : ""}" data-result="${last.key}|${m.id}|draw">Draw</button>
              <button class="btn small ${m.result === "p2" ? "active" : ""}" data-result="${last.key}|${m.id}|p2">Win</button>
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
        <span><span style="color:var(--ink-soft);margin-right:6px;">${i + 1}.</span>${esc(s.name)}</span>
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
          ${esc(c.name)}
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
      cardsGrid.appendChild(el(`<button class="card-tile" data-claim="${c.id}">${esc(c.name)}</button>`));
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
        ${cards.length === 0 ? `<p class="empty">No picks yet</p>` : `<ul>${cards.map((c) => `<li>${esc(c.name)}</li>`).join("")}</ul>`}
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

  const res = e.target.closest("[data-result]");
  if (res) { const [rk, mid, r] = res.dataset.result.split("|"); return setResult(rk, mid, r); }

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
