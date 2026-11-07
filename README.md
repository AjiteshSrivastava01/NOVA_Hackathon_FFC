# NOVA_Hackathon_FFC
Repo for the 2026 NOVA Hackathon for the Flushi_Fan_Club Team.

A shared kitchen dashboard and backend in JavaScript, hosted on Firebase. The full flow already works with manual inputs:

**create ticket → select ticket → inspect meal → assign cubby → confirm pickup**

Later, voice replaces manual ticket entry and vision replaces the sample inspection.

## Run locally

Needs Node.js 22.

```bash
cd functions
```

```bash
npm install
```

```bash
npm start
```

Then open http://localhost:8000 for the dashboard and http://localhost:8000/vision-lab/ for Vision Lab. Local data is kept in memory and resets when you restart the server. Run the tests with `npm test`.

## Firebase (project `nova-ffc`)

Everything is wired to the Firebase project **`nova-ffc`** (`.firebaserc`).

| Part | Where it runs | Data |
|---|---|---|
| Dashboard `frontend/` and Vision Lab `frontend/vision-lab/` | Firebase Hosting → https://nova-ffc.web.app and `/vision-lab/` | none of its own |
| Backend API `functions/` | Cloud Function `api` (Hosting forwards `/api/**` and `/photos/**`) | Firestore: `orders`, `inspections`, `cubbies`, `events`, `vision_results`; Storage: `photos/` |
| Voice app `voice-order-app/` | Firebase App Hosting (`apphosting.yaml`) | Firestore: `voice_orders` |
| Display board `display-board/` | Firebase App Hosting (`apphosting.yaml`) | uses the backend at nova-ffc.web.app |

Locally, everything runs **in memory** by default, so you don't need any Firebase setup to develop.

### One-time setup (console: https://console.firebase.google.com/project/nova-ffc)

1. Switch to the **Blaze** plan (bottom left, **Upgrade**). Cloud Functions, Storage and App Hosting need it; the free allowance covers a hackathon. Set a budget alert.
2. **Build → Firestore Database → Create database.** Choose production mode and a location such as `us-central1` (it can't be changed later).
3. **Build → Storage → Get started.** Choose production mode and the same location.
4. Install the CLI:
   ```bash
   npm install -g firebase-tools
   ```
5. Sign in:
   ```bash
   firebase login
   ```
6. Store the OpenRouter key as a secret. It asks for the value, so the key never goes in a file:
   ```bash
   firebase functions:secrets:set OPENROUTER_API_KEY
   ```
7. Optional: create `functions/.env.nova-ffc` (git-ignored) for the deployed function's settings:
   ```
   OPENROUTER_VISION_MODEL=google/gemini-3.8-flash
   LAB_PASSWORD=pick-something
   ```
   `LAB_PASSWORD` stops strangers from using Vision Lab on the public site and spending your credit.

### Deploy the dashboard, backend and Vision Lab

From the repo root:

```bash
firebase deploy
```

This deploys Hosting, the `api` function, and the Firestore and Storage rules (which deny direct browser access, so only the function can read or write).

### Deploy the voice app and display board (App Hosting)

For each app, in the console go to **Build → App Hosting → Get started**, connect this GitHub repo, and set the **root directory** to `voice-order-app` or `display-board`. Pushing to `main` then redeploys automatically.

The voice app also needs access to the key:

```bash
firebase apphosting:secrets:grantaccess OPENROUTER_API_KEY --backend voice-order-app
```

### Test against Firebase locally (optional)

```bash
firebase emulators:start
```

This runs Hosting, Functions, Firestore and Storage locally, with a UI at http://localhost:4000. Functions read secrets from `functions/.secret.local` (git-ignored) when emulated.

## Integration contract

| Endpoint | Purpose |
|---|---|
| `POST /api/orders` | Save a confirmed order |
| `GET /api/orders` | Populate the dashboard (`?include_done=true` includes picked-up orders) |
| `POST /api/orders/:id/inspect` | Inspect a photo against the **selected** order |
| `POST /api/orders/:id/assign-cubby` | Reserve a free cubby (verified order, or `{"override": true, "staff_note": "..."}`) |
| `POST /api/orders/:id/pickup` | Confirm pickup and release the cubby |

Other routes: `GET /api/menu`, `GET /api/orders/:id`, `POST /api/orders/demo`,
`POST /api/orders/:id/inspect/sample?mode=correct|mistake|hidden`,
`POST /api/inspections/:id/reassign`, `GET /api/cubbies`, `GET /api/events`,
`POST /api/voice/parse`, `POST /api/voice/transcribe`, `POST /api/reset`.

**Order** (stable IDs from `functions/src/menu.js`; quantity is a separate field from the modifiers):

```json
{"customer_name": "Sam",
 "items": [{"menu_id": "burger", "qty": 2, "modifiers": {"lettuce": "no"}},
           {"menu_id": "fries",  "qty": 1, "modifiers": {}}]}
```

**Inspect** request body:

```json
{"photo_base64": "data:image/jpeg;base64,...", "observations": {...}}
```

**Observations** (vision reports what it sees; `matching.js` decides the verdict):

```json
{"items": [{"menu_id": "burger", "components": {"lettuce": "unknown", "cheese": "present"}}]}
```

- Include one entry per physical item.
- Each component is `present`, `absent` or `unknown`. If an ingredient might be hidden, report `unknown`.
- The verdict is `pass`, `fail` or `needs_review`.
- Every retake creates a new inspection record; earlier ones are kept.
- When an inspection suggests a swap to another order, nothing moves until staff confirm it.
- Cubbies are simulated: assigning one plays a door animation and a text-to-speech announcement.

## Where each team plugs in

| Team | File |
|---|---|
| Vision | `functions/src/vision.js` → `analyze(photo, contentType, order)`, `describePhoto(photo)`; `functions/src/vision-string.js`; Vision Lab at `/vision-lab/` |
| Voice | `functions/src/voice.js` → `transcribe(audio)`, `parseOrder(text)` |
| Logic | `functions/src/matching.js` |
| UI | `frontend/` (plain HTML/CSS/JS, no build step) |
| Display board + camera (P4) | `display-board/` (Next.js on :3001, uses this API; see `display-board/README.md`) |

## Palette

`#3c1518` Rich Mahogany · `#69140e` Dark Garnet · `#fee1c7` Soft Apricot · `#fa7e61` Vibrant Coral · `#f44174` Wild Strawberry
