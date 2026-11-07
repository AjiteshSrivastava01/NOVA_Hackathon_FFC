"use client";

// Passive departures-style display board for the projector.
// Read-only: no buttons, no click handlers. State changes come from lib/actions.ts.

import { useEffect, useMemo, useRef, useState } from "react";
import { isMock } from "@/lib/api";
import {
  differencesFor,
  displayStatus,
  itemLines,
  shortDifference,
  sinceLabel,
  SORT_RANK,
  type DisplayStatus,
} from "@/lib/board";
import type { Inspection, Order } from "@/lib/types";
import { useOrders } from "@/lib/useOrders";
import { FlapText } from "./FlapText";

const FLASH_MS = 1600; // pickup highlight before flipping to PICKED UP
const FADE_START_MS = 8500;
const HIDE_AFTER_MS = 10000;
const MAX_EVENTS = 12;

type Track = { status: DisplayStatus; changedAt: number };
type BoardEvent = { key: string; text: string; kind: DisplayStatus | "NEW" };
type Meta = {
  initialized: boolean;
  tracks: Record<number, Track>;
  deliveredAt: Record<number, number>; // only pickups observed while the board is running
  flashUntil: Record<number, number>;
};
const EMPTY_META: Meta = { initialized: false, tracks: {}, deliveredAt: {}, flashUntil: {} };

const STATUS_STYLE: Record<DisplayStatus, { text: string; bar: string; row: string }> = {
  PREPARING: { text: "text-apricot/85", bar: "bg-apricot/30", row: "" },
  VERIFYING: { text: "text-coral status-pulse", bar: "bg-coral", row: "bg-coral/10" },
  "CHECK ORDER": { text: "text-strawberry", bar: "bg-strawberry", row: "bg-strawberry/15" },
  "READY FOR PICKUP": { text: "text-verified-bright", bar: "bg-verified-bright", row: "bg-verified-bright/10" },
  "PICKED UP": { text: "text-apricot/45", bar: "bg-apricot/15", row: "" },
};

const EVENT_COLOR: Record<BoardEvent["kind"], string> = {
  NEW: "text-apricot",
  PREPARING: "text-apricot",
  VERIFYING: "text-coral",
  "CHECK ORDER": "text-strawberry",
  "READY FOR PICKUP": "text-verified-bright",
  "PICKED UP": "text-apricot/70",
};

function eventText(o: Order, ds: DisplayStatus, prev: DisplayStatus | undefined, latest?: Inspection): string | null {
  if (prev === undefined && ds === "PREPARING") return `#${o.id} order received`;
  switch (ds) {
    case "VERIFYING":
      return `#${o.id} verifying meal photo`;
    case "CHECK ORDER": {
      const d = differencesFor(o, latest)[0];
      const swap = latest?.possible_swap_order_id;
      return `#${o.id} flagged: ${d ? shortDifference(d) : "check order"}${swap ? ` · possible swap with #${swap}` : ""}`;
    }
    case "READY FOR PICKUP":
      return `#${o.id} ready for pickup`;
    case "PICKED UP":
      return `#${o.id} picked up`;
    case "PREPARING":
      return prev === "VERIFYING" ? `#${o.id} photo unclear, retake` : null;
  }
}

export default function Board() {
  const { orders, inspections, inspecting, error } = useOrders();
  const metaRef = useRef<Meta>(EMPTY_META);
  const [meta, setMeta] = useState<Meta>(EMPTY_META);
  const [events, setEvents] = useState<BoardEvent[]>([]);
  const [now, setNow] = useState(0);
  const [mock, setMock] = useState(false);

  // Clock tick (also drives "time since", flash end, and fade-out).
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read browser-only setting after mount
    setMock(isMock());
    const t = setInterval(tick, 500);
    return () => clearInterval(t);
  }, []);

  // Diff each snapshot against the previous one → status timestamps + ticker events.
  useEffect(() => {
    if (!orders) return;
    const t = Date.now();
    const prev = metaRef.current;
    const first = !prev.initialized;
    const next: Meta = {
      initialized: true,
      tracks: {},
      deliveredAt: { ...prev.deliveredAt },
      flashUntil: { ...prev.flashUntil },
    };
    const fresh: BoardEvent[] = [];

    for (const o of orders) {
      const ds = displayStatus(o, inspecting.has(o.id));
      const old = prev.tracks[o.id];
      if (old && old.status === ds) {
        next.tracks[o.id] = old;
        continue;
      }
      next.tracks[o.id] = { status: ds, changedAt: !old && first ? Date.parse(o.created_at) : t };
      if (first) continue;
      if (ds === "PICKED UP") {
        next.deliveredAt[o.id] = t;
        if (old?.status === "READY FOR PICKUP") next.flashUntil[o.id] = t + FLASH_MS;
      }
      const text = eventText(o, ds, old?.status, inspections[o.id]?.[0]);
      if (text) fresh.push({ key: `${o.id}-${ds}-${t}`, text, kind: !old && ds === "PREPARING" ? "NEW" : ds });
    }

    metaRef.current = next;
    setMeta(next);
    if (first) setEvents([{ key: "online", text: "Board online", kind: "PREPARING" }]);
    else if (fresh.length) setEvents((ev) => [...fresh.reverse(), ...ev].slice(0, MAX_EVENTS));
  }, [orders, inspecting, inspections]);

  const rows = useMemo(() => {
    if (!orders || !now) return [];
    return orders
      .map((o) => {
        const track = meta.tracks[o.id] ?? { status: displayStatus(o, inspecting.has(o.id)), changedAt: now };
        const flashing = (meta.flashUntil[o.id] ?? 0) > now;
        const status: DisplayStatus = flashing ? "READY FOR PICKUP" : track.status;
        const pickedAt = meta.deliveredAt[o.id];
        const hidden =
          o.status === "delivered" && !flashing && (pickedAt === undefined || now - pickedAt > HIDE_AFTER_MS);
        const fading = o.status === "delivered" && pickedAt !== undefined && now - pickedAt > FADE_START_MS;
        return { order: o, status, changedAt: track.changedAt, flashing, hidden, fading };
      })
      .filter((r) => !r.hidden)
      .sort(
        (a, b) =>
          SORT_RANK[a.status] - SORT_RANK[b.status] ||
          (a.status === "PICKED UP" ? b.changedAt - a.changedAt : a.order.id - b.order.id),
      );
  }, [orders, inspecting, meta, now]);

  const clock = now
    ? new Date(now).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : "";

  return (
    <div className="flex h-screen cursor-none flex-col overflow-hidden bg-graphite font-mono text-apricot select-none">
      <header className="flex items-center justify-between bg-graphite-deep px-[2vw] py-[1.4vh]">
        <div className="flex items-baseline gap-[1.2vw]">
          <h1 className="font-sans text-[2.2vw] font-black tracking-tight">FRONT HOUSE</h1>
          <span className="text-[1.3vw] tracking-[0.3em] text-apricot/60">ORDER STATUS</span>
          {mock && <span className="text-[0.8vw] tracking-widest text-coral/70">MOCK</span>}
        </div>
        <div className="flex items-center gap-[1.5vw]">
          {error && <span className="text-[1vw] text-coral">⚠ OFFLINE · RETRYING</span>}
          <span className="text-[2vw] font-bold tabular-nums">{clock}</span>
        </div>
      </header>

      <div className="grid grid-cols-[13vw_1fr_31vw_7vw] gap-[1.5vw] border-b-2 border-apricot/20 px-[2vw] py-[1vh] text-[1vw] font-bold tracking-[0.3em] text-apricot/55">
        <div>ORDER</div>
        <div>ITEMS</div>
        <div>STATUS</div>
        <div className="text-right">TIME</div>
      </div>

      <main className="flex-1 overflow-hidden">
        {orders === null ? (
          <div className="flex h-full items-center justify-center text-[2.5vw] text-apricot/50">
            <FlapText text="CONNECTING" />
          </div>
        ) : rows.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[2.5vw] text-apricot/50">
            <FlapText text="NO ACTIVE ORDERS" />
          </div>
        ) : (
          rows.map(({ order, status, changedAt, flashing, fading }) => {
            const st = STATUS_STYLE[status];
            const diffs = status === "CHECK ORDER" ? differencesFor(order, inspections[order.id]?.[0]) : [];
            const swap = status === "CHECK ORDER" ? inspections[order.id]?.[0]?.possible_swap_order_id : null;
            return (
              <div
                key={order.id}
                className={`relative border-b border-apricot/10 transition-colors duration-700 ${st.row} ${
                  flashing ? "row-flash" : ""
                } ${fading ? "row-fade" : ""}`}
              >
                <span className={`absolute inset-y-0 left-0 w-[0.5vw] ${st.bar}`} />
                <div className="grid min-h-[9vh] grid-cols-[13vw_1fr_31vw_7vw] items-center gap-[1.5vw] px-[2vw] py-[1.2vh]">
                  <div>
                    <div className="text-[3.8vw] leading-none font-black tabular-nums">#{order.id}</div>
                    {order.customer_name && (
                      <div className="mt-[0.5vh] truncate text-[1.1vw] font-semibold tracking-wider text-apricot/60 uppercase">
                        {order.customer_name}
                      </div>
                    )}
                  </div>
                  <div className="space-y-[0.3vh] text-[1.45vw] leading-tight font-semibold text-apricot/90">
                    {itemLines(order).map((l, i) => (
                      <div key={i}>{l}</div>
                    ))}
                  </div>
                  <div className={`text-[1.85vw] font-bold ${st.text}`}>
                    <FlapText text={status} />
                  </div>
                  <div className="text-right text-[1.6vw] text-apricot/70 tabular-nums">
                    {sinceLabel(now - changedAt)}
                  </div>
                </div>
                {(diffs.length > 0 || swap) && (
                  <div className="-mt-[0.6vh] grid grid-cols-[13vw_1fr] gap-[1.5vw] px-[2vw] pb-[1.4vh]">
                    <div />
                    <div className="flex flex-wrap items-center gap-x-[1.5vw] gap-y-[0.5vh] text-[1.35vw] font-bold">
                      {diffs.map((d) => (
                        <span key={d} className="text-strawberry">
                          ✗ {d.toUpperCase()}
                        </span>
                      ))}
                      {swap && (
                        <span className="rounded-[0.3vw] bg-coral px-[0.6vw] py-[0.2vh] text-graphite">
                          POSSIBLE SWAP WITH #{swap}
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </main>

      <footer className="flex items-stretch overflow-hidden border-t-2 border-apricot/20 bg-graphite-deep text-[1.35vw]">
        <div className="flex items-center bg-coral px-[1.2vw] font-black tracking-widest text-graphite">LIVE</div>
        <div className="flex min-w-0 flex-1 items-center gap-[2.5vw] overflow-hidden px-[1.5vw] py-[1.2vh] whitespace-nowrap">
          {events.map((e, i) => (
            <span
              key={e.key}
              className={`${i === 0 ? "pop-in font-bold" : ""} ${EVENT_COLOR[e.kind]}`}
              style={{ opacity: Math.max(0.3, 1 - i * 0.18) }}
            >
              {e.text.toUpperCase()}
            </span>
          ))}
        </div>
      </footer>
    </div>
  );
}
