import type { OrderItem } from "./types";

// Mirrors functions/src/menu.js (the team's source of truth). IDs must match exactly.

export type MenuMod = { key: string; label: string; default: boolean };

export type MenuItem = {
  id: string;
  name: string;
  emoji: string;
  mods?: MenuMod[];
};

export const MENU: MenuItem[] = [
  {
    id: "burger",
    name: "Burger",
    emoji: "🍔",
    mods: [
      { key: "lettuce", label: "lettuce", default: true },
      { key: "tomato", label: "tomato", default: true },
    ],
  },
  { id: "fries", name: "Fries", emoji: "🍟" },
  { id: "wings", name: "Wings", emoji: "🍗" },
  { id: "soda", name: "Soda", emoji: "🥤" },
  { id: "pizza", name: "Pizza", emoji: "🍕" },
  { id: "water", name: "Water", emoji: "💧" },
];

const BY_ID = new Map(MENU.map((m) => [m.id, m]));

export function getMenuItem(id: string): MenuItem | undefined {
  return BY_ID.get(id);
}

export function menuName(id: string): string {
  return BY_ID.get(id)?.name ?? id;
}

export function modLabel(menuId: string, key: string): string {
  return BY_ID.get(menuId)?.mods?.find((m) => m.key === key)?.label ?? key;
}

/** ["no lettuce", "no tomato"] for display. */
export function describeMods(item: OrderItem): string[] {
  if (!item.mods) return [];
  return Object.entries(item.mods).map(([key, want]) =>
    want ? `with ${modLabel(item.menu_id, key)}` : `no ${modLabel(item.menu_id, key)}`,
  );
}
