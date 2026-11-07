# Vision Lab

A standalone page for testing the vision model. Build an order, take a photo, and see whether the meal matches the ticket, ingredient by ingredient.

It runs the same code as the real app (`functions/src/vision.js`, `matching.js` and `menu.js`). It only reads those files and changes nothing else. It doesn't need `npm install`.

## Run on your laptop

From the repo root:

```bash
cd vision-lab
```

```bash
node server.js
```

Open http://localhost:8090.

- The key is read from `functions/vision.local.env`, the same file the backend uses.
- To test with your **phone camera** on the same Wi-Fi, open `http://<your-laptop-IP>:8090` on the phone. On a Mac, find the IP under System Settings → Wi-Fi → Details.
- On a phone, use **Take / choose photo**. The **Use webcam** button only works on `localhost` or HTTPS.

## Host it (e.g. Render, free)

1. Go to https://render.com, click **New → Web Service**, and connect this GitHub repo.
2. Use these settings:
   - **Root directory:** leave empty. The lab needs the `functions/` folder too.
   - **Build command:** leave empty.
   - **Start command:** `node vision-lab/server.js`
3. Add **Environment** variables:
   - `OPENROUTER_API_KEY` = your key
   - `LAB_PASSWORD` = any password. **Always set this when hosting**, or anyone who finds the URL can spend your credit.
   - `OPENROUTER_VISION_MODEL` (optional) = a model ID to override the team default.
4. Deploy, open the URL, and enter the password on the page.

## Using the results

- The **Model saw** column highlights the exact ingredient the model got wrong.
- The page shows model time, cost and confidence for each run, so you can compare models by changing the **Model** field.
- **Save as a test case:** download the photo into `functions/vision-testset/`, copy the label JSON into `labels.json`, and fix the truth wherever the model was wrong. That builds your test set for `node functions/scripts/eval-vision.js`.
