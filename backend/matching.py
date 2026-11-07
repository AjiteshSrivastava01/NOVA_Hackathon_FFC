"""Decision logic: does an *observation* satisfy a *ticket*?

Vision only reports what it sees (observations). This module is the only place
that decides pass / fail / needs_review. Keep vision dumb, keep this explicit.

Observation format (what the vision module must return):
    {
      "items": [                      # one entry per physical unit seen
        {"menu_id": "burger",
         "components": {"lettuce": "present" | "absent" | "unknown", ...}},
        ...
      ],
      "notes": "free text from the model (optional)"
    }
A component missing from "components" is treated as "unknown".
"""

from itertools import permutations

from .menu import MENU, expected_components

PASS, FAIL, REVIEW = "pass", "fail", "needs_review"
TRI_STATE = {"present", "absent", "unknown"}


def expand_order(items: list[dict]) -> list[dict]:
    """Turn order lines (with qty) into one expected unit per physical item."""
    units = []
    for line in items:
        exp = expected_components(line["menu_id"], line.get("modifiers"))
        for _ in range(int(line.get("qty", 1))):
            units.append({"menu_id": line["menu_id"], "line_id": line.get("line_id"), "expected": exp})
    return units


def _compare_unit(expected: dict[str, bool], observed: dict[str, str]):
    """Return (contradictions, unknowns) lists of human-readable strings."""
    contradictions, unknowns = [], []
    for cid, should in expected.items():
        seen = observed.get(cid, "unknown")
        if seen not in TRI_STATE:
            seen = "unknown"
        if seen == "unknown":
            unknowns.append(cid)
        elif should and seen == "absent":
            contradictions.append(f"{cid} missing")
        elif not should and seen == "present":
            contradictions.append(f"{cid} present but should not be")
    return contradictions, unknowns


def _score(c, u):
    return len(c) * 10 + len(u)


def _best_assignment(exp_units, obs_units):
    """Pair expected and observed units of the same menu_id, minimising errors."""
    n = len(exp_units)
    if n <= 6:
        best = None
        for perm in permutations(range(n)):
            res = [_compare_unit(exp_units[i]["expected"], obs_units[perm[i]].get("components", {})) for i in range(n)]
            total = sum(_score(c, u) for c, u in res)
            if best is None or total < best[0]:
                best = (total, res)
        return best[1]
    # Greedy fallback for big orders.
    remaining = list(range(n))
    out = []
    for e in exp_units:
        scored = [(_score(*_compare_unit(e["expected"], obs_units[j].get("components", {}))), j) for j in remaining]
        _, j = min(scored)
        remaining.remove(j)
        out.append(_compare_unit(e["expected"], obs_units[j].get("components", {})))
    return out


def evaluate(order_items: list[dict], observations: dict) -> dict:
    """Compare observations against one order. Returns {verdict, reasons}."""
    expected = expand_order(order_items)
    observed = observations.get("items", []) or []
    reasons, has_fail, has_unknown = [], False, False

    exp_by, obs_by = {}, {}
    for u in expected:
        exp_by.setdefault(u["menu_id"], []).append(u)
    for o in observed:
        obs_by.setdefault(o.get("menu_id"), []).append(o)

    for menu_id in sorted(set(exp_by) | set(obs_by), key=str):
        e, o = exp_by.get(menu_id, []), obs_by.get(menu_id, [])
        label = MENU.get(menu_id, {}).get("name", str(menu_id))
        if len(e) != len(o):
            has_fail = True
            reasons.append(f"{label}: expected {len(e)}, saw {len(o)}")
            continue
        for idx, (c, u) in enumerate(_best_assignment(e, o), 1):
            tag = f"{label} #{idx}" if len(e) > 1 else label
            if c:
                has_fail = True
                reasons.append(f"{tag}: " + ", ".join(c))
            if u:
                has_unknown = True
                reasons.append(f"{tag}: can't confirm " + ", ".join(u))

    verdict = FAIL if has_fail else REVIEW if has_unknown else PASS
    if verdict == PASS:
        reasons.append("Everything on the ticket is visible and correct.")
    return {"verdict": verdict, "reasons": reasons}


def suggest_swap(observations: dict, other_orders: list[dict]) -> dict | None:
    """Secondary hint only: does this meal look like a *different* open ticket?

    Never reassigns anything -- staff must confirm.
    """
    best = None
    for o in other_orders:
        result = evaluate(o["items"], observations)
        if result["verdict"] == FAIL:
            continue
        rank = 0 if result["verdict"] == PASS else 1
        # Prefer exact matches, then the oldest ticket.
        key = (rank, o["created_at"])
        if best is None or key < best[0]:
            best = (key, o, result)
    if not best:
        return None
    _, o, result = best
    return {
        "order_id": o["id"],
        "verdict": result["verdict"],
        "message": f"This meal appears to match Order {o['id']} ({o['customer_name']}) — possible swap. Staff must confirm.",
    }
