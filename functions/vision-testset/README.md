# Vision test set

Put 20–40 photos in this folder, then describe each one in `labels.json` with the ticket it was made for and **what is really on the plate**:

```json
[
  {
    "photo": "01-burger-correct.jpg",
    "ticket": [{"menu_id": "burger", "qty": 1, "modifiers": {"lettuce": "no"}}],
    "truth": [{"menu_id": "burger", "components": {"bun": "present", "patty": "present", "lettuce": "absent",
               "tomato": "present", "cheese": "present", "onion": "absent", "pickles": "absent"}}]
  }
]
```

- About a third should be **deliberate mistakes**, where the truth differs from the ticket.
- Add a few **bad photos** (blurry, dark, half out of frame) with `"truth": "retake"`.
- Add a few where lettuce is **partly hidden** under the bun. Label the truth with what is really there (`"present"` or `"absent"`). These show how well the model guesses hidden ingredients.

Put your key in `functions/vision.local.env` (git-ignored), on one line:

```
OPENROUTER_API_KEY=sk-or-...
```

Then, from the `functions` folder:

```bash
node scripts/eval-vision.js model/one model/two
```
