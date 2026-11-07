import type { Order, OrderItem } from "./types";

// In-memory store, fine for local use and demos.
// On serverless hosting (e.g. Vercel) memory is not shared between requests:
// swap this file for Supabase/Firebase/etc. before deploying.
const g = globalThis as unknown as { __orders?: Order[] };
const orders: Order[] = (g.__orders ??= []);

export function addOrder(table: number, items: OrderItem[], transcript: string): Order {
  const order: Order = {
    id: crypto.randomUUID(),
    table,
    items,
    transcript,
    createdAt: Date.now(),
    status: "open",
  };
  orders.push(order);
  return order;
}

export function listOpen(): Order[] {
  return orders.filter((o) => o.status === "open");
}

export function getOpenForTable(table: number): Order[] {
  return listOpen().filter((o) => o.table === table);
}

export function serveOrder(id: string): boolean {
  const order = orders.find((o) => o.id === id);
  if (!order) return false;
  order.status = "served";
  return true;
}
