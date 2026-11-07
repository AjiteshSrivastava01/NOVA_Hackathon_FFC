// Types for the display board + camera page.
//
// The source of truth is the team backend in functions/src/app.js. Its raw
// shapes are the `Backend*` types at the bottom. lib/api.ts maps them into the
// simpler view model above, which is what the UI components use.

// ---------------- UI view model ----------------

/** pending = waiting / being made; flagged = backend "needs_attention";
 *  in_cubby = ready for pickup; delivered = backend "picked_up". */
export type OrderStatus = "pending" | "flagged" | "in_cubby" | "delivered";

/** mods: true = "add", false = "no" (backend modifiers). Unlisted = menu default. */
export type OrderItem = {
  menu_id: string;
  qty: number;
  mods?: Record<string, boolean>;
};

export type Order = {
  id: number;
  status: OrderStatus;
  items: OrderItem[];
  cubby: number | null; // kept for the contract; never shown in the UI
  flag_reason: string | null;
  created_at: string;
  customer_name?: string;
};

export type Observation = "present" | "absent" | "unknown";

export type DetectedItem = {
  menu_id: string;
  qty: number;
  mods?: Record<string, Observation>;
  confidence: number;
};

/** pass = backend "pass"; flag = backend "fail"; retake = backend "needs_review". */
export type Verdict = "pass" | "flag" | "retake";

export type Inspection = {
  id: string;
  order_id: number;
  created_at: string;
  verdict: Verdict;
  detected: { items: DetectedItem[]; notes: string };
  differences: string[]; // backend `reasons`
  possible_swap_order_id: number | null; // backend `swap_suggestion.order_id`
};

export type CreateOrderInput = { items: OrderItem[]; customer_name?: string };

// ---------------- Backend shapes (functions/src/app.js) ----------------

export type BackendStatus = "pending" | "verified" | "needs_attention" | "in_cubby" | "picked_up";

export type BackendOrderLine = {
  line_id?: number;
  menu_id: string;
  qty: number;
  modifiers: Record<string, "add" | "no">;
};

export type BackendInspection = {
  id: number;
  order_id: number;
  photo_path: string | null;
  source: string;
  observations: { items?: { menu_id: string; components?: Record<string, Observation> }[]; notes?: string } | null;
  verdict: "pass" | "fail" | "needs_review";
  reasons: string[];
  swap_suggestion: { order_id: number; verdict: string; message: string } | null;
  reassigned_from: number | null;
  created_at: string;
};

export type BackendOrder = {
  id: number;
  customer_name: string;
  items: BackendOrderLine[];
  source: string;
  status: BackendStatus;
  cubby_id: number | null;
  created_at: string;
  picked_up_at: string | null;
  inspections?: BackendInspection[];
  latest_inspection?: BackendInspection | null;
};

export const CUBBY_COUNT = 8;
