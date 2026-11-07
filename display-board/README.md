# display-board (P4)

A projector status board, a phone camera page, and team dev tools. It's a Next.js app that talks to the team backend
in `../functions` (the same API the `frontend/` dashboard uses).

| Route     | Who sees it                 | What it is                                                                         |
| --------- | --------------------------- | ---------------------------------------------------------------------------------- |
| `/`       | Projector / TV              | Passive departures-style board. Read-only, no buttons. Polls every 1.5s.           |
| `/camera` | Staff phone                 | Pick ticket → photo → result. The only place a swap gets confirmed.                |
| `/dev`    | Team only (never projected) | Test controls, forced mock results, **Run demo script**.                           |

## Run it

```bash
# terminal 1: team backend on :8000
cd functions && npm install && npm start

# terminal 2: this app on :3001 (voice-order-app uses :3000)
cd display-board && npm install && npm run dev
```

Open http://localhost:3001. `/api/*` and `/photos/*` are forwarded to the backend (`BACKEND_URL`, default
`http://localhost:8000`, set in `next.config.ts`). A phone on the same Wi-Fi can open
`http://<laptop-ip>:3001/camera` (on a Mac: `ipconfig getifaddr en0`).

Real photo checks need the vision setup in `functions/` (`OPENROUTER_API_KEY`, see `functions/src/vision.js`). Without
it, the backend answers "Vision model not wired up yet" and the camera page shows that error.

### Mock vs real backend

- **Real (default):** no `.env.local` needed. Everything goes to the backend.
- **Mock:** put `NEXT_PUBLIC_USE_MOCK=true` in `display-board/.env.local` and restart. State lives in the browser's
  localStorage and syncs across tabs in the **same browser** only.
- **Emergency switch:** on `/dev`, "Force mock in this browser" flips that browser to mock without a restart. The demo
  script always runs on mock so its results are predictable.

## `lib/actions.ts`: the functions to call to change state

```ts
import { submitVoiceOrder, submitMealPhoto, confirmSwap, pickupOrder } from "@/lib/actions";
```

| Function | Who calls it, and when | Backend route(s) |
| --- | --- | --- |
| `submitVoiceOrder({ items, customer_name? })` | P1, after staff confirm the voice card | `POST /api/orders` (`customer_name` defaults to "Guest") |
| `submitMealPhoto(orderId, imageBase64)` | `/camera`, after a ticket is picked and a photo taken | `POST /api/orders/:id/inspect` `{ photo_base64 }`; on pass, then `POST /api/orders/:id/assign-cubby` |
| `confirmSwap(flaggedOrderId, actualOrderId)` | `/camera`, only when staff tap "Confirm swap" | `POST /api/inspections/:id/reassign` `{ target_order_id }`, then `assign-cubby` (override + note if needed) |
| `pickupOrder(orderId)` | P1's "Order 21" pickup screen | `POST /api/orders/:id/pickup` |

`lib/api.ts` is the only file that knows the backend's shapes. It maps them to the UI model in `lib/types.ts`:

| Backend status | Board shows |
| --- | --- |
| `pending`, `verified` | PREPARING (VERIFYING while a photo check runs) |
| `needs_attention` | CHECK ORDER + the inspection's `reasons` + POSSIBLE SWAP WITH #N (`swap_suggestion`) |
| `in_cubby` | READY FOR PICKUP ("cubby" means ready for pickup; the board never shows cubbies) |
| `picked_up` | PICKED UP after a green flash, then fades out after ~10s |

Inspection verdicts: `pass` → pass, `fail` → flag, `needs_review` → "please retake".

Known limitation: the backend has no "inspection in progress" state, so in real mode VERIFYING only appears on a
screen in the same browser that sent the photo.

## Demo script

**Automatic (backup / video):** open `/` on the projector and `/dev` in another tab of the **same browser**, then
click **Run demo script**. It switches that browser to mock data, resets it, and plays, 3.5s apart:

1. Voice order **#21** (Sam): burger
2. Voice order **#22** (Riley): burger, **no lettuce**
3. Photo for #22 (actually #21's burger) → **CHECK ORDER**: "ticket says no lettuce, lettuce detected",
   **POSSIBLE SWAP WITH #21**
4. `confirmSwap(22, 21)` → #21 **READY FOR PICKUP**
5. Retake photo for #22 (correct burger) → passes → #22 **READY FOR PICKUP**
6. Pick up #21 → flash → PICKED UP
7. Pick up #22

**Live (real backend):** place the two burger orders by voice; on the phone open `/camera`, pick the no-lettuce order,
photograph the burger *with* lettuce → CHECK ORDER with a possible swap → tap "Yes". Retake with the right burger →
passes. Then pick up both. If the camera or Wi-Fi fails, tap "Camera not working? Use demo photo".

Demo photos are placeholders in `public/demo/`. Replace them and update `lib/demoPhotos.ts`.
