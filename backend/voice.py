"""VOICE TEAM: plug speech-to-text / order parsing in here.

Contract:
  transcribe(audio_bytes, content_type) -> str | None
  parse_order(transcript) -> {"customer_name": str, "items": [...]}
The items list must use the stable IDs in menu.py, e.g.
  [{"menu_id": "burger", "qty": 2, "modifiers": {"lettuce": "no"}}]

The keyword parser below is a placeholder so the pipeline works end to end.
Replace it with an LLM call when ready; keep the output shape.
"""

import re

from .menu import MENU

NUMBERS = {"a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5}
ALIASES = {
    "burger": "burger", "burgers": "burger", "hamburger": "burger", "cheeseburger": "burger",
    "chicken sandwich": "chicken_sandwich", "chicken sandwiches": "chicken_sandwich",
    "fries": "fries", "fry": "fries", "salad": "salad", "salads": "salad",
    "soda": "soda", "sodas": "soda", "coke": "soda", "drink": "soda", "drinks": "soda",
}


def transcribe(audio_bytes: bytes, content_type: str) -> str | None:
    return None  # Not wired yet.


def parse_order(transcript: str) -> dict:
    text = transcript.lower()
    name_match = re.search(r"(?:for|name is|this is|i'm|i am)\s+([a-z]+)", text)
    customer = name_match.group(1).title() if name_match else "Guest"
    items = []
    # Split on "and"/commas so modifiers attach to the right item.
    for chunk in re.split(r",|\band\b(?!\s+(?:no|extra|add)\b)", text):
        for alias in sorted(ALIASES, key=len, reverse=True):
            m = re.search(r"(?:(\d+|a|an|one|two|three|four|five)\s+)?" + re.escape(alias) + r"\b", chunk)
            if not m:
                continue
            menu_id = ALIASES[alias]
            q = m.group(1)
            qty = int(q) if q and q.isdigit() else NUMBERS.get(q, 1)
            mods = {}
            for comp, meta in MENU[menu_id]["components"].items():
                if re.search(rf"\b(no|without|hold the)\s+{comp}", chunk) and meta["removable"]:
                    mods[comp] = "no"
                elif re.search(rf"\b(extra|add|with)\s+{comp}", chunk) and not meta["default"]:
                    mods[comp] = "add"
            if alias == "cheeseburger":
                mods.pop("cheese", None)
            items.append({"menu_id": menu_id, "qty": qty, "modifiers": mods})
            break
    return {"customer_name": customer, "items": items}
