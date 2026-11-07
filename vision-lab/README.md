# Vision Lab: photo → order string

Upload or take a photo of a meal. The vision model turns it into an order string in **the same format the voice app produces**:

| | Voice app | Vision (this) |
|---|---|---|
| Input | speech | photo |
| String | `2× Burger (no lettuce), Fries for table 12` | `2× Burger (no lettuce), Fries` |
| Items | `[{name, quantity, notes}]` | `[{name, quantity, notes}]`, same shape |

Comparing the two tells you whether the meal matches the order. It doesn't need `npm install`.

## Run on your laptop

From the repo root:

```bash
cd vision-lab
```

```bash
node server.js
```

Open http://localhost:8090. The key is read from `functions/vision.local.env`.

To use your phone camera, open `http://<laptop-IP>:8090` on a phone on the same Wi-Fi, then tap **Take / upload photo**.

## API (for integration)

```
POST /api/vision/describe   { "photo": "data:image/jpeg;base64,...", "model"?: "provider/model" }
  -> { "ok": true,
       "summary": "2× Burger (no lettuce), Fries",
       "items": [{ "name": "Burger", "quantity": 2, "notes": "no lettuce" }, { "name": "Fries", "quantity": 1 }],
       "retake_reason": null, "model": "...", "latency_ms": 2310, "cost_usd": 0.004,
       "id": "...", "photo_url": "/photos/..." }
     "ok": false + "retake_reason" means the photo was unclear. Ask for a retake.

POST /api/vision/compare    { "ordered": "<voice summary string or items>", "seen": "<string or items>" }
  -> { "match": false, "missing": ["soda"], "extra": [] }

GET  /api/vision/results    recent results
```

The same logic is available inside the backend as plain functions:
- `functions/src/vision.js` → `describePhoto(buffer, contentType)`
- `functions/src/vision-string.js` → `toOrderItems`, `formatSummary`, `parseSummary`, `compareOrders`

### String format

Vision generates notes from the menu (`functions/src/menu.js`):
- A standard ingredient that's missing becomes `no <ingredient>`.
- An optional ingredient that's present becomes `add <ingredient>`.

`compareOrders` treats `without`/`hold the` like `no`, and `extra`/`with` like `add`. It ignores plurals, and it maps `Coke` to `Soda` and `Salad` to `Side Salad`. Dish names must be menu names, so the voice prompt should use the same names.

## Firebase (not set up yet)

Results are stored **in memory** for now. Every spot that changes when Firebase is ready is marked `FIREBASE TODO` in `vision-lab/firebase.js`, which also documents the Firestore document shape (`vision_results` collection).

When Firebase is ready:
1. Run `npm install firebase-admin` inside `vision-lab`.
2. Fill in `FIREBASE_CONFIG`.
3. Uncomment the `FIREBASE TODO` blocks.
4. Set `USE_FIREBASE=true`.

## Host it (e.g. Render, free)

Create a **New Web Service** from this repo, with:
- **Start command:** `node vision-lab/server.js`
- **Environment variables:**
  - `OPENROUTER_API_KEY`
  - `LAB_PASSWORD`. **Always set this**, or anyone with the URL can spend your credit.
  - `OPENROUTER_VISION_MODEL` (optional)
