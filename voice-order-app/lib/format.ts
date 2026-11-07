import type { Order, OrderItem } from "./types";

/** "2× Burger (no lettuce)" */
export function formatItem(item: OrderItem): string {
  const qty = item.quantity > 1 ? `${item.quantity}× ` : "";
  const notes = item.notes ? ` (${item.notes})` : "";
  return `${qty}${item.name}${notes}`;
}

/** Combine identical items (same name + notes) across several orders. */
export function mergeItems(items: OrderItem[]): OrderItem[] {
  const map = new Map<string, OrderItem>();
  for (const it of items) {
    const key = `${it.name.toLowerCase()}|${(it.notes ?? "").toLowerCase()}`;
    const existing = map.get(key);
    if (existing) existing.quantity += it.quantity;
    else map.set(key, { ...it });
  }
  return [...map.values()];
}

/** "Burger (no lettuce), Fries for table 12" */
export function formatSummary(items: OrderItem[], table: number): string {
  return `${mergeItems(items).map(formatItem).join(", ")} for table ${table}`;
}

export function formatOrderLine(order: Order): string {
  return formatSummary(order.items, order.table);
}
