// In-browser mock of P3's backend. State lives in localStorage and is synced
// across tabs (dashboard tab + camera tab) with BroadcastChannel.
// NOTE: localStorage is per-browser, so a phone and a laptop do NOT share mock
// state. For cross-device demos, use the real backend (NEXT_PUBLIC_USE_MOCK=false).

import { getMenuItem, menuName, modLabel } from "./menu";
import type {
  CreateOrderInput,
  DetectedItem,
  Inspection,
  Observation,
  Order,
  OrderItem,
  Verdict,
} from "./types";
import { CUBBY_COUNT } from "./types";

const STORAGE_KEY = "ffc-mock-v2"; // v2: team-backend menu ids

type AssignCubbyInput = { override?: boolean; staff_note?: string };
const CHANNEL = "ffc-mock";

export type ForceMode = "auto" | Verdict;

type MockState = {
  orders: Order[];
  inspections: Inspection[];
  nextId: number;
  forceNext: ForceMode;
  /** Display-only: order ids with a photo check in flight (VERIFYING). Not in the shared contract. */
  inspecting: number[];
};

function minutesAgo(m: number) {
  return new Date(Date.now() - m * 60_000).toISOString();
}

function seed(): MockState {
  return {
    orders: [
      {
        id: 18,
        status: "delivered",
        items: [{ menu_id: "fries", qty: 2 }, { menu_id: "soda", qty: 1 }],
        cubby: null,
        flag_reason: null,
        created_at: minutesAgo(14),
        customer_name: "",
      },
      {
        id: 19,
        status: "in_cubby",
        items: [
          { menu_id: "burger", qty: 1, mods: { onion: true } },
          { menu_id: "fries", qty: 1 },
        ],
        cubby: 2,
        flag_reason: null,
        created_at: minutesAgo(9),
        customer_name: "",
      },
      {
        id: 20,
        status: "pending",
        items: [
          { menu_id: "chicken_sandwich", qty: 1 },
          { menu_id: "salad", qty: 1, mods: { onion: false } },
        ],
        cubby: null,
        flag_reason: null,
        created_at: minutesAgo(4),
        customer_name: "",
      },
    ],
    inspections: [],
    nextId: 21,
    forceNext: "auto",
    inspecting: [],
  };
}

// ---------- storage + sync ----------

function load(): MockState {
  if (typeof window === "undefined") return seed();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw) as MockState;
      s.inspecting ??= [];
      return s;
    }
  } catch {
    /* fall through to seed */
  }
  const s = seed();
  save(s, false);
  return s;
}

let channel: BroadcastChannel | null = null;
function getChannel(): BroadcastChannel | null {
  if (typeof window === "undefined" || !("BroadcastChannel" in window)) return null;
  if (!channel) channel = new BroadcastChannel(CHANNEL);
  return channel;
}

const localListeners = new Set<() => void>();

function save(s: MockState, notify = true) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable; state is lost on reload */
  }
  if (!notify) return;
  localListeners.forEach((fn) => fn());
  getChannel()?.postMessage("changed");
}

/** Call `cb` whenever mock state changes in this tab or any other tab. */
export function subscribe(cb: () => void): () => void {
  localListeners.add(cb);
  const ch = getChannel();
  const onMsg = () => cb();
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) cb();
  };
  ch?.addEventListener("message", onMsg);
  window.addEventListener("storage", onStorage);
  return () => {
    localListeners.delete(cb);
    ch?.removeEventListener("message", onMsg);
    window.removeEventListener("storage", onStorage);
  };
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function findOrder(s: MockState, id: number): Order {
  const o = s.orders.find((x) => x.id === id);
  if (!o) throw new Error(`Order ${id} not found`);
  return o;
}

// ---------- API surface (mirrors lib/api.ts) ----------

export async function getOrders(): Promise<Order[]> {
  return [...load().orders].sort((a, b) => a.id - b.id);
}

export async function createOrder(input: CreateOrderInput): Promise<Order> {
  await delay(150);
  const s = load();
  const order: Order = {
    id: s.nextId++,
    status: "pending",
    items: input.items,
    cubby: null,
    flag_reason: null,
    created_at: new Date().toISOString(),
    customer_name: "", // orders are identified by number only
  };
  s.orders.push(order);
  save(s);
  return order;
}

export async function getInspections(orderId: number): Promise<Inspection[]> {
  return load()
    .inspections.filter((i) => i.order_id === orderId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function inspectOrder(
  orderId: number,
  _image: string,
  opts?: { force?: Verdict },
): Promise<Inspection> {
  await delay(1600 + Math.random() * 600); // feels like a model call; long enough to see VERIFYING
  const s = load();
  const order = findOrder(s, orderId);
  if (order.status === "delivered") throw new Error(`Order ${orderId} was already picked up`);
  if (order.status === "in_cubby") throw new Error(`Order ${orderId} is already ready for pickup`);

  const verdict: Verdict =
    opts?.force ?? (s.forceNext !== "auto" ? s.forceNext : randomVerdict());

  let inspection: Inspection;
  if (verdict === "pass") {
    inspection = makeInspection(order, "pass", order.items.map((it) => toDetected(it, 0.93)), [], "All items match the ticket.");
    order.status = "pending";
    order.flag_reason = null;
  } else if (verdict === "retake") {
    inspection = makeInspection(
      order,
      "retake",
      order.items.map((it) => toDetected(it, 0.38, true)),
      [],
      "Low confidence: image is blurry or the meal is partly out of frame.",
    );
  } else {
    const { detected, differences } = makeMistake(order);
    const swap = findSwap(s.orders, order.id, detected);
    inspection = makeInspection(order, "flag", detected, differences, "Mismatch with ticket.");
    inspection.possible_swap_order_id = swap;
    order.status = "flagged";
    order.flag_reason = differences.join("; ");
  }

  s.inspections.push(inspection);
  save(s);
  return inspection;
}

/** assign-cubby == "mark ready for pickup". The cubby number is kept internally only. */
export async function assignCubby(orderId: number, input: AssignCubbyInput = {}): Promise<Order> {
  await delay(150);
  const s = load();
  const order = findOrder(s, orderId);
  if (order.status === "in_cubby") return order;
  if (order.status === "delivered") throw new Error(`Order ${orderId} was already picked up`);
  if (order.status === "flagged" && !input.override) {
    throw new Error(`Order ${orderId} is flagged. Re-inspect or use staff override.`);
  }
  const used = new Set(s.orders.filter((o) => o.status === "in_cubby").map((o) => o.cubby));
  let free: number | null = null;
  for (let c = 1; c <= CUBBY_COUNT; c++) {
    if (!used.has(c)) {
      free = c;
      break;
    }
  }
  if (free === null) throw new Error("All pickup spots are full");
  order.status = "in_cubby";
  order.cubby = free;
  order.flag_reason = null;
  save(s);
  return order;
}

export async function pickupOrder(orderId: number): Promise<Order> {
  await delay(150);
  const s = load();
  const order = findOrder(s, orderId);
  if (order.status !== "in_cubby") throw new Error(`Order ${orderId} is not ready for pickup`);
  order.status = "delivered";
  order.cubby = null;
  save(s);
  return order;
}

// ---------- mock-only controls (not part of the real API) ----------

export function getForceNext(): ForceMode {
  return load().forceNext;
}

export function setForceNext(mode: ForceMode) {
  const s = load();
  s.forceNext = mode;
  save(s);
}

export async function getInspectingIds(): Promise<number[]> {
  return load().inspecting;
}

export async function setInspecting(orderId: number, on: boolean): Promise<void> {
  const s = load();
  s.inspecting = s.inspecting.filter((id) => id !== orderId);
  if (on) s.inspecting.push(orderId);
  save(s);
}

export function resetMock() {
  save(seed());
}

// ---------- fake vision logic ----------

function randomVerdict(): Verdict {
  const r = Math.random();
  if (r < 0.6) return "pass";
  if (r < 0.9) return "flag";
  return "retake";
}

function makeInspection(
  order: Order,
  verdict: Verdict,
  items: DetectedItem[],
  differences: string[],
  notes: string,
): Inspection {
  return {
    id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now()),
    order_id: order.id,
    created_at: new Date().toISOString(),
    verdict,
    detected: { items, notes },
    differences,
    possible_swap_order_id: null,
  };
}

function obs(want: boolean): Observation {
  return want ? "present" : "absent";
}

function toDetected(item: OrderItem, confidence: number, fuzzy = false): DetectedItem {
  const d: DetectedItem = { menu_id: item.menu_id, qty: item.qty, confidence };
  if (item.mods) {
    d.mods = Object.fromEntries(
      Object.entries(item.mods).map(([k, v]) => [k, fuzzy ? "unknown" : obs(v)]),
    );
  }
  return d;
}

/** Produce a realistic mistake against the ticket. */
function makeMistake(order: Order): { detected: DetectedItem[]; differences: string[] } {
  const detected = order.items.map((it) => toDetected(it, 0.88));

  // 1) Flip a modifier, preferring a "no X" requirement (most common real mistake).
  const withMods = order.items
    .map((it, idx) => ({ it, idx }))
    .filter(({ it }) => it.mods && Object.keys(it.mods).length > 0);
  if (withMods.length > 0) {
    let pick: { idx: number; key: string; want: boolean } | null = null;
    for (const { it, idx } of withMods) {
      for (const [key, want] of Object.entries(it.mods!)) {
        if (!want) {
          pick = { idx, key, want };
          break;
        }
      }
      if (pick) break;
    }
    if (!pick) {
      const { it, idx } = withMods[0];
      const [key, want] = Object.entries(it.mods!)[0];
      pick = { idx, key, want };
    }
    const it = order.items[pick.idx];
    detected[pick.idx].mods![pick.key] = obs(!pick.want);
    const name = menuName(it.menu_id);
    const label = modLabel(it.menu_id, pick.key);
    return {
      detected,
      differences: [
        pick.want
          ? `${name}: ticket says ${label}, no ${label} detected`
          : `${name}: ticket says no ${label}, ${label} detected`,
      ],
    };
  }

  // 2) Short a quantity.
  const multi = order.items.findIndex((it) => it.qty > 1);
  if (multi >= 0) {
    const it = order.items[multi];
    detected[multi].qty = it.qty - 1;
    return {
      detected,
      differences: [`${menuName(it.menu_id)}: ticket says ${it.qty}, ${it.qty - 1} detected`],
    };
  }

  // 3) Missing item.
  if (order.items.length > 1) {
    const last = order.items[order.items.length - 1];
    return {
      detected: detected.slice(0, -1),
      differences: [`${menuName(last.menu_id)}: on ticket, not detected`],
    };
  }

  // 4) Extra item.
  const extra = getMenuItem("fries")!;
  return {
    detected: [...detected, { menu_id: extra.id, qty: 1, confidence: 0.81 }],
    differences: [`${extra.name}: not on ticket, detected`],
  };
}

/** Does what we "saw" match another open ticket? Then it's probably a swap. */
function findSwap(orders: Order[], selfId: number, detected: DetectedItem[]): number | null {
  for (const other of orders) {
    if (other.id === selfId) continue;
    if (other.status !== "pending" && other.status !== "flagged") continue;
    if (matches(other.items, detected)) return other.id;
  }
  return null;
}

function matches(items: OrderItem[], detected: DetectedItem[]): boolean {
  if (items.length !== detected.length) return false;
  const pool = [...detected];
  for (const it of items) {
    const i = pool.findIndex((d) => {
      if (d.menu_id !== it.menu_id || d.qty !== it.qty) return false;
      for (const [k, want] of Object.entries(it.mods ?? {})) {
        const seen = d.mods?.[k] ?? "unknown";
        if (seen !== "unknown" && seen !== obs(want)) return false;
      }
      return true;
    });
    if (i < 0) return false;
    pool.splice(i, 1);
  }
  return true;
}
