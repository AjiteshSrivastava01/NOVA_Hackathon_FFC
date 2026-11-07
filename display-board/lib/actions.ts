// The ONLY place to call when changing order state from the display-board app.
// Every function goes through lib/api.ts, so it works in mock and real mode.
// Each one lists the team-backend routes (functions/src/app.js) it hits in real mode.
//
//   import { submitVoiceOrder, submitMealPhoto, confirmSwap, pickupOrder } from "@/lib/actions";
//
// "Cubby" in the backend (status "in_cubby", assign-cubby route) just means
// READY FOR PICKUP here. This app never shows cubbies.

import * as api from "./api";
import type { Inspection, Order, OrderItem } from "./types";

/**
 * Create a new ticket from a confirmed voice order.
 * Caller: P1, after staff confirm the voice confirmation card.
 * Backend: POST /api/orders { customer_name, items: [{ menu_id, qty, modifiers: { lettuce: "no" } }], source: "voice" }
 * `customer_name` defaults to "Guest" (the backend requires one).
 */
export function submitVoiceOrder(order: { items: OrderItem[]; customer_name?: string }): Promise<Order> {
  return api.createOrder(order);
}

/**
 * Check a meal photo against its ticket.
 * Caller: the /camera page after staff pick a ticket and take a photo.
 * Flow: board shows VERIFYING → inspect → on "pass", automatically marks the
 * order READY FOR PICKUP (no human step). "flag" (backend "fail") leaves it as
 * CHECK ORDER; "retake" (backend "needs_review") asks for another photo.
 * Backend: POST /api/orders/:id/inspect { photo_base64 },
 *          then on pass POST /api/orders/:id/assign-cubby {}
 * @param imageBase64 JPEG as raw base64; a "data:image/jpeg;base64," prefix is stripped if present.
 */
export async function submitMealPhoto(orderId: number, imageBase64: string): Promise<Inspection> {
  const image = imageBase64.startsWith("data:") ? imageBase64.slice(imageBase64.indexOf(",") + 1) : imageBase64;
  await api.setInspecting(orderId, true);
  try {
    const inspection = await api.inspectOrder(orderId, image);
    if (inspection.verdict === "pass") {
      await api.assignCubby(orderId);
    }
    return inspection;
  } finally {
    await api.setInspecting(orderId, false);
  }
}

/**
 * Staff confirm that the meal photographed for `flaggedOrderId` is actually
 * `actualOrderId`'s meal: `actualOrderId` becomes READY FOR PICKUP.
 * `flaggedOrderId` stays flagged until its correct meal is photographed.
 * Caller: the /camera page, only after staff tap "Confirm swap". Never the display board.
 * Backend: POST /api/inspections/:latestInspectionId/reassign { target_order_id: actualOrderId },
 *          then POST /api/orders/:actualOrderId/assign-cubby (override + staff_note if the moved photo wasn't a clean pass)
 */
export function confirmSwap(flaggedOrderId: number, actualOrderId: number): Promise<Order> {
  return api.reassignMeal(flaggedOrderId, actualOrderId);
}

/**
 * Customer picked up their order ("Order 21").
 * Caller: P1's voice pickup screen.
 * Backend: POST /api/orders/:id/pickup
 */
export function pickupOrder(orderId: number): Promise<Order> {
  return api.pickupOrder(orderId);
}
