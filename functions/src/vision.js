// VISION TEAM: plug the model in here.
//
// Contract: analyze(photoBuffer, contentType, order) -> Promise<observations | null>
// Return null while no model is wired up.
//
// Rules:
//   * Report only what you can SEE. Do not decide pass/fail -- matching.js does.
//   * Use "present" / "absent" / "unknown" per component. If lettuce could be
//     hidden under the bun, say "unknown", never "absent".
//   * One entry in `items` per physical unit (two burgers -> two entries).
//   * The selected order is passed only as context for which components to
//     look for. Don't copy the ticket into the answer.
//
// API keys: read them from process.env (use Firebase secrets in production),
// never commit them.

async function analyze(photoBuffer, contentType, order) {
  return null; // Not wired yet -> the API asks the caller for observations.
}

module.exports = { analyze };
