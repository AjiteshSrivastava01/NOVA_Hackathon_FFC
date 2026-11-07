"""Stable menu definitions.

IDs here are a contract shared by voice, vision and the dashboard. Never rename
an ID once teammates depend on it -- add a new one instead.

Each menu item lists its *components*. A component is something vision can try
to observe (lettuce, cheese, ...). `default: True` means it comes on the item
unless the order says otherwise.
"""

MENU = {
    "burger": {
        "name": "Burger",
        "components": {
            "bun": {"name": "Bun", "default": True, "removable": False},
            "patty": {"name": "Beef patty", "default": True, "removable": False},
            "lettuce": {"name": "Lettuce", "default": True, "removable": True},
            "tomato": {"name": "Tomato", "default": True, "removable": True},
            "cheese": {"name": "Cheese", "default": True, "removable": True},
            "onion": {"name": "Onion", "default": False, "removable": True},
            "pickles": {"name": "Pickles", "default": False, "removable": True},
        },
    },
    "chicken_sandwich": {
        "name": "Chicken Sandwich",
        "components": {
            "bun": {"name": "Bun", "default": True, "removable": False},
            "chicken": {"name": "Chicken", "default": True, "removable": False},
            "lettuce": {"name": "Lettuce", "default": True, "removable": True},
            "pickles": {"name": "Pickles", "default": True, "removable": True},
            "tomato": {"name": "Tomato", "default": False, "removable": True},
        },
    },
    "fries": {
        "name": "Fries",
        "components": {
            "fries": {"name": "Fries", "default": True, "removable": False},
        },
    },
    "salad": {
        "name": "Side Salad",
        "components": {
            "lettuce": {"name": "Lettuce", "default": True, "removable": False},
            "tomato": {"name": "Tomato", "default": True, "removable": True},
            "onion": {"name": "Onion", "default": True, "removable": True},
        },
    },
    "soda": {
        "name": "Soda",
        "components": {
            "cup": {"name": "Cup", "default": True, "removable": False},
        },
    },
}


def expected_components(menu_id: str, modifiers: dict | None) -> dict[str, bool]:
    """Return {component_id: should_be_present} for one unit of a menu item.

    modifiers: {component_id: "add" | "no"}
    """
    item = MENU[menu_id]
    result = {cid: c["default"] for cid, c in item["components"].items()}
    for cid, action in (modifiers or {}).items():
        if cid not in result:
            raise ValueError(f"Unknown component '{cid}' for '{menu_id}'")
        if action == "no":
            if not item["components"][cid]["removable"]:
                raise ValueError(f"'{cid}' cannot be removed from '{menu_id}'")
            result[cid] = False
        elif action == "add":
            result[cid] = True
        else:
            raise ValueError(f"Modifier action must be 'add' or 'no', got '{action}'")
    return result
