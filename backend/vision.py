"""VISION TEAM: plug the model in here.

Contract: analyze(photo_bytes, order) -> observations dict (see matching.py),
or None if no model is wired up yet.

Rules:
  * Report only what you can SEE. Do not decide pass/fail -- matching.py does.
  * Use "present" / "absent" / "unknown" per component. If lettuce could be
    hidden under the bun, say "unknown", never "absent".
  * One entry in "items" per physical unit (two burgers -> two entries).
  * You get the selected order only as context for which components to look
    for. Don't copy the ticket into the answer.
"""


def analyze(photo_bytes: bytes, order: dict) -> dict | None:
    return None  # Not wired yet -> the API asks the caller for observations.
