/* =========================================================
   MTG Draft Night — vanilla JS + Firebase Realtime Database
========================================================= */

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

const emailjsReady = !!(window.emailjs && emailjsConfig.publicKey && emailjsConfig.publicKey !== "YOUR_PUBLIC_KEY");
if (emailjsReady) emailjs.init({ publicKey: emailjsConfig.publicKey });
console.log("[MTG draft] EmailJS ready:", emailjsReady);

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
  players.forEach((p) => {
    stats[p.id] = {
      id: p.id, name: p.name, points: 0, wins: 0, losses: 0, draws: 0, byes: 0,
      matchesPlayed: 0, gamesWon: 0, gamesLost: 0, opponents: [],
    };
  });
  rounds.forEach((round) => {
    round.matches.forEach((m) => {
      if (m.bye) {
        const s = stats[m.p1];
        // a bye counts as a win, and (per standard tournament rules) as a 2-0 game record
        if (s) { s.points += 3; s.wins += 1; s.byes += 1; s.matchesPlayed += 1; s.gamesWon += 2; }
        return;
      }
      const p1Wins = m.p1Wins || 0;
      const p2Wins = m.p2Wins || 0;
      if (p1Wins + p2Wins === 0 || !stats[m.p1] || !stats[m.p2]) return;
      const s1 = stats[m.p1], s2 = stats[m.p2];
      s1.matchesPlayed += 1; s2.matchesPlayed += 1;
      s1.gamesWon += p1Wins; s1.gamesLost += p2Wins;
      s2.gamesWon += p2Wins; s2.gamesLost += p1Wins;
      s1.opponents.push(m.p2); s2.opponents.push(m.p1);
      if (p1Wins > p2Wins) { s1.points += 3; s1.wins += 1; s2.losses += 1; }
      else if (p2Wins > p1Wins) { s2.points += 3; s2.wins += 1; s1.losses += 1; }
      else { s1.points += 1; s2.points += 1; s1.draws += 1; s2.draws += 1; }
    });
  });
  const list = Object.values(stats);
  // Standard tournament tiebreaker math: percentages are floored at 1/3 so a
  // player (or bye) with a very short/rough record doesn't unfairly tank
  // their opponents' numbers.
  const FLOOR = 1 / 3;
  list.forEach((s) => {
    s.matchWinPct = s.matchesPlayed > 0 ? Math.max(FLOOR, s.points / (3 * s.matchesPlayed)) : FLOOR;
    const gamesPlayed = s.gamesWon + s.gamesLost;
    s.gameWinPct = gamesPlayed > 0 ? Math.max(FLOOR, s.gamesWon / gamesPlayed) : FLOOR;
  });
  list.forEach((s) => {
    if (s.opponents.length) {
      s.omw = s.opponents.reduce((sum, oid) => sum + (stats[oid]?.matchWinPct ?? FLOOR), 0) / s.opponents.length;
      s.ogw = s.opponents.reduce((sum, oid) => sum + (stats[oid]?.gameWinPct ?? FLOOR), 0) / s.opponents.length;
    } else { s.omw = 0; s.ogw = 0; }
  });
  // 1. Match points  2. Opponents' match-win %  3. Game-win %  4. Opponents' game-win %
  list.sort((a, b) =>
    b.points - a.points ||
    b.omw - a.omw ||
    b.gameWinPct - a.gameWinPct ||
    b.ogw - a.ogw ||
    a.name.localeCompare(b.name)
  );
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
  if (rounds.length === 0) return generateRound1Pairings();
  return generateSwissPairings(rounds);
}

// Round 1: everyone's tied at 0 points, so standings order is meaningless.
// Pair by seat order instead — the order players were added — so seat 1
// faces seat 6, seat 2 faces seat 7, etc. (opposite ends of the table).
function generateRound1Pairings() {
  const pool = playersArray().map((p) => p.id);
  const matches = [];
  if (pool.length % 2 === 1) {
    matches.push({ p1: pool.pop(), p2: null, bye: true });
  }
  const half = pool.length / 2;
  const top = pool.slice(0, half);
  const bottom = pool.slice(half);
  top.forEach((a, i) => { matches.push({ p1: a, p2: bottom[i], bye: false, p1Wins: 0, p2Wins: 0 }); });
  return matches;
}

// Round 2+: standard Swiss bracket pairing. Priority 1 is that players with
// matching records (score brackets) play each other — winners face other
// winners, etc. Priority 2, applied within that, is dodging repeat
// opponents. A player who can't be paired within their own bracket (odd
// bracket size, or everyone left is a repeat) "floats" down into the next
// bracket rather than forcing a same-bracket rematch.
function generateSwissPairings(rounds) {
  const standings = computeStandings(); // already sorted: points, then OMW%/GW%/OGW% tiebreakers
  let ids = standings.map((s) => s.id);
  const pointsOf = {};
  standings.forEach((s) => { pointsOf[s.id] = s.points; });

  const matches = [];
  if (ids.length % 2 === 1) {
    let byeIdx = -1;
    for (let i = ids.length - 1; i >= 0; i--) if (!hadBye(rounds, ids[i])) { byeIdx = i; break; }
    if (byeIdx === -1) byeIdx = ids.length - 1;
    matches.push({ p1: ids[byeIdx], p2: null, bye: true });
    ids.splice(byeIdx, 1);
  }

  // Group the (already score-sorted) remaining players into brackets of
  // equal match points.
  const brackets = [];
  ids.forEach((id) => {
    const last = brackets[brackets.length - 1];
    if (last && pointsOf[last[0]] === pointsOf[id]) last.push(id);
    else brackets.push([id]);
  });

  let floaters = [];
  brackets.forEach((bracket, bi) => {
    const group = [...floaters, ...bracket];
    floaters = [];
    const used = new Set();
    for (let i = 0; i < group.length; i++) {
      const a = group[i];
      if (used.has(a)) continue;
      let partnerIdx = -1;
      for (let j = i + 1; j < group.length; j++) {
        if (!used.has(group[j]) && !playedBefore(rounds, a, group[j])) { partnerIdx = j; break; }
      }
      if (partnerIdx === -1) {
        // No fresh opponent left in this bracket. On the last bracket we
        // have no lower group to float into, so accept a repeat rather
        // than leave someone unpaired; otherwise float down.
        const isLastBracket = bi === brackets.length - 1;
        if (isLastBracket) {
          for (let j = i + 1; j < group.length; j++) if (!used.has(group[j])) { partnerIdx = j; break; }
        }
      }
      if (partnerIdx === -1) { floaters.push(a); used.add(a); continue; }
      const b = group[partnerIdx];
      used.add(a); used.add(b);
      matches.push({ p1: a, p2: b, bye: false, p1Wins: 0, p2Wins: 0 });
    }
  });

  // Shouldn't normally happen (total player count is even after the bye),
  // but if floaters are left over with nowhere lower to go, pair them off.
  while (floaters.length > 1) {
    matches.push({ p1: floaters.shift(), p2: floaters.shift(), bye: false, p1Wins: 0, p2Wins: 0 });
  }
  return matches;
}

/* ---------------------------------------------------------
   Write actions
--------------------------------------------------------- */
function setEventName(name) { eventRef.child("eventName").set(name); }

function addPlayer(name, email) {
  name = (name || "").trim();
  email = (email || "").trim();
  if (!name || !email || state.started) return;
  const key = newKey("events/" + eventCode + "/players");
  eventRef.child("players/" + key).set({ name, email, addedAt: Date.now() });
}
function removePlayer(id) { if (!state.started) eventRef.child("players/" + id).remove(); }

function setTotalRounds(n) { eventRef.child("totalRounds").set(Math.max(1, Math.min(9, n))); }

function startTournament() {
  const players = playersArray();
  if (players.length < 2) return;
  const matches = generatePairings();
  const roundObj = {};
  matches.forEach((m) => { roundObj[newKey("events/" + eventCode + "/rounds/r0/matches")] = m; });
  const organizerName = document.getElementById("organizerNameInput").value.trim() || "The Organizer";
  const organizerEmail = document.getElementById("organizerEmailInput").value.trim();
  const costAmount = document.getElementById("tournamentCostInput").value.trim();
  const tournamentCost = costAmount ? (costAmount.startsWith("$") ? costAmount : "$" + costAmount) : "";
  const paymentEmail = document.getElementById("paymentEmailInput").value.trim();
  eventRef.update({
    started: true, rounds: { r0: { matches: roundObj } },
    organizerName, organizerEmail, tournamentCost, paymentEmail,
  });
  sendTournamentStartEmails(players, organizerName, tournamentCost, paymentEmail);
  activeTab = "tournament"; render();
}

async function sendTournamentStartEmails(players, organizerName, tournamentCost, paymentEmail) {
  if (!window.emailjs || !tournamentStartEmailConfig || tournamentStartEmailConfig.publicKey === "YOUR_PUBLIC_KEY") {
    console.log("[MTG draft] Tournament-start email not configured — skipping welcome emails.");
    return;
  }
  const eventName = (document.getElementById("eventNameInput").value || eventCode).trim();
  const link = window.location.href;
  const recipients = players.filter((p) => p.email);
  for (const p of recipients) {
    try {
      const res = await emailjs.send(tournamentStartEmailConfig.serviceId, tournamentStartEmailConfig.templateId, {
        to_email: p.email,
        email: p.email,
        organiser: organizerName,
        event_name: eventName,
        tournament_cost: tournamentCost || "0",
        payment_email: paymentEmail || "",
        event_link: link,
      }, tournamentStartEmailConfig.publicKey);
      console.log("[MTG draft] Welcome email sent to", p.email, res.status);
    } catch (err) {
      console.error("[MTG draft] Welcome email FAILED for", p.email, err);
    }
    await sleep(150);
  }
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
   We look up each card by name to grab its art. Two different things can
   happen when there's no image:
     - Scryfall returns 404 "no card found" — this is a strong signal the
       entry just isn't a real card name (a booster pack, a box topper, a
       "mystery prize" line, etc). That's expected and permanent, so we
       don't flag it as a problem or offer to retry it.
     - Any other failure (network hiccup, rate-limit exhausted, etc.) is
       transient — we retry a couple of times, and if it still fails we
       flag it as "missing" so the organizer can retry it manually later.
   Returns { url, notACard }. */
async function fetchCardImage(name, attempt) {
  attempt = attempt || 0;
  try {
    const res = await fetch("https://api.scryfall.com/cards/named?fuzzy=" + encodeURIComponent(name));
    if (res.status === 429 && attempt < 3) {
      await sleep(600 * (attempt + 1));
      return fetchCardImage(name, attempt + 1);
    }
    if (res.status === 404) return { url: null, notACard: true };
    if (!res.ok) return { url: null, notACard: false };
    const data = await res.json();
    let url = null;
    if (data.image_uris && data.image_uris.normal) url = data.image_uris.normal;
    else if (data.card_faces && data.card_faces[0] && data.card_faces[0].image_uris) url = data.card_faces[0].image_uris.normal;
    return { url, notACard: !url };
  } catch (e) {
    if (attempt < 2) { await sleep(600); return fetchCardImage(name, attempt + 1); }
    return { url: null, notACard: false };
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function statusFor(result) { return result.url ? "found" : result.notACard ? "not_a_card" : "none"; }

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
    const result = await fetchCardImage(e2.name);
    eventRef.child("prizePool/" + e2.key).update({ imageUrl: result.url, imageStatus: statusFor(result) });
    await sleep(180);
  }
}
async function addSingleCard(name) {
  name = name.trim();
  if (!name) return;
  const key = newKey("events/" + eventCode + "/prizePool");
  eventRef.child("prizePool/" + key).set({ name, addedAt: Date.now(), imageStatus: "loading" });
  const result = await fetchCardImage(name);
  eventRef.child("prizePool/" + key).update({ imageUrl: result.url, imageStatus: statusFor(result) });
}
async function retryMissingImages() {
  const pool = state.prizePool || {};
  // Only retry genuine transient failures — not entries Scryfall has
  // confirmed aren't real cards (booster packs, box toppers, etc).
  const missing = Object.entries(pool).filter(([, c]) => c.imageStatus === "none");
  for (const [id, c] of missing) {
    eventRef.child("prizePool/" + id + "/imageStatus").set("loading");
    const result = await fetchCardImage(c.name);
    eventRef.child("prizePool/" + id).update({ imageUrl: result.url, imageStatus: statusFor(result) });
    await sleep(180);
  }
}
function removeCard(id) { if (!state.draftStarted) eventRef.child("prizePool/" + id).remove(); }
function clearPool() { if (!state.draftStarted) eventRef.child("prizePool").remove(); }

function computeBaseOrder() {
  // Draft order follows the tournament ranking (winner first), looping back
  // to the top of the ranking each time it reaches the bottom — not snaked.
  return computeStandings().map((s) => s.id);
}

function beginDraft() {
  const pool = state.prizePool || {};
  const players = playersArray();
  if (Object.keys(pool).length === 0 || players.length === 0) return;
  eventRef.update({ draftStarted: true, claims: {}, pickOrderSnapshot: computeBaseOrder(), notifiedPick: -1 });
}

function currentPickerId() {
  const order = state.pickOrderSnapshot || computeBaseOrder();
  const n = order.length;
  if (n === 0) return null;
  const claimsCount = Object.keys(state.claims || {}).length;
  return order[claimsCount % n];
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
function resetPrizeDraft() { eventRef.update({ draftStarted: false, claims: {}, pickOrderSnapshot: null, notifiedPick: -1 }); }

/* ---------------------------------------------------------
   Turn notification emails (EmailJS — no backend needed)
--------------------------------------------------------- */
function sendPickEmail(player) {
  if (!emailjsReady || !player || !player.email) return;
  console.log("[MTG draft] Sending turn-notification email to", player.email, "(" + player.name + ")");
  emailjs.send(emailjsConfig.serviceId, emailjsConfig.templateId, {
    to_email: player.email,
    email: player.email,
    player_name: player.name,
    event_name: state.eventName || eventCode,
    event_link: window.location.href,
  }).then(
    (res) => console.log("[MTG draft] Email sent OK:", res.status, res.text),
    (err) => console.error("[MTG draft] Email FAILED to send:", err)
  );
}

// Called on every render while the draft is active. Uses a Firebase
// transaction as a lock so that even with several browsers/tabs open on
// the same event, only one of them actually sends the email for a given pick.
function notifyCurrentPickerIfNeeded() {
  if (!state.draftStarted) return;
  if (!emailjsReady) { console.log("[MTG draft] EmailJS not configured — skipping turn notification."); return; }
  const pool = state.prizePool || {};
  const claimsCount = Object.keys(state.claims || {}).length;
  if (claimsCount >= Object.keys(pool).length) return; // draft complete, nobody left to notify
  const pickerId = currentPickerId();
  if (!pickerId) return;
  const player = (state.players || {})[pickerId];
  if (!player || !player.email) { console.log("[MTG draft] Current picker has no email on file — skipping notification."); return; }

  eventRef.child("notifiedPick").transaction((current) => {
    if (typeof current !== "number") current = -1;
    if (current >= claimsCount) return; // already notified for this pick — abort, nothing to do
    return claimsCount;
  }, (error, committed) => {
    if (error) { console.error("[MTG draft] Notification lock transaction errored:", error); return; }
    if (!committed) return; // another client already handled this notification
    sendPickEmail({ name: player.name, email: player.email });
  });
}

/* ---------------------------------------------------------
   Render
--------------------------------------------------------- */
function el(html) { const d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstChild; }
function esc(s) { return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

function cardVisualHTML(c, kind) {
  // kind: "thumb" (pool list row), "tile" (draft grid), "mini" (results list)
  const cls = kind === "tile" ? "card-tile-art" : kind === "mini" ? "result-thumb" : "card-thumb";
  if (c.imageUrl) return `<div class="${cls}" data-preview="${esc(c.imageUrl)}"><img src="${c.imageUrl}" alt="${esc(c.name)}" loading="lazy" /></div>`;
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

  const payBadge = document.getElementById("paymentInfoBadge");
  if (state.started) {
    payBadge.style.display = "inline-block";
    document.getElementById("paymentInfoPanel").innerHTML = `
      <div class="row"><b>Organizer</b>${esc(state.organizerName || "—")}</div>
      <div class="row"><b>Contact email</b>${esc(state.organizerEmail || "—")}</div>
      <div class="row"><b>Entry cost</b>${esc(displayCost(state.tournamentCost))}</div>
      <div class="row"><b>Payment info</b>${esc(state.paymentEmail || "—")}</div>
    `;
  } else {
    payBadge.style.display = "none";
  }

  renderPlayers();
  renderTournament();
  renderResults();
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
      <div class="list-item" style="align-items:flex-start;">
        <span>
          <span style="color:var(--ink-soft);margin-right:6px;font-size:12.5px;">${i + 1}.</span>${esc(p.name)}
          ${p.email ? `<div style="font-size:11.5px;color:var(--ink-soft);margin-top:2px;">${esc(p.email)}</div>` : ""}
        </span>
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

  const orgInput = document.getElementById("organizerNameInput");
  const orgEmailInput = document.getElementById("organizerEmailInput");
  const costInput = document.getElementById("tournamentCostInput");
  const payInput = document.getElementById("paymentEmailInput");
  if (document.activeElement !== orgInput) orgInput.value = state.organizerName || "";
  if (document.activeElement !== orgEmailInput) orgEmailInput.value = state.organizerEmail || "";
  if (document.activeElement !== costInput) costInput.value = (state.tournamentCost || "").replace(/^\$/, "");
  if (document.activeElement !== payInput) payInput.value = state.paymentEmail || "";

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
            <span class="pname" style="grid-column:1;grid-row:1;">${esc(nameOf(m.p1))}</span>
            <span class="pname right" style="grid-column:3;grid-row:1;">${esc(nameOf(m.p2))}</span>
            <div class="games-stepper" style="grid-column:1;grid-row:2;justify-self:start;">
              <button class="icon-btn" data-game="${last.key}|${m.id}|p1|-1" ${p1w <= 0 ? "disabled" : ""}>−</button>
              <span class="games-count ${p1w > p2w ? "ahead" : ""}">${p1w}</span>
              <button class="icon-btn" data-game="${last.key}|${m.id}|p1|1" ${p1w >= 2 ? "disabled" : ""}>+</button>
            </div>
            <span class="games-label" style="grid-column:2;grid-row:2;justify-self:center;">games won</span>
            <div class="games-stepper" style="grid-column:3;grid-row:2;justify-self:end;">
              <button class="icon-btn" data-game="${last.key}|${m.id}|p2|-1" ${p2w <= 0 ? "disabled" : ""}>−</button>
              <span class="games-count ${p2w > p1w ? "ahead" : ""}">${p2w}</span>
              <button class="icon-btn" data-game="${last.key}|${m.id}|p2|1" ${p2w >= 2 ? "disabled" : ""}>+</button>
            </div>
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

function pct(n) { return (n * 100).toFixed(1) + "%"; }
function displayCost(v) {
  if (!v) return "—";
  return v.startsWith("$") ? v : "$" + v;
}

function renderResults() {
  const wrap = document.getElementById("resultsTable");
  const standings = computeStandings();
  wrap.innerHTML = "";
  wrap.appendChild(el(`
    <div class="results-table-row header">
      <span>#</span><span>Player</span><span class="stat">Match pts</span>
      <span class="stat">OMW%</span><span class="stat">GW%</span><span class="stat">OGW%</span>
    </div>`));
  if (standings.length === 0) {
    wrap.appendChild(el(`<p style="color:var(--ink-soft);font-size:14px;">No players yet.</p>`));
    return;
  }
  standings.forEach((s, i) => {
    wrap.appendChild(el(`
      <div class="results-table-row data ${i === 0 ? "lead" : ""}">
        <span style="color:var(--ink-soft);">${i + 1}</span>
        <span>${esc(s.name)}</span>
        <span class="stat">${s.points}</span>
        <span class="stat">${pct(s.omw)}</span>
        <span class="stat">${pct(s.gameWinPct)}</span>
        <span class="stat">${pct(s.ogw)}</span>
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

    const missingCount = pool.filter((c) => c.imageStatus === "none").length;
    const retryBtn = document.getElementById("retryImagesBtn");
    retryBtn.style.display = missingCount > 0 ? "inline-block" : "none";
    retryBtn.textContent = "🔄 Retry missing card images (" + missingCount + ")";

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
    notifyCurrentPickerIfNeeded();
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
  const emailInput = document.getElementById("newPlayerEmailInput");
  const name = input.value.trim();
  const email = emailInput.value.trim();
  if (!name || !email) {
    alert("Please enter both a player name and an email address — email is required for every player.");
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    alert("That doesn't look like a valid email address — please double check it.");
    return;
  }
  addPlayer(name, email); input.value = ""; emailInput.value = "";
});
document.getElementById("newPlayerInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("addPlayerBtn").click();
});
document.getElementById("newPlayerEmailInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("addPlayerBtn").click();
});

document.getElementById("roundsMinus").addEventListener("click", () => setTotalRounds((state.totalRounds || 3) - 1));
document.getElementById("roundsPlus").addEventListener("click", () => setTotalRounds((state.totalRounds || 3) + 1));
document.getElementById("startTournamentBtn").addEventListener("click", startTournament);
document.getElementById("organizerNameInput").addEventListener("change", (e) => eventRef.child("organizerName").set(e.target.value.trim()));
document.getElementById("organizerEmailInput").addEventListener("change", (e) => eventRef.child("organizerEmail").set(e.target.value.trim()));
document.getElementById("tournamentCostInput").addEventListener("change", (e) => {
  const v = e.target.value.trim();
  eventRef.child("tournamentCost").set(v ? (v.startsWith("$") ? v : "$" + v) : "");
});
document.getElementById("paymentEmailInput").addEventListener("change", (e) => eventRef.child("paymentEmail").set(e.target.value.trim()));
document.getElementById("nextRoundBtn").addEventListener("click", nextRound);
document.getElementById("resetTournamentBtn").addEventListener("click", () => {
  if (confirm("Reset the tournament? This clears all rounds and results.")) resetTournament();
});

document.getElementById("addBulkBtn").addEventListener("click", () => {
  const ta = document.getElementById("bulkCardsInput");
  addBulkCards(ta.value); ta.value = "";
});
document.getElementById("retryImagesBtn").addEventListener("click", () => retryMissingImages());
document.getElementById("addSingleBtn").addEventListener("click", () => {
  const input = document.getElementById("singleCardInput");
  addSingleCard(input.value); input.value = "";
});
document.getElementById("singleCardInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { addSingleCard(e.target.value); e.target.value = ""; }
});
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

  const cc = e.target.closest("[data-claim]");
  if (cc) return claimCard(cc.dataset.claim);
});

/* ---------------------------------------------------------
   Hover-to-preview: full-size card art on rollover
--------------------------------------------------------- */
const cardPreview = document.getElementById("cardPreview");
const cardPreviewImg = document.getElementById("cardPreviewImg");

function positionCardPreview(e) {
  const pad = 18;
  let x = e.clientX + pad;
  let y = e.clientY + pad;
  if (x + 280 > window.innerWidth) x = e.clientX - 280 - pad;
  if (y + 380 > window.innerHeight) y = Math.max(10, window.innerHeight - 390);
  cardPreview.style.left = x + "px";
  cardPreview.style.top = y + "px";
}

document.addEventListener("mouseover", (e) => {
  const t = e.target.closest("[data-preview]");
  if (!t) return;
  cardPreviewImg.src = t.dataset.preview;
  positionCardPreview(e);
  cardPreview.style.display = "block";
});
document.addEventListener("mousemove", (e) => {
  if (cardPreview.style.display === "block") positionCardPreview(e);
});
document.addEventListener("mouseout", (e) => {
  const t = e.target.closest("[data-preview]");
  if (!t) return;
  if (t.contains(e.relatedTarget)) return;
  cardPreview.style.display = "none";
});
