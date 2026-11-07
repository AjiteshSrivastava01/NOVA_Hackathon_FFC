# NOVA_Hackathon_FFC
Repo for the 2026 NOVA Hackathon for the Flushi_Fan_Club Team.

A shared kitchen dashboard and backend in JavaScript, hosted on Firebase. The full flow already works with manual inputs:

**create ticket → select ticket → inspect meal → assign cubby → confirm pickup**

Later, voice replaces manual ticket entry and vision replaces the sample inspection.

## Menu

| Item | Standard | Can be changed |
|---|---|---|
| Burger | bun, patty, lettuce, tomato | "no lettuce", "no tomato" |
| Fries, Wings, Pizza, Soda, Water | — | — |

The menu is defined in `functions/src/menu.js`, and `display-board/lib/menu.ts` mirrors it. The camera ignores anything not on the menu, such as extra burger toppings like cheese or onion.

## How it works

Two screens:

| Screen | URL | Who uses it |
|---|---|---|
| **Input** | `/input/` (open it on a phone) | Staff. **🎙 Add order:** speak the order, check the card, tap Add. **📷 Check meal:** photograph the plate. |
| **Dashboard** | `/` | Everyone. Shows tickets, cubbies and alerts, updating by itself. |

What happens behind the scenes:
- **Voice** → `POST /api/voice/understand`. The audio goes to OpenRouter (`gemini-3.8-flash`) and comes back as an order in menu format. After you confirm, it's saved with `POST /api/orders` and appears on the dashboard.
- **Photo** → `POST /api/check-meal`. Vision lists what's on the plate, and plain code compares it with every open order:
  - **Exact match:** the order is checked off ✓ and goes to a free cubby. The dashboard plays the cubby animation and announces it.
  - **No exact match:** the closest order is flagged, and the dashboard shows a red alert with what's wrong until the meal is fixed and checked again.
  - **Matches a newer order but is one ingredient off an older one:** the dashboard shows a "possible mix-up" warning.
  - **Blurry photo, or nothing matches:** the dashboard shows a "retake" or "no matching order" warning.
- Audio and photos are only processed. The dashboard shows the results.

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

Then open http://localhost:8000 for the dashboard and http://localhost:8000/input/ for the input screen. On a phone on the same Wi-Fi, use `http://<laptop-IP>:8000/input/`. Vision Lab, the testing page, is at `/vision-lab/`. Local data is kept in memory and resets when you restart the server. Run the tests with `npm test`.

## Firebase (project `nova-ffc`, free Spark plan)

Photos are processed **on your laptop**. The local server sends each one to OpenRouter and gets back the order string. **Only the results go to Firestore**: order strings, items, statuses and cubbies. Photos never leave the laptop.

That way the team shares one database without the paid Blaze plan.

```
phone/laptop camera ──► local server (functions/) ──► OpenRouter (vision)
                              │
                              └──► Firestore (nova-ffc): orders, inspections, cubbies,
                                   events, vision_results  ◄── teammates' local servers
                                                            ◄── voice app (voice_orders)
```

### One-time setup

1. **Create the database:** in the Firebase console, go to **Build → Firestore Database → Create database**. Choose production mode and a location near you, such as `us-central1`. This is free on Spark.
2. **Download a service-account key:** go to ⚙️ **Project settings → Service accounts → Generate new private key**. Save the file as **`functions/firebase-key.local.json`**.
   - Git ignores it.
   - **Never commit it or post it.** It gives full access to the database.
   - Share it with teammates privately, or have each of them generate their own.
3. **Put your local settings in `functions/vision.local.env`** (git-ignored):
   ```
   OPENROUTER_API_KEY=sk-or-...
   FFC_STORE=firestore
   ```
4. **Run the server:** from the `functions` folder, run `npm start`. The startup message should say `data: Firestore (nova-ffc), photos kept on this computer`.

Leave out `FFC_STORE=firestore` to work offline, with data in memory.

**The voice app** can write to the same database. Add these lines to `voice-order-app/.env.local`:

```
OPENROUTER_API_KEY=sk-or-...
USE_FIRESTORE=true
GOOGLE_APPLICATION_CREDENTIALS=../functions/firebase-key.local.json
```

Its orders go to the `voice_orders` collection.

**Free-plan limits:** 50,000 reads and 20,000 writes per day.
- The local server keeps a live copy of the data, so the dashboards' polling doesn't use up reads. Reads are only counted when data changes.
- You can check usage in the console under **Firestore → Usage**.

### Later, on the Blaze plan (optional)

`firebase deploy` can host everything online, with the API as a Cloud Function (`functions/index.js`) and photos in Cloud Storage. The voice app and display board can then run on App Hosting (`apphosting.yaml`).

To do that, you'd need to:
1. Upgrade to Blaze.
2. Create Storage.
3. Store the key as a secret:
   ```bash
   firebase functions:secrets:set OPENROUTER_API_KEY
   ```
4. Deploy:
   ```bash
   firebase deploy
   ```

None of this is needed for the free setup above.

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
{"items": [{"menu_id": "burger", "components": {"lettuce": "absent", "tomato": "present"}}]}
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
