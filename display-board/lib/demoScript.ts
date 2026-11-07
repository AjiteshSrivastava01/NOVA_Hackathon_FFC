// Scripted backup demo (also what we record for the backup video).
// Runs against the mock so the vision verdicts are deterministic.

import { confirmSwap, pickupOrder, submitMealPhoto, submitVoiceOrder } from "./actions";
import { stripDataUrl, toJpegDataUrl } from "./image";
import { getForceNext, resetMock, setForceNext } from "./mockApi";
import type { OrderItem } from "./types";

export const GAP_MS = 3500;

export const BURGER_WITH_LETTUCE: OrderItem[] = [{ menu_id: "burger", qty: 1 }]; // lettuce is on by default
export const BURGER_NO_LETTUCE: OrderItem[] = [{ menu_id: "burger", qty: 1, mods: { lettuce: false } }];

async function photo(src: string) {
  return stripDataUrl(await toJpegDataUrl(src));
}

export async function runDemoScript(log: (msg: string) => void, isCancelled: () => boolean): Promise<void> {
  const gap = async () => {
    await new Promise((r) => setTimeout(r, GAP_MS));
    if (isCancelled()) throw new Error("Stopped");
  };
  const prevForce = getForceNext();
  try {
    resetMock();
    log("Reset mock data (next order will be #21)");
    await gap();

    const a = await submitVoiceOrder({ items: BURGER_WITH_LETTUCE });
    log(`Voice order #${a.id}: burger with lettuce`);
    await gap();

    const b = await submitVoiceOrder({ items: BURGER_NO_LETTUCE });
    log(`Voice order #${b.id}: burger, NO lettuce`);
    await gap();

    setForceNext("flag");
    log(`Photo for #${b.id} (it's actually #${a.id}'s burger)…`);
    const flagged = await submitMealPhoto(b.id, await photo("/demo/burger-lettuce.svg"));
    log(
      `#${b.id} → ${flagged.verdict.toUpperCase()}: ${flagged.differences.join("; ")}` +
        (flagged.possible_swap_order_id ? ` · possible swap with #${flagged.possible_swap_order_id}` : ""),
    );
    await gap();

    const actual = flagged.possible_swap_order_id ?? a.id;
    await confirmSwap(b.id, actual);
    log(`Staff confirmed swap: #${actual} ready for pickup`);
    await gap();

    setForceNext("pass");
    log(`Retake photo for #${b.id} (correct burger)…`);
    const passed = await submitMealPhoto(b.id, await photo("/demo/burger-no-lettuce.svg"));
    log(`#${b.id} → ${passed.verdict.toUpperCase()}, ready for pickup`);
    await gap();

    await pickupOrder(a.id);
    log(`#${a.id} picked up`);
    await gap();

    await pickupOrder(b.id);
    log(`#${b.id} picked up. Demo complete ✓`);
  } finally {
    setForceNext(prevForce);
  }
}
