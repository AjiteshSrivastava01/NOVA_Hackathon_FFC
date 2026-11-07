// The menu. Single source of truth for voice, vision, matching and the dashboards.
//
//   burger  (standard toppings: lettuce, tomato; either can be left off)
//   fries, wings, soda, pizza, water
//
// IDs are a contract: display-board/lib/menu.ts mirrors this file.
// Each item lists its *components*: things the camera checks. Anything else on
// the plate that isn't listed here (e.g. extra toppings like cheese or onion on a
// burger) is ignored.
// `default: true` = comes with the item; `removable` = the customer can say "no ___".

const MENU = {
  burger: {
    name: "Burger",
    components: {
      bun: { name: "Bun", default: true, removable: false },
      patty: { name: "Patty", default: true, removable: false },
      lettuce: { name: "Lettuce", default: true, removable: true },
      tomato: { name: "Tomato", default: true, removable: true },
    },
  },
  fries: { name: "Fries", components: { fries: { name: "Fries", default: true, removable: false } } },
  wings: { name: "Wings", components: { wings: { name: "Wings", default: true, removable: false } } },
  soda: { name: "Soda", components: { soda: { name: "Soda", default: true, removable: false } } },
  pizza: { name: "Pizza", components: { pizza: { name: "Pizza", default: true, removable: false } } },
  water: { name: "Water", components: { water: { name: "Water", default: true, removable: false } } },
};

/**
 * Return {componentId: shouldBePresent} for one unit of a menu item.
 * modifiers: {componentId: "no"}   ("add" is accepted for optional components; the
 * current menu has none)
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
