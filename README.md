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

## 1. Create the Firebase project (~5 min)

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and sign
   in with a Google account.
2. Click **Add project**, give it any name (e.g. `mtg-draft-night`), and finish the
   wizard. You can disable Google Analytics for this project — not needed.
3. In the left sidebar, go to **Build → Realtime Database**.
4. Click **Create Database**. Pick any region. When asked about security rules,
   choose **Start in test mode** for now (we'll tighten it up in step 3).
5. Once created, go to **Project settings** (gear icon, top left) → **General** tab
   → scroll to **Your apps** → click the **</>** (web) icon to register a new web app.
   Give it any nickname, skip Firebase Hosting (we're using GitHub Pages instead).
6. You'll be shown a `firebaseConfig` object. Copy it.

## 2. Add your config to the app

Open `firebase-config.js` in this folder and replace the placeholder values with
the real ones from step 1, e.g.:

```js
const firebaseConfig = {
  apiKey: "AIzaSy...",
  authDomain: "mtg-draft-night.firebaseapp.com",
  databaseURL: "https://mtg-draft-night-default-rtdb.firebaseio.com",
  projectId: "mtg-draft-night",
  storageBucket: "mtg-draft-night.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc123",
};
```

This file is safe to make public — it's not a secret. Firebase access is controlled
by the database rules you set in the next step, not by hiding this config.

## 3. Set your database rules

Back in Firebase console → **Realtime Database → Rules** tab, replace the rules with:

```json
{
  "rules": {
    "events": {
      "$eventCode": {
        ".read": true,
        ".write": true
      }
    }
  }
}
```

Click **Publish**. This means anyone who knows a specific event code can read and
write that event's data — fine for a casual home tournament (there's no login), but
worth knowing: don't use a guessable code for anything you'd mind a stranger poking
at, and the app itself has no admin/player distinction — anyone with the link can
record results or claim prize cards.

## 4. Set up turn-notification emails (optional, ~5 min)

If a player has an email address on file, the app will automatically email
them the moment it becomes their turn to pick in the prize draft — including
a link back to the event. This uses **EmailJS**, which sends email straight
from the browser, so no backend server is needed here either.

1. Create a free account at [emailjs.com](https://www.emailjs.com) (free tier:
   200 emails/month).
2. **Email Services → Add New Service** → connect Gmail, Outlook, or another
   provider. Copy the **Service ID**.
3. **Email Templates → Create New Template.** Use these variables anywhere in
   the subject/body: `{{to_email}}`, `{{player_name}}`, `{{event_name}}`,
   `{{event_link}}` — for example:
   > Subject: It's your pick, {{player_name}}!
   > Body: Your turn to pick a prize card in {{event_name}}. Open the draft: {{event_link}}

   Copy the **Template ID**.
4. **Account → General** → copy your **Public Key**.
5. Open `emailjs-config.js` in this folder and paste in your Service ID,
   Template ID, and Public Key.

If you skip this step, the app works exactly the same — it just won't send
emails (everything happens live in the browser regardless, so this is purely
an extra nudge for people who've stepped away from the screen).

## 5. Put the files on GitHub Pages (~5 min)

1. Create a new **public** repository on [github.com](https://github.com) (e.g.
   `mtg-draft-night`).
2. Upload all the files in this folder (`index.html`, `styles.css`, `app.js`,
   `firebase-config.js` with your real values) to the repo — you can drag-and-drop
   them in the GitHub web UI ("Add file" → "Upload files").
3. Go to the repo's **Settings → Pages**.
4. Under **Build and deployment**, set **Source** to "Deploy from a branch", branch
   `main`, folder `/ (root)`. Save.
5. GitHub will give you a URL like `https://yourusername.github.io/mtg-draft-night/`
   within a minute or two. That's your app.

(Netlify or Cloudflare Pages work the same way if you'd rather drag-and-drop the
folder instead of using GitHub — either is fine, this app doesn't care how it's
hosted.)

## 6. Run your draft night

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
- The prize draft always runs winner-picks-first, in snake order.
- Player email addresses are optional — only used to send the "it's your
  turn" notification if you've set up EmailJS. Anyone at the table can still
  see whose turn it is directly on screen either way.
- Data isn't automatically deleted — old events just sit in your database (free
  tier is generous, this won't cost anything for normal use). You can delete old
  event nodes manually in the Firebase console under **Realtime Database → Data**
  if you want to tidy up.
- To run a second, unrelated event later, just use a different event code.
