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
let usdToCad = null;       // exchange rate for card prices, loaded once per page load
let usdToCadApprox = false;
let editingPlayerId = null; // player whose name/email is being edited on this device
let viewedRoundKey = null;
let editingPairings = false; // organizer is swapping players in the current round (this device only)
let swapPick = null;         // first player tapped while editing pairings: { matchId, side } // a past round being looked back at on the Tournament tab; null = current round

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

function computeDefaultTab() {
  const started = !!state.started;
  const draftStarted = !!state.draftStarted;
  const poolCount = Object.keys(state.prizePool || {}).length;
  const claimsCount = Object.keys(state.claims || {}).length;

  if (draftStarted) {
    const draftComplete = poolCount > 0 && claimsCount >= poolCount;
    return draftComplete ? "results" : "prizes";
  }
  if (started) {
    const rounds = roundsArray();
    const totalRounds = state.totalRounds || 3;
    const last = rounds[rounds.length - 1];
    const roundComplete = last ? last.matches.every(matchComplete) : true;
    const tournamentDone = rounds.length >= totalRounds && roundComplete;
    return tournamentDone ? "results" : "tournament";
  }
  return "players";
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
        createdAt: Date.now(),
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

  let initialTabSet = false;
  let hadData = false;
  const thisRef = eventRef;
  eventRef.on("value", (snap) => {
    if (eventRef !== thisRef) return; // we've already left this event
    if (hadData && !snap.exists()) { leaveEvent(); alert("This event was deleted by the organizer."); return; }
    if (snap.exists()) hadData = true;
    state = snap.val() || {};
    if (!initialTabSet) { activeTab = computeDefaultTab(); initialTabSet = true; }
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

document.getElementById("codeBadge").addEventListener("click", () => leaveEvent());
function leaveEvent() {
  if (eventRef) eventRef.off();
  eventCode = null; eventRef = null; state = {};
  const url = new URL(window.location.href);
  url.searchParams.delete("event");
  window.history.replaceState({}, "", url);
  appRoot.style.display = "none";
  joinScreen.style.display = "block";
  joinCodeInput.value = "";
}

/* ---------------------------------------------------------
   Manage tournaments (start screen)
   Listing every event needs read access to the whole "events" node, which
   the database rules only give to the signed-in admin account (adminEmail
   in firebase-config.js). The master password is that account's password,
   checked by Firebase, so it never appears in this code.
--------------------------------------------------------- */
const auth = firebase.auth ? firebase.auth() : null;
const manageScreen = document.getElementById("manageScreen");
const manageError = document.getElementById("manageError");

function showManage() {
  joinScreen.style.display = "none";
  manageScreen.style.display = "block";
  manageError.textContent = "";
  if (auth && auth.currentUser) loadAllEvents();
  else {
    document.getElementById("manageLogin").style.display = "block";
    document.getElementById("manageList").style.display = "none";
    document.getElementById("masterPasswordInput").focus();
  }
}
function hideManage() {
  manageScreen.style.display = "none";
  joinScreen.style.display = "block";
}
async function masterLogin() {
  const input = document.getElementById("masterPasswordInput");
  manageError.textContent = "";
  if (!auth) { manageError.textContent = "Sign-in didn't load. Check your connection and refresh."; return; }
  try {
    await auth.signInWithEmailAndPassword(adminEmail, input.value);
    input.value = "";
    loadAllEvents();
  } catch (err) {
    console.error("[MTG draft] Master sign-in failed:", err);
    manageError.textContent = /wrong-password|invalid-credential|invalid-login/.test(err.code || "")
      ? "That password isn't right."
      : "Couldn't sign in (" + (err.code || err.message) + "). Check the Manage tournaments setup in the README.";
  }
}
function lastActivity(ev) {
  let t = ev.createdAt || 0;
  const bump = (obj, field) => Object.values(obj || {}).forEach((x) => { if (x && x[field] > t) t = x[field]; });
  bump(ev.players, "addedAt"); bump(ev.prizePool, "addedAt"); bump(ev.claims, "ts");
  return t;
}
function eventStatus(ev) {
  const rounds = Object.keys(ev.rounds || {}).length;
  const pool = Object.keys(ev.prizePool || {}).length;
  const claims = Object.keys(ev.claims || {}).length;
  if (ev.draftStarted) return claims >= pool ? "Prize draft finished" : "Prize draft in progress";
  if (ev.started) return `Round ${rounds} of ${ev.totalRounds || 3}`;
  return "Not started";
}
async function loadAllEvents() {
  document.getElementById("manageLogin").style.display = "none";
  document.getElementById("manageList").style.display = "block";
  const list = document.getElementById("eventsList");
  list.innerHTML = `<p class="manage-empty">Loading…</p>`;
  let all;
  try {
    all = (await db.ref("events").once("value")).val() || {};
  } catch (err) {
    console.error("[MTG draft] Couldn't list events:", err);
    list.innerHTML = `<p class="manage-error">The database wouldn't list the tournaments. The Firebase rules probably need the update described in the README under "Manage tournaments".</p>`;
    return;
  }
  const events = Object.entries(all).map(([code, ev]) => ({ code, ev, last: lastActivity(ev) })).sort((a, b) => b.last - a.last);
  document.getElementById("manageCount").textContent = `${events.length} tournament${events.length === 1 ? "" : "s"}`;
  list.innerHTML = events.length ? "" : `<p class="manage-empty">No tournaments yet.</p>`;
  events.forEach(({ code, ev, last }) => {
    const players = Object.keys(ev.players || {}).length;
    list.appendChild(el(`
      <div class="event-row">
        <div class="event-info">
          <div class="event-name">${esc(ev.eventName || code)} <span class="event-code">${esc(code)}</span></div>
          <div class="event-meta">${players} player${players === 1 ? "" : "s"} · ${eventStatus(ev)}${last ? " · " + new Date(last).toLocaleDateString() : ""}</div>
        </div>
        <div class="event-actions">
          <button class="btn small" data-open-event="${esc(code)}">Open</button>
          <button class="btn small wine" data-delete-event="${esc(code)}">🗑 Delete</button>
        </div>
      </div>`));
  });
}
document.getElementById("manageBtn").addEventListener("click", showManage);
document.getElementById("manageBackBtn").addEventListener("click", hideManage);
document.getElementById("masterLoginBtn").addEventListener("click", masterLogin);
document.getElementById("masterPasswordInput").addEventListener("keydown", (e) => { if (e.key === "Enter") masterLogin(); });
document.getElementById("manageSignOutBtn").addEventListener("click", async () => { if (auth) await auth.signOut(); showManage(); });
document.getElementById("eventsList").addEventListener("click", async (e) => {
  const open = e.target.closest("[data-open-event]");
  if (open) { manageScreen.style.display = "none"; return openEvent(open.dataset.openEvent); }
  const del = e.target.closest("[data-delete-event]");
  if (del) {
    const code = del.dataset.deleteEvent;
    if (!confirm(`Delete tournament ${code} for everyone? This removes all its players, results and prizes, and can't be undone.`)) return;
    await db.ref("events/" + code).remove();
    loadAllEvents();
  }
});

// auto-join if ?event=CODE is in the URL
(function initFromUrl() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("event");
  if (code) openEvent(code);
})();

/* ---------------------------------------------------------
   Organizer PIN
   An optional PIN that guards the big actions (generating rounds, resets,
   drops, starting/undoing the prize draft, deleting the event). It's a
   speed bump against accidents and casual meddling, not real security:
   only a hash is stored, but the database itself is still open. Once
   entered correctly on a device, that device isn't asked again.
--------------------------------------------------------- */
async function hashPin(pin) {
  const data = new TextEncoder().encode(eventCode + ":" + pin);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function unlockKey() { return "mtg-organizer-" + eventCode; }
async function requireOrganizer() {
  if (!state.organizerPinHash) return true;
  try { if (localStorage.getItem(unlockKey()) === state.organizerPinHash) return true; } catch (e) {}
  const pin = prompt("Enter the organizer PIN to do this.");
  if (pin === null) return false;
  if ((await hashPin(pin.trim())) !== state.organizerPinHash) { alert("That PIN isn't right."); return false; }
  try { localStorage.setItem(unlockKey(), state.organizerPinHash); } catch (e) {}
  return true;
}
// Wraps an action so it only runs once the organizer PIN (if any) checks out.
function organizerOnly(fn) {
  return async (...args) => { if (await requireOrganizer()) fn(...args); };
}
async function setOrganizerPin(pin) {
  pin = (pin || "").trim();
  if (!(await requireOrganizer())) return;
  const hash = pin ? await hashPin(pin) : null;
  eventRef.child("organizerPinHash").set(hash);
  try { if (hash) localStorage.setItem(unlockKey(), hash); } catch (e) {}
}


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
      id: p.id, name: p.name, dropped: !!p.dropped, points: 0, wins: 0, losses: 0, draws: 0, byes: 0,
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
      if (!matchComplete(m) || !stats[m.p1] || !stats[m.p2]) return;
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
    // Everyone's tied, so the bye goes to a random player rather than
    // always the last seat.
    const [byeId] = pool.splice(Math.floor(Math.random() * pool.length), 1);
    matches.push({ p1: byeId, p2: null, bye: true });
  }
  const half = pool.length / 2;
  const top = pool.slice(0, half);
  const bottom = pool.slice(half);
  top.forEach((a, i) => { matches.push({ p1: a, p2: bottom[i], bye: false, p1Wins: 0, p2Wins: 0 }); });
  return matches;
}

// Round 2+: Swiss pairing. Players are taken in standings order and each is
// paired with the closest-ranked opponent they haven't played yet, so people
// with matching records face each other wherever possible and anyone who
// can't be matched in their own bracket floats to the nearest one. Unlike a
// simple greedy pass, this backtracks: if an early choice would leave two
// players at the bottom who already met, it goes back and tries the next
// option. A rematch is only allowed when no rematch-free pairing exists.
function generateSwissPairings(rounds) {
  const standings = computeStandings(); // already sorted: points, then OMW%/GW%/OGW% tiebreakers
  const ids = standings.map((s) => s.id).filter((id) => !isDropped(id));

  // Bye candidates: lowest-ranked player who hasn't had one comes first.
  // Everyone else (if all have had one) follows, still bottom-up.
  let byeCandidates = [null];
  if (ids.length % 2 === 1) {
    const reversed = [...ids].reverse();
    byeCandidates = [...reversed.filter((id) => !hadBye(rounds, id)), ...reversed.filter((id) => hadBye(rounds, id))];
  }

  // Try 0 rematches first, then 1, 2, … until a pairing is found.
  for (let allowedRematches = 0; allowedRematches <= ids.length; allowedRematches++) {
    for (const byeId of byeCandidates) {
      const pool = ids.filter((id) => id !== byeId);
      const pairs = pairSwiss(pool, (a, b) => playedBefore(rounds, a, b), allowedRematches);
      if (!pairs) continue;
      const matches = pairs.map(([a, b]) => ({ p1: a, p2: b, bye: false, p1Wins: 0, p2Wins: 0 }));
      if (byeId) matches.unshift({ p1: byeId, p2: null, bye: true });
      return matches;
    }
  }
  return [];
}

// Pairs an even-length list of ids (in standings order) by backtracking.
// Returns an array of [a, b] pairs, or null if it can't be done with at most
// `rematchesLeft` repeat matchups.
function pairSwiss(pool, metBefore, rematchesLeft) {
  if (pool.length === 0) return [];
  const [a, ...rest] = pool;
  for (let j = 0; j < rest.length; j++) {
    const b = rest[j];
    const isRematch = metBefore(a, b);
    if (isRematch && rematchesLeft === 0) continue;
    const remaining = rest.filter((_, k) => k !== j);
    const tail = pairSwiss(remaining, metBefore, rematchesLeft - (isRematch ? 1 : 0));
    if (tail) return [[a, b], ...tail];
  }
  return null;
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
// Dropping keeps a player's past results (they still count for standings and
// opponents' tiebreakers) but leaves them out of every future round.
function savePlayerEdit(id, name, email) {
  name = (name || "").trim();
  email = (email || "").trim();
  if (!name || !email) { alert("Please enter both a player name and an email address."); return false; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { alert("That doesn't look like a valid email address — please double check it."); return false; }
  eventRef.child("players/" + id).update({ name, email });
  return true;
}
function setDropped(id, dropped) { if (state.started) eventRef.child("players/" + id + "/dropped").set(dropped ? true : null); }
function isDropped(id) { return !!((state.players || {})[id] || {}).dropped; }

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
// The winner of a finished match (or the player with a bye); null otherwise.
function matchWinner(m) {
  if (m.bye) return m.p1;
  if (!matchComplete(m)) return null;
  return (m.p1Wins || 0) > (m.p2Wins || 0) ? m.p1 : m.p2;
}
function trophy() { return `<span class="win-trophy" title="Winner">🏆</span>`; }
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
   fetchCardImage returns { url, notACard, priceUsd }, plus failed: true when Scryfall couldn't be reached. */
// GET from Scryfall, backing off politely if it says we're going too fast
// (HTTP 429), honouring its Retry-After header when it sends one.
async function scryfallGet(url) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try { res = await fetch(url); }
    catch (e) { if (attempt < 2) { await sleep(800); continue; } return { status: 0 }; }
    if (res.status === 429 && attempt < 5) {
      const wait = (parseFloat(res.headers.get("Retry-After")) || 0) * 1000 || 1000 * 2 ** attempt;
      console.log("[MTG draft] Scryfall asked us to slow down — waiting", wait, "ms");
      await sleep(wait);
      continue;
    }
    if (!res.ok) return { status: res.status };
    return { status: res.status, data: await res.json() };
  }
}
function usdOf(prices) {
  const p = prices || {};
  const usd = parseFloat(p.usd || p.usd_foil || p.usd_etched);
  return isNaN(usd) ? null : usd;
}
async function fetchCardImage(name) {
  const { status, data } = await scryfallGet("https://api.scryfall.com/cards/named?fuzzy=" + encodeURIComponent(name));
  if (status === 404) return { url: null, notACard: true };
  if (!data) return { url: null, notACard: false, failed: true, status };
  let url = null;
  if (data.image_uris && data.image_uris.normal) url = data.image_uris.normal;
  else if (data.card_faces && data.card_faces[0] && data.card_faces[0].image_uris) url = data.card_faces[0].image_uris.normal;
  // Scryfall's prices are USD market prices for the card's default printing;
  // fall back to the foil/etched price for cards that only exist that way.
  const priceUsd = usdOf(data.prices);
  const face = (data.card_faces && data.card_faces[0]) || {};
  const colors = (data.colors || face.colors || []).join("");
  return { url, notACard: !url, priceUsd, rarity: data.rarity || null, colors };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function statusFor(result) { return result.url ? "found" : result.notACard ? "not_a_card" : "none"; }
function cardFields(result) {
  return { imageUrl: result.url, imageStatus: statusFor(result), priceUsd: result.priceUsd ?? null,
           rarity: result.rarity ?? null, colors: result.colors ?? null };
}

// Prize grid sort. Each viewer picks their own order; exotic (unpriced)
// prizes always come first, in the order they were added.
function prizeSort() {
  try { return localStorage.getItem("mtg-prize-sort") || "price"; } catch (e) { return "price"; }
}
function setPrizeSort(mode) {
  try { localStorage.setItem("mtg-prize-sort", mode); } catch (e) {}
  if (mode !== "price") backfillCardDetails();
  render();
}
function rarityRank(c) {
  const order = ["special", "bonus", "mythic", "rare", "uncommon", "common"];
  const i = order.indexOf(c.rarity);
  return i < 0 ? order.length : i;
}
// Mono colours in WUBRG order, then multicolour, then colourless.
function colorRank(c) {
  const col = c.colors || "";
  if (col.length === 1) return "WUBRG".indexOf(col);
  return col.length > 1 ? 5 : 6;
}
function sortPrizes(cards, mode) {
  const byPrice = (a, b) => cardCad(b) - cardCad(a);
  const rank = mode === "rarity" ? rarityRank : mode === "color" ? colorRank : null;
  return cards.slice().sort((a, b) => {
    const va = cardCad(a), vb = cardCad(b);
    if (va == null || vb == null) return (va == null ? 0 : 1) - (vb == null ? 0 : 1);
    return (rank ? rank(a) - rank(b) : 0) || byPrice(a, b) || a.name.localeCompare(b.name);
  });
}
// Cards added before rarity/colours were saved get them filled in the first
// time someone sorts by rarity or colour.
async function backfillCardDetails() {
  if (backfillCardDetails.running) return;
  backfillCardDetails.running = true;
  const missing = Object.entries(state.prizePool || {})
    .filter(([, c]) => c.imageStatus !== "not_a_card" && (c.rarity == null || c.colors == null));
  for (const [id, c] of missing) {
    const result = await fetchCardImage(c.name);
    if (!result.failed && !result.notACard) eventRef.child("prizePool/" + id).update({ rarity: result.rarity, colors: result.colors });
    await sleep(250);
  }
  backfillCardDetails.running = false;
}

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
    eventRef.child("prizePool/" + e2.key).update(cardFields(result));
    await sleep(250);
  }
}
async function addSingleCard(name) {
  name = name.trim();
  if (!name) return;
  const key = newKey("events/" + eventCode + "/prizePool");
  eventRef.child("prizePool/" + key).set({ name, addedAt: Date.now(), imageStatus: "loading" });
  const result = await fetchCardImage(name);
  eventRef.child("prizePool/" + key).update(cardFields(result));
}
async function retryMissingImages() {
  const pool = state.prizePool || {};
  // Only retry genuine transient failures — not entries Scryfall has
  // confirmed aren't real cards (booster packs, box toppers, etc).
  const missing = Object.entries(pool).filter(([, c]) => c.imageStatus === "none");
  for (const [id, c] of missing) {
    eventRef.child("prizePool/" + id + "/imageStatus").set("loading");
    const result = await fetchCardImage(c.name);
    eventRef.child("prizePool/" + id).update(cardFields(result));
    await sleep(250);
  }
}
// Re-checks Scryfall prices for every real card in the pool (also fills in
// prices for cards added before prices existed). Hand-entered prices win.
async function refreshPrices(onProgress) {
  const pool = state.prizePool || {};
  const cards = Object.entries(pool).filter(([, c]) => c.imageStatus !== "not_a_card");
  const tally = { priced: 0, noPrice: [], failed: [] };
  for (const [i, [id, c]] of cards.entries()) {
    if (onProgress) onProgress(i + 1, cards.length);
    const result = await fetchCardImage(c.name);
    if (result.failed) {
      tally.failed.push(c.name);
      console.warn("[MTG draft] Price lookup failed for", c.name, "(HTTP " + result.status + ")");
    } else {
      eventRef.child("prizePool/" + id).update(cardFields(result));
      if (result.priceUsd != null) tally.priced++;
      else tally.noPrice.push(c.name);
    }
    await sleep(250);
  }
  return tally;
}
function setManualPrice(id) {
  const c = (state.prizePool || {})[id];
  if (!c) return;
  const current = c.priceCad != null ? c.priceCad.toFixed(2) : "";
  const input = prompt(`Price for "${c.name}" in CAD. Leave blank to use the Scryfall price.`, current);
  if (input === null) return;
  const v = parseFloat(input.replace(/[$,\s]/g, ""));
  eventRef.child("prizePool/" + id + "/priceCad").set(input.trim() === "" || isNaN(v) ? null : Math.round(v * 100) / 100);
}

/* USD -> CAD. Fetched once per page load from free, keyless exchange-rate
   APIs. If both are unreachable we fall back to a rough fixed rate and say so. */
(async function loadExchangeRate() {
  const sources = [
    ["https://api.frankfurter.app/latest?from=USD&to=CAD", (d) => d.rates && d.rates.CAD],
    ["https://open.er-api.com/v6/latest/USD", (d) => d.rates && d.rates.CAD],
  ];
  for (const [url, pick] of sources) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const rate = pick(await res.json());
      if (rate) { usdToCad = rate; console.log("[MTG draft] USD→CAD rate:", rate); if (eventRef) render(); return; }
    } catch (e) {}
  }
  usdToCad = 1.38; usdToCadApprox = true;
  console.log("[MTG draft] Couldn't load an exchange rate — using an approximate 1.38.");
  if (eventRef) render();
})();
function cardCad(c) {
  if (c.priceCad != null) return c.priceCad;
  if (c.priceUsd != null && usdToCad) return c.priceUsd * usdToCad;
  return null;
}
function money(v) { return "$" + v.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function poolTotalHTML(cards) {
  const priced = cards.map(cardCad).filter((v) => v != null);
  const unpriced = cards.length - priced.length;
  const total = priced.reduce((a, b) => a + b, 0);
  return `Total value: <b>${money(total)} CAD</b>${usdToCadApprox ? " (approx. rate)" : ""}` +
    (unpriced ? ` · ${unpriced} item${unpriced === 1 ? "" : "s"} without a price` : "");
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
  if (state.pickEmailsOff) return; // organizer turned turn emails off (e.g. everyone's in the room)
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

// editable: the setup pool list, where tapping the price lets you type one in
// (handy for booster packs and other non-cards Scryfall can't price).
function priceTagHTML(c, editable) {
  const v = cardCad(c);
  const text = v != null ? money(v) : editable ? "+ price" : "";
  if (!text) return "";
  const title = c.priceCad != null ? "Price entered by hand" : "Scryfall market price (converted to CAD)";
  return editable
    ? `<button class="price-tag edit ${v == null ? "empty" : ""}" data-set-price="${c.id}" title="${title}. Tap to change.">${text}</button>`
    : `<span class="price-tag" title="${title}">${text}</span>`;
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
    ? "No new players once the tournament has started. ✎ fixes a name or email; dropping a player keeps their results so far but leaves them out of future rounds."
    : "Add everyone who's drafting.";
  document.getElementById("addPlayerRow").style.display = state.started ? "none" : "flex";

  const list = document.getElementById("playersList");
  // Keep whatever's been typed into an open edit form across live re-renders.
  const draftName = document.getElementById("editNameInput")?.value;
  const draftEmail = document.getElementById("editEmailInput")?.value;
  if (editingPlayerId && !(state.players || {})[editingPlayerId]) editingPlayerId = null;
  list.innerHTML = "";
  if (players.length === 0) {
    list.appendChild(el(`<p style="color:var(--ink-soft);font-size:14px;">No players yet — add a name above to get started.</p>`));
    return;
  }
  players.forEach((p, i) => {
    if (p.id === editingPlayerId) {
      list.appendChild(el(`
        <div class="list-item editing">
          <input type="text" id="editNameInput" value="${esc(draftName ?? p.name)}" placeholder="Player name" />
          <input type="email" id="editEmailInput" value="${esc(draftEmail ?? p.email ?? "")}" placeholder="Email address" />
          <div style="display:flex;gap:6px;">
            <button class="btn small" data-save-player="${p.id}">Save</button>
            <button class="btn small wine" data-cancel-edit>Cancel</button>
          </div>
        </div>`));
      return;
    }
    const row = el(`
      <div class="list-item player-item ${p.dropped ? "dropped" : ""}">
        <span class="player-info">
          <span style="color:var(--ink-soft);margin-right:6px;font-size:12.5px;">${i + 1}.</span>${esc(p.name)}${p.dropped ? ` <span class="dropped-tag">dropped</span>` : ""}
          ${p.email ? `<div class="player-email">${esc(p.email)}</div>` : ""}
        </span>
        <span class="player-actions">
          <button class="x-btn" data-edit-player="${p.id}" title="Edit name or email">✎</button>
          ${!state.started ? `<button class="x-btn" data-remove-player="${p.id}">✕</button>`
            : `<button class="drop-btn" data-drop-player="${p.id}">${p.dropped ? "Undo drop" : "Drop"}</button>`}
        </span>
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
  document.getElementById("organizerPinInput").placeholder = state.organizerPinHash ? "PIN is set. Type a new one to change it." : "Optional, e.g. 4 digits";

  const running = !!state.started;
  document.getElementById("setupView").style.display = running ? "none" : "block";
  document.getElementById("runningView").style.display = running ? "block" : "none";
  if (!running) return;

  const rounds = roundsArray();
  const totalRounds = state.totalRounds || 3;
  const last = rounds[rounds.length - 1];
  const complete = last ? last.matches.every(matchComplete) : true;
  const done = rounds.length >= totalRounds && complete;

  // Looking back at an earlier round? Show it read-only instead of the current one.
  const viewed = rounds.find((r) => r.key === viewedRoundKey && r !== last);
  if (!viewed) viewedRoundKey = null;

  const picker = document.getElementById("roundPicker");
  picker.innerHTML = "";
  if (rounds.length > 1) {
    rounds.forEach((r, i) => {
      const isActive = viewed ? r === viewed : r === last;
      const label = r === last && !done ? `Round ${i + 1} (current)` : `Round ${i + 1}`;
      picker.appendChild(el(`<button class="round-pill ${isActive ? "active" : ""}" data-view-round="${r === last ? "" : r.key}">${label}</button>`));
    });
  }
  document.getElementById("roundActions").style.display = viewed ? "none" : "flex";

  const matchesList = document.getElementById("matchesList");
  matchesList.innerHTML = "";

  if (viewed) {
    const n = rounds.indexOf(viewed) + 1;
    document.getElementById("roundTitle").textContent = `Round ${n} of ${totalRounds}`;
    document.getElementById("roundSub").textContent = "Earlier round, view only.";
    viewed.matches.forEach((m) => matchesList.appendChild(pastMatchRow(m)));
  } else {
    document.getElementById("roundTitle").textContent = done ? "Final round" : `Round ${rounds.length} of ${totalRounds}`;
    document.getElementById("roundSub").textContent = done ? "All rounds complete — head to Prize draft when you're ready." : "Record games won by each player (best of 3).";
  }

  if (last && !viewed) {
    last.matches.forEach((m) => {
      if (m.bye) {
        matchesList.appendChild(el(`
          <div class="match-row">
            ${editingPairings ? swapNameHTML(m, "p1") : `<span class="pname">${esc(nameOf(m.p1))} ${trophy()}</span>`}
            <span style="font-size:12.5px;color:var(--ink-soft);font-style:italic;">bye — automatic win</span>
          </div>`));
      } else {
        const p1w = m.p1Wins || 0, p2w = m.p2Wins || 0;
        matchesList.appendChild(el(`
          <div class="match-row">
            ${editingPairings ? swapNameHTML(m, "p1") : `<span class="pname" style="grid-column:1;grid-row:1;">${esc(nameOf(m.p1))}${matchWinner(m) === m.p1 ? " " + trophy() : ""}</span>`}
            ${editingPairings ? swapNameHTML(m, "p2") : `<span class="pname right" style="grid-column:3;grid-row:1;">${matchWinner(m) === m.p2 ? trophy() + " " : ""}${esc(nameOf(m.p2))}</span>`}
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
  if (done || viewed) { editingPairings = false; swapPick = null; }
  const editBtn = document.getElementById("editPairingsBtn");
  editBtn.style.display = done ? "none" : "inline-block";
  editBtn.textContent = editingPairings ? "✓ Done editing" : "✎ Edit pairings";
  if (editingPairings) {
    document.getElementById("roundSub").textContent = swapPick
      ? `Now tap the player to swap with ${nameOf(lastMatchPlayer(last, swapPick))}.`
      : "Tap two players to swap them. Only matches with no games recorded can change.";
  }
  document.getElementById("nextRoundBtn").style.display = done ? "none" : "inline-block";
  document.getElementById("nextRoundBtn").disabled = !complete;
  document.getElementById("nextRoundBtn").textContent = rounds.length === 0 ? "Generate round 1" : "Generate next round";

  const standingsList = document.getElementById("standingsList");
  standingsList.innerHTML = "";
  computeStandings().forEach((s, i) => {
    standingsList.appendChild(el(`
      <div class="standing-row ${i === 0 ? "lead" : ""}">
        <span style="color:var(--ink);"><span style="color:var(--ink-soft);margin-right:6px;">${i + 1}.</span>${esc(s.name)}${s.dropped ? ` <span class="dropped-tag">dropped</span>` : ""}</span>
        <span class="pts">${s.wins}-${s.losses}${s.draws ? "-" + s.draws : ""} · ${s.points} pts</span>
      </div>`));
  });
}

// Edit-pairings mode: a player's name becomes a tappable chip when their
// match has no games recorded yet (byes included), otherwise it's locked.
function matchUnscored(m) { return m.bye || ((m.p1Wins || 0) + (m.p2Wins || 0)) === 0; }
function lastMatchPlayer(round, pick) {
  const m = round && round.matches.find((x) => x.id === pick.matchId);
  return m ? m[pick.side] : null;
}
function swapNameHTML(m, side) {
  const right = side === "p2" ? "right" : "";
  const pos = m.bye ? "" : `style="grid-column:${side === "p1" ? 1 : 3};grid-row:1;justify-self:${side === "p1" ? "start" : "end"};"`;
  if (!matchUnscored(m)) return `<span class="pname ${right}" ${pos}>${esc(nameOf(m[side]))} 🔒</span>`;
  const picked = swapPick && swapPick.matchId === m.id && swapPick.side === side;
  return `<button class="swap-chip ${picked ? "picked" : ""}" ${pos} data-swap="${m.id}|${side}">${esc(nameOf(m[side]))}</button>`;
}
function handleSwapTap(matchId, side) {
  const roundKey = roundKeys()[roundKeys().length - 1];
  if (!swapPick) { swapPick = { matchId, side }; return render(); }
  if (swapPick.matchId === matchId) { swapPick = null; return render(); } // same match: cancel
  const matches = (state.rounds[roundKey] || {}).matches || {};
  const a = matches[swapPick.matchId], b = matches[matchId];
  if (!a || !b || !matchUnscored(a) || !matchUnscored(b)) { swapPick = null; return render(); }
  const base = "rounds/" + roundKey + "/matches/";
  eventRef.update({
    [base + swapPick.matchId + "/" + swapPick.side]: b[side],
    [base + matchId + "/" + side]: a[swapPick.side],
  });
  swapPick = null;
}

function pastMatchRow(m) {
  if (m.bye) {
    return el(`
      <div class="match-row">
        <span class="pname">${esc(nameOf(m.p1))} ${trophy()}</span>
        <span style="font-size:12.5px;color:var(--ink-soft);font-style:italic;">bye — automatic win</span>
      </div>`);
  }
  const p1w = m.p1Wins || 0, p2w = m.p2Wins || 0;
  return el(`
    <div class="match-row">
      <span class="pname ${p1w > p2w ? "won" : ""}" style="grid-column:1;grid-row:1;">${esc(nameOf(m.p1))}${matchWinner(m) === m.p1 ? " " + trophy() : ""}</span>
      <span class="final-score" style="grid-column:2;grid-row:1;justify-self:center;">${p1w} – ${p2w}</span>
      <span class="pname right ${p2w > p1w ? "won" : ""}" style="grid-column:3;grid-row:1;">${matchWinner(m) === m.p2 ? trophy() + " " : ""}${esc(nameOf(m.p2))}</span>
    </div>`);
}

function pct(n) { return (n * 100).toFixed(1) + "%"; }
function displayCost(v) {
  if (!v) return "—";
  return v.startsWith("$") ? v : "$" + v;
}

function renderResults() {
  const titleEl = document.getElementById("resultsPageTitle");
  const rounds = roundsArray();
  const totalRounds = state.totalRounds || 3;
  const last = rounds[rounds.length - 1];
  const roundComplete = last ? last.matches.every(matchComplete) : true;
  const inProgress = state.started && !(rounds.length >= totalRounds && roundComplete);
  titleEl.textContent = "Tournament Results" + (inProgress ? " (In progress)" : "");

  const wrap = document.getElementById("resultsTable");
  const standings = computeStandings();
  wrap.innerHTML = "";
  wrap.appendChild(el(`
    <div class="results-table-row header">
      <span title="Rank">#</span>
      <span title="Player">Player</span>
      <span class="stat" title="Match Points">Match pts</span>
      <span class="stat" title="Match Win %">MW%</span>
      <span class="stat" title="Opponents' Match Win %">OMW%</span>
      <span class="stat" title="Game Win %">GW%</span>
      <span class="stat" title="Opponents' Game Win %">OGW%</span>
    </div>`));
  if (standings.length === 0) {
    wrap.appendChild(el(`<p style="color:var(--ink-soft);font-size:14px;">No players yet.</p>`));
    return;
  }
  standings.forEach((s, i) => {
    wrap.appendChild(el(`
      <div class="results-table-row data ${i === 0 ? "lead" : ""}">
        <span style="color:var(--ink-soft);">${i + 1}</span>
        <span>${esc(s.name)}${s.dropped ? ` <span class="dropped-tag">dropped</span>` : ""}</span>
        <span class="stat">${s.points}</span>
        <span class="stat">${pct(s.matchWinPct)}</span>
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
  document.getElementById("pickEmailsToggle").checked = !state.pickEmailsOff;

  document.getElementById("prizeSetupView").style.display = draftStarted ? "none" : "block";
  document.getElementById("prizeActiveView").style.display = draftStarted ? "block" : "none";

  if (!draftStarted) {
    const header = document.getElementById("poolHeader");
    header.innerHTML = pool.length
      ? `<span style="font-size:13px;color:var(--ink-soft);">${pool.length} card${pool.length === 1 ? "" : "s"} in the pool · ${poolTotalHTML(pool)}</span>
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
          <span style="display:flex;align-items:center;gap:8px;">
            ${priceTagHTML(c, true)}
            <button class="x-btn" data-remove-card="${c.id}">✕</button>
          </span>
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
  document.getElementById("prizeSub").innerHTML = (draftComplete ? "Every card has a home." : `Pick ${claims.length + 1} · ${remaining.length} card${remaining.length === 1 ? "" : "s"} left`) +
    `<br>${poolTotalHTML(pool)}`;
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
  document.getElementById("prizeSortBar").style.display = draftComplete ? "none" : "flex";
  if (!draftComplete) {
    const mode = prizeSort();
    document.querySelectorAll("[data-prize-sort]").forEach((b) => b.classList.toggle("active", b.dataset.prizeSort === mode));
    sortPrizes(remaining, mode).forEach((c) => {
      cardsGrid.appendChild(el(`
        <button class="card-tile" data-claim="${c.id}">
          ${cardVisualHTML(c, "tile")}
          ${c.imageUrl ? `<span class="zoom-btn" data-zoom="${esc(c.imageUrl)}" title="Enlarge">🔍</span>` : ""}
          <div class="card-tile-name">${esc(c.name)}${priceTagHTML(c, false)}</div>
        </button>`));
    });
  }

  document.getElementById("resultsSub").textContent = draftComplete ? "Final haul for each drafter." : "Filled in as picks happen.";
  const resultsGrid = document.getElementById("resultsGrid");
  resultsGrid.innerHTML = "";
  players.forEach((p) => {
    const cards = claims.filter((c) => c.playerId === p.id).map((c) => pool.find((x) => x.id === c.cardId)).filter(Boolean);
    const haul = cards.map(cardCad).filter((v) => v != null).reduce((a, b) => a + b, 0);
    resultsGrid.appendChild(el(`
      <div class="result-card">
        <div class="pname">${esc(p.name)}${cards.length ? `<span class="haul">${money(haul)}</span>` : ""}</div>
        ${cards.length === 0 ? `<p class="empty">No picks yet</p>` : cards.map((c) => `
          <div class="result-card-item">${cardVisualHTML(c, "mini")}<span style="flex:1;">${esc(c.name)}</span>${priceTagHTML(c, false)}</div>`).join("")}
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
document.getElementById("startTournamentBtn").addEventListener("click", organizerOnly(startTournament));
document.getElementById("organizerPinInput").addEventListener("change", (e) => { setOrganizerPin(e.target.value); e.target.value = ""; });
document.getElementById("organizerNameInput").addEventListener("change", (e) => eventRef.child("organizerName").set(e.target.value.trim()));
document.getElementById("organizerEmailInput").addEventListener("change", (e) => eventRef.child("organizerEmail").set(e.target.value.trim()));
document.getElementById("tournamentCostInput").addEventListener("change", (e) => {
  const v = e.target.value.trim();
  eventRef.child("tournamentCost").set(v ? (v.startsWith("$") ? v : "$" + v) : "");
});
document.getElementById("paymentEmailInput").addEventListener("change", (e) => eventRef.child("paymentEmail").set(e.target.value.trim()));
document.getElementById("nextRoundBtn").addEventListener("click", organizerOnly(() => { viewedRoundKey = null; nextRound(); }));
document.getElementById("editPairingsBtn").addEventListener("click", async () => {
  if (!editingPairings && !(await requireOrganizer())) return;
  editingPairings = !editingPairings; swapPick = null; render();
});
document.getElementById("resetTournamentBtn").addEventListener("click", organizerOnly(() => {
  if (confirm("Reset the tournament? This clears all rounds and results.")) resetTournament();
}));

document.getElementById("addBulkBtn").addEventListener("click", () => {
  const ta = document.getElementById("bulkCardsInput");
  addBulkCards(ta.value); ta.value = "";
});
document.getElementById("retryImagesBtn").addEventListener("click", () => retryMissingImages());
document.getElementById("refreshPricesBtn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  const t = await refreshPrices((n, total) => { btn.textContent = `💲 Updating prices… ${n}/${total}`; });
  btn.disabled = false; btn.textContent = "💲 Update prices";
  let msg = `Prices updated for ${t.priced} card${t.priced === 1 ? "" : "s"}.`;
  if (t.noPrice.length) msg += `\n\nScryfall has no price for: ${t.noPrice.join(", ")}. Tap their price to type one in.`;
  if (t.failed.length) msg += `\n\nCouldn't reach Scryfall for: ${t.failed.join(", ")}. Try Update prices again in a minute.`;
  alert(msg);
});
document.getElementById("addSingleBtn").addEventListener("click", () => {
  const input = document.getElementById("singleCardInput");
  addSingleCard(input.value); input.value = "";
});
document.getElementById("singleCardInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { addSingleCard(e.target.value); e.target.value = ""; }
});
document.getElementById("beginDraftBtn").addEventListener("click", organizerOnly(beginDraft));
document.getElementById("undoPickBtn").addEventListener("click", organizerOnly(undoLastPick));
document.getElementById("restartDraftBtn").addEventListener("click", organizerOnly(() => {
  if (confirm("Restart the prize draft? This clears all picks.")) resetPrizeDraft();
}));
document.querySelectorAll("[data-prize-sort]").forEach((b) => b.addEventListener("click", () => setPrizeSort(b.dataset.prizeSort)));
document.getElementById("pickEmailsToggle").addEventListener("change", async (e) => {
  const on = e.target.checked;
  if (!(await requireOrganizer())) { e.target.checked = !on; return; }
  eventRef.child("pickEmailsOff").set(on ? null : true);
});

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => { activeTab = tab.dataset.tab; render(); });
});

// delegated clicks for dynamically rendered lists
document.getElementById("app").addEventListener("click", (e) => {
  const rm = e.target.closest("[data-remove-player]");
  if (rm) return removePlayer(rm.dataset.removePlayer);

  const ep = e.target.closest("[data-edit-player]");
  if (ep) return organizerOnly(() => { editingPlayerId = ep.dataset.editPlayer; render(); document.getElementById("editNameInput")?.focus(); })();

  const svp = e.target.closest("[data-save-player]");
  if (svp) {
    const ok = savePlayerEdit(svp.dataset.savePlayer, document.getElementById("editNameInput").value, document.getElementById("editEmailInput").value);
    if (ok) { editingPlayerId = null; render(); }
    return;
  }
  if (e.target.closest("[data-cancel-edit]")) { editingPlayerId = null; return render(); }

  const dp = e.target.closest("[data-drop-player]");
  if (dp) {
    const id = dp.dataset.dropPlayer;
    return organizerOnly(() => {
      if (isDropped(id)) return setDropped(id, false);
      if (confirm(`Drop ${nameOf(id)}? They keep their results so far but won't be paired in future rounds. If they're in an unfinished match this round, record it as a 2-0 win for their opponent.`)) setDropped(id, true);
    })();
  }

  const sw = e.target.closest("[data-swap]");
  if (sw) { const [mid, side] = sw.dataset.swap.split("|"); return handleSwapTap(mid, side); }

  const vr = e.target.closest("[data-view-round]");
  if (vr) { viewedRoundKey = vr.dataset.viewRound || null; return render(); }

  const gm = e.target.closest("[data-game]");
  if (gm) { const [rk, mid, side, delta] = gm.dataset.game.split("|"); return setGameWins(rk, mid, side, parseInt(delta)); }

  const sp = e.target.closest("[data-set-price]");
  if (sp) return setManualPrice(sp.dataset.setPrice);

  const rc = e.target.closest("[data-remove-card]");
  if (rc) return removeCard(rc.dataset.removeCard);

  const cp = e.target.id === "clearPoolBtn" ? true : e.target.closest("#clearPoolBtn");
  if (cp) return organizerOnly(() => { if (confirm("Remove all cards from the prize pool?")) clearPool(); })();

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

// Touch screens can't hover, so there a tap opens the card full-size in the
// middle of the screen and any tap closes it. Draft tiles claim on tap, so
// they get a separate 🔍 button for this instead.
const isTouch = window.matchMedia("(hover: none)").matches;
function openCardModal(url) {
  cardPreviewImg.src = url;
  cardPreview.classList.add("modal");
  cardPreview.style.display = "flex";
}
document.addEventListener("click", (e) => {
  if (cardPreview.classList.contains("modal")) {
    cardPreview.classList.remove("modal");
    cardPreview.style.display = "none";
    e.stopPropagation(); e.preventDefault();
    return;
  }
  const z = e.target.closest("[data-zoom]");
  const p = isTouch && !e.target.closest("[data-claim]") && e.target.closest("[data-preview]");
  if (z || p) {
    e.stopPropagation(); e.preventDefault();
    openCardModal((z || p).dataset.zoom || (z || p).dataset.preview);
  }
}, true);

document.addEventListener("mouseover", (e) => {
  if (isTouch) return;
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
