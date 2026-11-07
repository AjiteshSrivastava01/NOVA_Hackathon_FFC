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

Then open http://localhost:8000. Local data is kept in memory and resets when you restart the server. Run the tests with `npm test`.

## Deploy to Firebase

Setup:

1. Create a project at https://console.firebase.google.com and switch it to the **Blaze** plan. Cloud Functions require Blaze; hackathon usage stays within the free tier.
2. In the console, turn on **Firestore Database** and **Storage**.
3. Replace `YOUR-FIREBASE-PROJECT-ID` in `.firebaserc` with your project ID.
4. Install the Firebase CLI:
   ```bash
   npm install -g firebase-tools
   ```
5. Sign in:
   ```bash
   firebase login
   ```

Deploy from the repo root:

```bash
firebase deploy
```

Hosting serves `frontend/`. Requests to `/api/**` and `/photos/**` go to the `api` Cloud Function (`functions/index.js`). That function stores data in Firestore and photos in Cloud Storage, so they survive redeploys.

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
| Vision | `functions/src/vision.js` → `analyze(photo, contentType, order)` |
| Voice | `functions/src/voice.js` → `transcribe(audio)`, `parseOrder(text)` |
| Logic | `functions/src/matching.js` |
| UI | `frontend/` (plain HTML/CSS/JS, no build step) |
| Display board + camera (P4) | `display-board/` (Next.js on :3001, uses this API; see `display-board/README.md`) |

## Palette

`#3c1518` Rich Mahogany · `#69140e` Dark Garnet · `#fee1c7` Soft Apricot · `#fa7e61` Vibrant Coral · `#f44174` Wild Strawberry
