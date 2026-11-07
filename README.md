# NOVA_Hackathon_FFC
Repo for the 2026 NOVA Hackathon for the Flushi_Fan_Club Team.

A shared kitchen dashboard and backend. The full flow works today with manual inputs:

**create ticket → select ticket → inspect meal → assign cubby → confirm pickup**

Voice will replace manual ticket entry, and vision will replace the sample inspection. Each one plugs into the backend through a single file.

## Run it

```bash
pip install -r requirements.txt
```

```bash
uvicorn backend.app:app --reload --host 0.0.0.0 --port 8000
```

Open http://localhost:8000. Interactive API docs are at http://localhost:8000/docs.
Run the tests with `python -m pytest -q`. To reset all data, use **Reset demo** in the UI or delete `data/ffc.db`.

> Camera and microphone access in the browser require `localhost` or HTTPS. To test from a phone, use a tunnel such as `ngrok http 8000`.

## Integration contract

| Endpoint | Purpose |
|---|---|
| `POST /api/orders` | Save a confirmed order |
| `GET /api/orders` | Populate the dashboard (`?include_done=true` includes picked-up orders) |
| `POST /api/orders/{id}/inspect` | Inspect a photo against the **selected** order |
| `POST /api/orders/{id}/assign-cubby` | Reserve a free cubby (requires a verified order, or `{"override": true, "staff_note": "..."}`) |
| `POST /api/orders/{id}/pickup` | Confirm pickup and release the cubby |

Helpers: `GET /api/menu`, `GET /api/orders/{id}`, `POST /api/orders/demo`,
`POST /api/orders/{id}/inspect/sample?mode=correct|mistake|hidden`,
`POST /api/inspections/{id}/reassign`, `GET /api/cubbies`, `GET /api/events`,
`POST /api/voice/parse`, `POST /api/voice/transcribe`, `POST /api/reset`.

### Order shape: stable IDs and quantities

```json
{"customer_name": "Sam",
 "items": [{"menu_id": "burger", "qty": 2, "modifiers": {"lettuce": "no"}},
           {"menu_id": "fries",  "qty": 1, "modifiers": {}}]}
```

Menu IDs and component IDs are defined in `backend/menu.py`. Do not rename an existing ID; add a new one instead.
A modifier is either `"no"` (remove a default component) or `"add"` (add an optional one).

### Observation shape: what vision returns

Vision reports only what it sees. `backend/matching.py` decides the result.

```json
{"items": [{"menu_id": "burger",
            "components": {"bun": "present", "lettuce": "unknown", "cheese": "absent"}}],
 "notes": "lettuce may be under the patty"}
```

- Include one entry per physical unit, so two burgers means two entries.
- Each component is `present`, `absent`, or `unknown`. If lettuce might be hidden, report `unknown`, not `absent`. A component left out of the list counts as `unknown`.
- The backend returns one of three verdicts:
  - `pass`: the order is verified and can go to a cubby.
  - `fail`: the meal contradicts the ticket.
  - `needs_review`: something could not be confirmed. Staff can retake the photo or override.

Send the inspection as JSON (`{"observations": {...}, "photo_base64": "..."}`) or as multipart (`photo` file plus an `observations` JSON string).

## Design decisions

- **Ticket first, photo second.** The meal is compared against the ticket the cook intended to make. It is not matched across all tickets.
- **Swaps are suggestions only.** If a failed meal matches another open ticket, the inspection shows *"appears to match Order N — possible swap."* Nothing moves until staff click **Confirm**. That creates a new, linked inspection on the other order and keeps the original.
- **Inspections are records.** Each retake adds a row, and earlier photos and explanations stay in the history.
- **Cubbies are simulated.** Assigning a cubby plays a door-opening animation and announces it with browser text-to-speech, for example *"Order 3 for Isla is ready in cubby 1."* Confirming pickup records the delivery and frees the cubby.

## Where each team plugs in

| Team | File | What to implement |
|---|---|---|
| Vision | `backend/vision.py` | `analyze(photo_bytes, order) -> observations` (currently returns `None`) |
| Voice | `backend/voice.py` | `transcribe(audio, content_type) -> str`; replace the keyword `parse_order` with an LLM, keeping the same output shape |
| Logic | `backend/matching.py` | Verdict rules and swap suggestions |
| UI | `frontend/` | Plain HTML, CSS, and JS, with no build step |

Until vision is wired up, **📷 Photo inspection** stores the real photo together with a sample result, so the camera path can be tested end to end.
The **Test lab** panel (right column) checks the microphone, camera, and speech output on any device.

## Palette

Rich Mahogany `#3c1518` · Dark Garnet `#69140e` · Soft Apricot `#fee1c7` · Vibrant Coral `#fa7e61` · Wild Strawberry `#f44174`
