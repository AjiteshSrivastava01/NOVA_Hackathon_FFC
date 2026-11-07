"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getInspectingIds, getInspections, getOrders, subscribe } from "./api";
import type { Inspection, Order } from "./types";

const POLL_MS = 1500;

export type OrdersSnapshot = {
  orders: Order[] | null;
  /** Latest-first inspection history, fetched for flagged orders only. */
  inspections: Record<number, Inspection[]>;
  /** Orders with a photo check in flight (display-only VERIFYING). */
  inspecting: Set<number>;
  error: string | null;
  refresh: () => Promise<void>;
};

/** Read-only view of order state, polled every 1.5s plus instant mock change events. */
export function useOrders(): OrdersSnapshot {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [inspections, setInspections] = useState<Record<number, Inspection[]>>({});
  const [inspecting, setInspectingState] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const again = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (inFlight.current) {
      again.current = true; // a change arrived mid-fetch; re-run when done
      return;
    }
    inFlight.current = true;
    try {
      const [next, busyIds] = await Promise.all([getOrders(), getInspectingIds()]);
      const pairs = await Promise.all(
        next.filter((o) => o.status === "flagged").map(async (o) => [o.id, await getInspections(o.id)] as const),
      );
      setOrders(next);
      setInspectingState(new Set(busyIds));
      setInspections(Object.fromEntries(pairs));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      inFlight.current = false;
    }
    if (again.current) {
      again.current = false;
      await refreshRef.current();
    }
  }, []);
  const refreshRef = useRef(refresh);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount
    refresh();
    const t = setInterval(refresh, POLL_MS);
    const unsub = subscribe(refresh);
    return () => {
      clearInterval(t);
      unsub();
    };
  }, [refresh]);

  return { orders, inspections, inspecting, error, refresh };
}
