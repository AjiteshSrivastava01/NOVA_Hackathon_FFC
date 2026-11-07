// Pure helpers for the passive display board.

import { describeMods, menuName } from "./menu";
import type { Inspection, Order } from "./types";

export type DisplayStatus = "PREPARING" | "VERIFYING" | "CHECK ORDER" | "READY FOR PICKUP" | "PICKED UP";

/** Contract status (+ display-only inspecting flag) → board status. */
export function displayStatus(order: Order, inspecting: boolean): DisplayStatus {
  switch (order.status) {
    case "flagged":
      return inspecting ? "VERIFYING" : "CHECK ORDER";
    case "in_cubby": // "cubby" == ready for pickup
      return "READY FOR PICKUP";
    case "delivered":
      return "PICKED UP";
    default:
      return inspecting ? "VERIFYING" : "PREPARING";
  }
}

export const SORT_RANK: Record<DisplayStatus, number> = {
  "CHECK ORDER": 0,
  "READY FOR PICKUP": 1,
  PREPARING: 2,
  VERIFYING: 2,
  "PICKED UP": 3,
};

/** "1× BURGER · NO LETTUCE, CHEESE" */
export function itemLines(order: Order): string[] {
  return order.items.map((it) => {
    const mods = describeMods(it).map((m) => m.replace(/^with /, ""));
    const base = `${it.qty}× ${menuName(it.menu_id)}`;
    return (mods.length ? `${base} · ${mods.join(", ")}` : base).toUpperCase();
  });
}

export function differencesFor(order: Order, latest?: Inspection): string[] {
  if (latest?.verdict === "flag" && latest.differences.length) return latest.differences;
  return order.flag_reason ? order.flag_reason.split("; ") : [];
}

/** "Burger: ticket says no lettuce, lettuce detected" → "lettuce detected" */
export function shortDifference(d: string): string {
  const parts = d.split(", ");
  return parts.length > 1 ? parts[parts.length - 1] : d.replace(/^[^:]+:\s*/, "");
}

export function sinceLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
}
