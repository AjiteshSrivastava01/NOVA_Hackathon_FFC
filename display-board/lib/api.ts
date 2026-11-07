// Transport + adapter: in-browser mock, or the team backend (functions/src/app.js).
// Teammates should call lib/actions.ts, not this file.
//
// Real mode talks to the backend through this app's /api rewrite (next.config.ts →
// BACKEND_URL, default http://localhost:8000). Backend shapes are mapped to the UI
// view model in lib/types.ts here and nowhere else.
//
// Mock mode is on when NEXT_PUBLIC_USE_MOCK=true, or when forced on in this
// browser from /dev (handy if the backend dies mid-demo; no restart needed).

import * as mock from "./mockApi";
import type {
  BackendInspection,
  BackendOrder,
  BackendStatus,
  CreateOrderInput,
  Inspection,
  Order,
  OrderItem,
  OrderStatus,
} from "./types";

// ---------------------------------------------------------------------------
// Every backend route this app calls (all exist in functions/src/app.js).
// ---------------------------------------------------------------------------
export const ENDPOINTS = {
  listOrders: { method: "GET", path: () => "/api/orders?include_done=true" }, // → BackendOrder[] (with inspections)
  getOrder: { method: "GET", path: (id: number) => `/api/orders/${id}` }, // → BackendOrder
  createOrder: { method: "POST", path: () => "/api/orders" }, // { customer_name, items, source } → BackendOrder
  inspect: { method: "POST", path: (id: number) => `/api/orders/${id}/inspect` }, // { photo_base64 } → BackendInspection
  reassign: { method: "POST", path: (inspectionId: number) => `/api/inspections/${inspectionId}/reassign` }, // { target_order_id } → BackendInspection
  assignCubby: { method: "POST", path: (id: number) => `/api/orders/${id}/assign-cubby` }, // { override?, staff_note? } → BackendOrder ("mark ready for pickup")
  pickup: { method: "POST", path: (id: number) => `/api/orders/${id}/pickup` }, // → BackendOrder
} as const;

const ENV_MOCK = process.env.NEXT_PUBLIC_USE_MOCK === "true";
const OVERRIDE_KEY = "ffc-force-mock";

/** True when calls go to the in-browser mock instead of the real backend. */
export function isMock(): boolean {
  if (ENV_MOCK) return true;
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(OVERRIDE_KEY) === "1";
  } catch {
    return false;
  }
}

export function isMockFromEnv(): boolean {
  return ENV_MOCK;
}

/** Force mock mode on/off in this browser only (from /dev). */
export function setMockOverride(on: boolean) {
  try {
    if (on) window.localStorage.setItem(OVERRIDE_KEY, "1");
    else window.localStorage.removeItem(OVERRIDE_KEY);
  } catch {
    /* ignore */
  }
}

async function http<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const b = await res.json();
      msg = b.detail ?? b.error ?? b.message ?? msg; // backend uses { detail }
    } catch {
      /* not JSON */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

// ---------------- backend → view model ----------------

const STATUS: Record<BackendStatus, OrderStatus> = {
  pending: "pending",
  verified: "pending", // passed, about to be marked ready (submitMealPhoto does it right away)
  needs_attention: "flagged",
  in_cubby: "in_cubby",
  picked_up: "delivered",
};

const PASS_REASON = "Everything on the ticket is visible and correct.";

function toInspection(b: BackendInspection): Inspection {
  return {
    id: String(b.id),
    order_id: b.order_id,
    created_at: b.created_at,
    verdict: b.verdict === "pass" ? "pass" : b.verdict === "fail" ? "flag" : "retake",
    detected: {
      items: (b.observations?.items ?? []).map((it) => ({
        menu_id: it.menu_id,
        qty: 1,
        mods: it.components,
        confidence: 1,
      })),
      notes: b.observations?.notes ?? "",
    },
    differences: (b.reasons ?? []).filter((r) => r !== PASS_REASON),
    possible_swap_order_id: b.swap_suggestion?.order_id ?? null,
  };
}

function toOrder(b: BackendOrder): Order {
  const latest = b.latest_inspection ?? b.inspections?.[0] ?? null;
  const status = STATUS[b.status] ?? "pending";
  return {
    id: b.id,
    status,
    items: b.items.map((l) => ({
      menu_id: l.menu_id,
      qty: l.qty,
      mods: Object.keys(l.modifiers ?? {}).length
        ? Object.fromEntries(Object.entries(l.modifiers).map(([k, v]) => [k, v === "add"]))
        : undefined,
    })),
    cubby: b.cubby_id,
    flag_reason:
      status === "flagged" && latest ? latest.reasons.filter((r) => r !== PASS_REASON).join("; ") || null : null,
    created_at: b.created_at,
    customer_name: b.customer_name,
  };
}

function toBackendLines(items: OrderItem[]) {
  return items.map((it) => ({
    menu_id: it.menu_id,
    qty: it.qty,
    modifiers: Object.fromEntries(Object.entries(it.mods ?? {}).map(([k, v]) => [k, v ? "add" : "no"])),
  }));
}

// GET /api/orders already embeds each order's inspections; keep them so the
// board/camera don't need a request per order.
const inspectionCache = new Map<number, Inspection[]>();
const latestInspectionId = new Map<number, number>();

function remember(b: BackendOrder) {
  const list = (b.inspections ?? []).map(toInspection); // backend sorts newest first
  inspectionCache.set(b.id, list);
  const latest = b.latest_inspection ?? b.inspections?.[0];
  if (latest) latestInspectionId.set(b.id, latest.id);
}

// ---------------- API surface ----------------

export async function getOrders(): Promise<Order[]> {
  if (isMock()) return mock.getOrders();
  const e = ENDPOINTS.listOrders;
  const raw = await http<BackendOrder[]>(e.method, e.path());
  raw.forEach(remember);
  return raw.map(toOrder);
}

export async function createOrder(input: CreateOrderInput): Promise<Order> {
  if (isMock()) return mock.createOrder(input);
  const e = ENDPOINTS.createOrder;
  const b = await http<BackendOrder>(e.method, e.path(), {
    customer_name: "", // orders are identified by number only (backend ignores names)
    items: toBackendLines(input.items),
    source: "voice",
  });
  remember(b);
  return toOrder(b);
}

/** @param image raw base64 JPEG (no "data:" prefix) */
export async function inspectOrder(orderId: number, image: string): Promise<Inspection> {
  if (isMock()) return mock.inspectOrder(orderId, image);
  const e = ENDPOINTS.inspect;
  const b = await http<BackendInspection>(e.method, e.path(orderId), {
    photo_base64: `data:image/jpeg;base64,${image}`,
  });
  latestInspectionId.set(orderId, b.id);
  const ins = toInspection(b);
  inspectionCache.set(orderId, [ins, ...(inspectionCache.get(orderId) ?? [])]);
  return ins;
}

/** assign-cubby == "mark ready for pickup". */
export async function assignCubby(
  orderId: number,
  input: { override?: boolean; staff_note?: string } = {},
): Promise<Order> {
  if (isMock()) return mock.assignCubby(orderId, input);
  const e = ENDPOINTS.assignCubby;
  return toOrder(await http<BackendOrder>(e.method, e.path(orderId), input));
}

/**
 * Staff confirmed the meal photographed for `flaggedOrderId` belongs to `actualOrderId`.
 * Backend: reassign the flagged order's latest inspection to the actual order
 * (keeps the photo + observations as a new linked inspection), then mark the
 * actual order ready for pickup.
 */
export async function reassignMeal(flaggedOrderId: number, actualOrderId: number): Promise<Order> {
  if (isMock()) return mock.assignCubby(actualOrderId, { override: true });
  let inspectionId = latestInspectionId.get(flaggedOrderId);
  if (inspectionId === undefined) {
    const g = ENDPOINTS.getOrder;
    const o = await http<BackendOrder>(g.method, g.path(flaggedOrderId));
    remember(o);
    inspectionId = latestInspectionId.get(flaggedOrderId);
  }
  if (inspectionId === undefined) throw new Error(`Order ${flaggedOrderId} has no inspection to reassign`);
  const r = ENDPOINTS.reassign;
  const moved = await http<BackendInspection>(r.method, r.path(inspectionId), { target_order_id: actualOrderId });
  // Staff confirmed the swap, so mark ready even if the moved photo isn't a clean pass.
  return assignCubby(
    actualOrderId,
    moved.verdict === "pass" ? {} : { override: true, staff_note: `Swap confirmed from order ${flaggedOrderId}` },
  );
}

export async function pickupOrder(orderId: number): Promise<Order> {
  if (isMock()) return mock.pickupOrder(orderId);
  const e = ENDPOINTS.pickup;
  return toOrder(await http<BackendOrder>(e.method, e.path(orderId)));
}

/** Past inspections for an order, newest first. */
export async function getInspections(orderId: number): Promise<Inspection[]> {
  if (isMock()) return mock.getInspections(orderId);
  const cached = inspectionCache.get(orderId);
  if (cached) return cached;
  try {
    const g = ENDPOINTS.getOrder;
    const o = await http<BackendOrder>(g.method, g.path(orderId));
    remember(o);
    return inspectionCache.get(orderId) ?? [];
  } catch {
    return [];
  }
}

/**
 * Orders being photo-checked right now (display-only VERIFYING).
 * Mock: shared across tabs. Real: the backend has no such state, so only
 * checks started from this browser show as VERIFYING.
 */
const localInspecting = new Set<number>();
export async function getInspectingIds(): Promise<number[]> {
  if (isMock()) return mock.getInspectingIds();
  return [...localInspecting];
}

export async function setInspecting(orderId: number, on: boolean): Promise<void> {
  if (isMock()) return mock.setInspecting(orderId, on);
  if (on) localInspecting.add(orderId);
  else localInspecting.delete(orderId);
}

/** Instant change notifications (mock only; real mode relies on polling). */
export function subscribe(cb: () => void): () => void {
  return isMock() ? mock.subscribe(cb) : () => {};
}
