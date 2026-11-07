// Stable menu definitions.
//
// IDs here are a contract shared by voice, vision and the dashboard. Never
// rename an ID once teammates depend on it -- add a new one instead.
//
// Each menu item lists its *components*: things vision can try to observe.
// `default: true` means it comes on the item unless the order says otherwise.

const MENU = {
  burger: {
    name: "Burger",
    components: {
      bun: { name: "Bun", default: true, removable: false },
      patty: { name: "Beef patty", default: true, removable: false },
      lettuce: { name: "Lettuce", default: true, removable: true },
      tomato: { name: "Tomato", default: true, removable: true },
      cheese: { name: "Cheese", default: true, removable: true },
      onion: { name: "Onion", default: false, removable: true },
      pickles: { name: "Pickles", default: false, removable: true },
    },
  },
  chicken_sandwich: {
    name: "Chicken Sandwich",
    components: {
      bun: { name: "Bun", default: true, removable: false },
      chicken: { name: "Chicken", default: true, removable: false },
      lettuce: { name: "Lettuce", default: true, removable: true },
      pickles: { name: "Pickles", default: true, removable: true },
      tomato: { name: "Tomato", default: false, removable: true },
    },
  },
  fries: {
    name: "Fries",
    components: { fries: { name: "Fries", default: true, removable: false } },
  },
  salad: {
    name: "Side Salad",
    components: {
      lettuce: { name: "Lettuce", default: true, removable: false },
      tomato: { name: "Tomato", default: true, removable: true },
      onion: { name: "Onion", default: true, removable: true },
    },
  },
  soda: {
    name: "Soda",
    components: { cup: { name: "Cup", default: true, removable: false } },
  },
};

/**
 * Return {componentId: shouldBePresent} for one unit of a menu item.
 * modifiers: {componentId: "add" | "no"}
 */
function expectedComponents(menuId, modifiers = {}) {
  const item = MENU[menuId];
  if (!item) throw new Error(`Unknown menu_id '${menuId}'`);
  const result = {};
  for (const [cid, c] of Object.entries(item.components)) result[cid] = c.default;
  for (const [cid, action] of Object.entries(modifiers || {})) {
    const comp = item.components[cid];
    if (!comp) throw new Error(`Unknown component '${cid}' for '${menuId}'`);
    if (action === "no") {
      if (!comp.removable) throw new Error(`'${cid}' cannot be removed from '${menuId}'`);
      result[cid] = false;
    } else if (action === "add") {
      result[cid] = true;
    } else {
      throw new Error(`Modifier action must be 'add' or 'no', got '${action}'`);
    }
  }
  return result;
}

module.exports = { MENU, expectedComponents };
