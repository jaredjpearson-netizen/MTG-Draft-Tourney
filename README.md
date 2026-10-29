# MTG Draft Night

A live, multi-device draft tournament manager and end-of-event prize draft.
No build step — it's plain HTML/CSS/JS, so uploading the files is all it takes.

## What you're setting up

- **Firebase Realtime Database** — free, holds the shared event data so everyone's
  browser stays in sync live.
- **GitHub Pages** (or Netlify/Cloudflare Pages) — free static hosting for the files
  in this folder, so you get a public URL to share.

Total setup time is about 10–15 minutes and doesn't require a credit card.

---

## 1. Firebase project — already set up

This copy of the app is already wired to the `mtg-draft-tourneys` Firebase
project, with real values filled into `firebase-config.js`. You don't need
to create a new project or touch that file unless you want to point the app
at a different Firebase project entirely.

<details>
<summary>For reference: how it was set up (click to expand)</summary>

1. [console.firebase.google.com](https://console.firebase.google.com) → **Add project**.
2. **Build → Realtime Database → Create Database**, start in test mode.
3. **Project settings → General → Your apps** → register a web app → copy the
   `firebaseConfig` object into `firebase-config.js`.
</details>

## 2. Database rules

Back in Firebase console → **Realtime Database → Rules** tab, replace the rules with:

```json
{
  "rules": {
    "events": {
      ".read": "auth != null && auth.token.email === 'mtgdrafttourneybot@gmail.com'",
      "$eventCode": {
        ".read": true,
        ".write": true
      }
    }
  }
}
```

The extra `".read"` line lets only the admin account list every tournament
(for **Manage tournaments**, below). Everyone else can still only open an
event whose code they know.

Click **Publish**. This means anyone who knows a specific event code can read and
write that event's data — fine for a casual home tournament (there's no login), but
worth knowing: don't use a guessable code for anything you'd mind a stranger poking
at. Anyone with the link can record results or claim prize cards. The optional
organizer PIN (see Notes) guards the bigger actions, but it's a speed bump
against accidents rather than real security.

## 2b. Manage tournaments: one-time setup

The master password is the password of a Firebase sign-in account, so it's
checked by Firebase and never appears in the app's code (which is public on
GitHub).

1. Firebase console → **Build → Authentication** → **Get started** (if
   you haven't used it yet) → **Sign-in method** tab → enable
   **Email/Password** → Save.
2. **Users** tab → **Add user**. Email: `mtgdrafttourneybot@gmail.com`,
   password: your master password → **Add user**.
3. **Settings** tab → **Authorized domains** → make sure your GitHub Pages
   domain (e.g. `jaredjpearson-netizen.github.io`) is listed. Add it if not.
4. Update the database rules to the version in step 2 above and **Publish**.

To change the master password later, use the user's **⋮ → Reset password**
in the Users tab. The admin email lives in `firebase-config.js`
(`adminEmail`) if you ever want a different account.

## 3. Email setup — already configured

Both email templates run through the **mtgdrafttourneybot@gmail.com**
account, connected as an EmailJS service. This is deliberately a separate
account from any personal email — keeps tournament traffic out of your own
inbox, and gives players a sensible "from" address.

- **`emailjs-prizedraft-config.js`** — the "it's your turn to pick" emails,
  sent during the prize draft.
- **`emailjs-start-config.js`** — the one-time "tournament started" welcome
  email, sent to every registered player the moment the organizer clicks
  **Start tournament**.

Both already have real Service ID / Template ID / Public Key values filled
in. You shouldn't need to touch either file unless you want to change which
EmailJS account or templates are used.

One thing worth double-checking on the EmailJS side: the *sending* Gmail
account is whichever one `service_kfh50w8` is connected to in your EmailJS
dashboard (**Email Services**), not something set in these files. If you
haven't already, reconnect that service to mtgdrafttourneybot@gmail.com
there (disconnect the old account first if it's still linked to a different
one) — the config files just tell the app *which* service/template to call,
not which mailbox it actually sends from.

<details>
<summary>For reference: how a template like this gets set up (click to expand)</summary>

1. Free account at [emailjs.com](https://www.emailjs.com) (200 emails/month free).
2. **Email Services → Add New Service** → connect the Gmail account. Copy the Service ID.
3. **Email Templates → Create New Template**, using whichever variables the
   template needs (e.g. `{{to_email}}`, `{{player_name}}`, `{{event_name}}`,
   `{{event_link}}`). Copy the Template ID.
4. **Account → General** → copy the Public Key.
5. **Important:** in the template's **Settings tab**, the "To Email" field
   must be set to `{{to_email}}` — this is the single most common thing to
   get wrong, and causes emails to silently fail to send.

</details>

If a player doesn't have an email on file, they're simply skipped — nothing
else in the app depends on it.

## 4. Put the files on GitHub Pages (~5 min)

1. Create a new **public** repository on [github.com](https://github.com) (e.g.
   `mtg-draft-night`).
2. Upload all the files in this folder — `index.html`, `styles.css`, `app.js`,
   `firebase-config.js`, `emailjs-prizedraft-config.js`, `emailjs-start-config.js`
   — to the repo. You can drag-and-drop them in the GitHub web UI ("Add file" → "Upload files").
3. Go to the repo's **Settings → Pages**.
4. Under **Build and deployment**, set **Source** to "Deploy from a branch", branch
   `main`, folder `/ (root)`. Save.
5. GitHub will give you a URL like `https://yourusername.github.io/mtg-draft-night/`
   within a minute or two. That's your app.

(Netlify or Cloudflare Pages work the same way if you'd rather drag-and-drop the
folder instead of using GitHub — either is fine, this app doesn't care how it's
hosted.)

## 5. Run your draft night

1. Open your GitHub Pages URL. You'll be asked for an event code — leave it blank
   and click **Join / create event** to generate a random one (or type your own,
   like `FOIL42`).
2. The page URL updates to include `?event=YOURCODE` — share that exact link with
   everyone at the table. Anyone who opens it joins the same live event.
3. Add players, run the Swiss rounds, then run the prize draft. Everyone's browser
   updates in real time as results and picks happen.

## Notes

- There's no server to keep running — Firebase, EmailJS, and GitHub Pages all
  stay up on their own, so the link works anytime, from anywhere.
- Standings tiebreakers follow the usual tournament convention: match points,
  then opponents' match-win %, then game-win %, then opponents' game-win %.
- The prize draft always runs winner-first, following the tournament ranking
  top to bottom and looping back to the top each time it reaches the last
  place — not a snake order.
- Player email addresses are required when adding a player, since the app
  relies on them for both notification emails.
- Hover over any card's art anywhere in the app to see a full-size preview.
  On phones and tablets, tap the art instead (in the prize draft, tap the 🔍
  on a card, since tapping the card itself picks it). Tap again to close.
- Swiss pairing avoids rematches: if a straightforward pairing would leave two
  players who've already met, it reshuffles until no one repeats an opponent
  (a rematch only happens when there's truly no other option). In round 1 an
  odd player out gets a bye at random.
- Once the tournament is running, the Tournament tab has round buttons to look
  back at any earlier round's matchups and scores.
- **✎ Edit pairings** (Tournament tab, organizer PIN) lets you fix the
  current round's pairings: tap two players to swap them. Only matches with
  no games recorded can change (others show 🔒), and byes count too.
- To drop a player mid-tournament, use **Drop** next to their name on the
  Players tab. They keep their results so far but aren't paired again. If
  they leave partway through a match, record it as 2-0 for their opponent.
- Card art comes from Scryfall automatically. Entries that aren't real card
  names (booster packs, box toppers, "mystery prize", etc.) just show a
  generic placeholder and aren't flagged as a problem. If a genuine card's
  art fails to load (rare — usually a rate-limit hiccup on a big bulk-add),
  a "Retry missing card images" button appears in Prize pool setup to
  re-fetch just those.
- **Organizer PIN** (optional, set in Tournament setup): once set, generating
  rounds, editing pairings, resetting, editing or dropping players, starting/undoing/restarting the prize
  draft, clearing the prize pool and the pick-email switch all ask for it. Score entry and picking prizes stay open to everyone. Each
  device only has to enter it once. To change it, type a new PIN in the same
  field (you'll be asked for the current one first if this device hasn't
  entered it yet).
- **Editing players**: the ✎ next to a player's name (Players tab) edits their
  name or email at any time, before or during the tournament.
- **Card prices** come from Scryfall's market price (USD, for the card's
  default printing, so it may differ from your exact copy) converted to
  Canadian dollars at the day's exchange rate. The pool, the draft and each
  player's haul show totals. Tap a price in the prize pool list to type your
  own, e.g. for booster packs, which Scryfall can't price. **Update prices**
  re-checks every card.
- **Pick emails switch**: the checkbox at the top of the Prize draft tab turns
  the "your turn to pick" emails on or off, which saves most of the EmailJS
  monthly quota (200 emails/month) when everyone's in the same room.
- **Manage tournaments** (link on the start screen) lists every tournament,
  newest first, with its status. You can open or delete any of them. It's
  locked by the master password (see setup below). Each event is tiny, so
  the free tier won't fill up in normal use even if you never delete any.
- To run a second, unrelated event later, just use a different event code.
