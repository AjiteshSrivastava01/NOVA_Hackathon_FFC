"use client";

// Testing controls for the team. NEVER shown on the projector.
// Changes state only through lib/actions.ts (+ mock-only helpers).

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { confirmSwap, pickupOrder, submitMealPhoto, submitVoiceOrder } from "@/lib/actions";
import { isMock, isMockFromEnv, setMockOverride } from "@/lib/api";
import { displayStatus } from "@/lib/board";
import { demoPhotoFor } from "@/lib/demoPhotos";
import { BURGER_NO_LETTUCE, BURGER_WITH_LETTUCE, runDemoScript } from "@/lib/demoScript";
import { stripDataUrl, toJpegDataUrl } from "@/lib/image";
import { getForceNext, resetMock, setForceNext, type ForceMode } from "@/lib/mockApi";
import type { Order, OrderItem } from "@/lib/types";
import { useOrders } from "@/lib/useOrders";
import { OrderItems } from "./OrderItems";

const PRESETS: { label: string; items: OrderItem[] }[] = [
  { label: "🍔 Burger + lettuce", items: BURGER_WITH_LETTUCE },
  { label: "🍔 Burger, NO lettuce", items: BURGER_NO_LETTUCE },
  {
    label: "🥪 Chicken sandwich + salad",
    items: [
      { menu_id: "chicken_sandwich", qty: 1 },
      { menu_id: "salad", qty: 1 },
    ],
  },
  { label: "🍟 Fries ×2 + soda", items: [{ menu_id: "fries", qty: 2 }, { menu_id: "soda", qty: 1 }] },
];

const card = "rounded-2xl bg-white p-5 shadow-sm";
const btn = "rounded-lg px-3 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-40";

export default function DevPanel() {
  const { orders, inspections, inspecting } = useOrders();
  const [mounted, setMounted] = useState(false);
  const [mock, setMock] = useState(false);
  const [force, setForce] = useState<ForceMode>("auto");
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [scriptRunning, setScriptRunning] = useState(false);
  const cancelled = useRef(false);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- browser-only state after mount */
    setMounted(true);
    setMock(isMock());
    setForce(getForceNext());
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  const addLog = (msg: string) =>
    setLog((l) => [`${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}  ${msg}`, ...l].slice(0, 40));

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    try {
      addLog(await fn());
    } catch (e) {
      addLog(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const chooseForce = (m: ForceMode) => {
    setForceNext(m);
    setForce(m);
  };

  const toggleMock = (on: boolean) => {
    setMockOverride(on);
    setMock(isMock());
    addLog(on ? "This browser now uses MOCK data" : "This browser now uses the REAL backend");
  };

  const startScript = async () => {
    if (!isMock()) {
      if (!window.confirm("The demo script runs on mock data. Switch this browser to mock mode?")) return;
      toggleMock(true);
    }
    cancelled.current = false;
    setScriptRunning(true);
    addLog("▶ Demo script started");
    try {
      await runDemoScript(addLog, () => cancelled.current);
    } catch (e) {
      addLog(`■ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setScriptRunning(false);
      setForce(getForceNext());
    }
  };

  const photoFor = async (o: Order) => {
    const ins = await submitMealPhoto(o.id, stripDataUrl(await toJpegDataUrl(demoPhotoFor(o))));
    return `#${o.id} photo → ${ins.verdict.toUpperCase()}${ins.differences.length ? `: ${ins.differences.join("; ")}` : ""}${
      ins.possible_swap_order_id ? ` · possible swap with #${ins.possible_swap_order_id}` : ""
    }`;
  };

  const open = (orders ?? []).filter((o) => o.status !== "delivered");
  const done = (orders ?? []).filter((o) => o.status === "delivered").slice(-5).reverse();

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 p-4 md:p-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-black">Dev controls</h1>
          <p className="text-graphite-soft">For the team only. Never put this page on the projector.</p>
        </div>
        <nav className="flex gap-2">
          <Link href="/" target="_blank" className={`${btn} bg-graphite text-apricot`}>
            Open board ↗
          </Link>
          <Link href="/camera" target="_blank" className={`${btn} bg-navy text-white`}>
            Open camera ↗
          </Link>
        </nav>
      </header>

      <div className="grid gap-5 md:grid-cols-2">
        <section className={card}>
          <h2 className="mb-1 text-lg font-bold">Run demo script</h2>
          <p className="mb-3 text-sm text-graphite-soft">
            Resets mock data, then: #21 burger w/ lettuce → #22 no lettuce → #22 photo flagged, swap with #21 → confirm
            swap → #22 retake passes → pick up #21 → pick up #22. 3.5s between steps.
          </p>
          <div className="flex gap-2">
            <button
              disabled={scriptRunning || busy}
              onClick={startScript}
              className={`${btn} bg-navy px-5 py-3 text-base text-white`}
            >
              ▶ Run demo script
            </button>
            {scriptRunning && (
              <button onClick={() => (cancelled.current = true)} className={`${btn} bg-strawberry text-white`}>
                Stop
              </button>
            )}
          </div>
        </section>

        <section className={card}>
          <h2 className="mb-2 text-lg font-bold">Mode</h2>
          {mounted && (
            <>
              <p className="mb-3">
                This browser is using{" "}
                <b className={mock ? "text-coral" : "text-verified"}>{mock ? "MOCK data" : "the REAL backend"}</b>
                {isMockFromEnv() && " (NEXT_PUBLIC_USE_MOCK=true)"}.
              </p>
              {!isMockFromEnv() && (
                <button onClick={() => toggleMock(!mock)} className={`${btn} bg-graphite text-apricot`}>
                  {mock ? "Switch to real backend" : "Force mock in this browser"}
                </button>
              )}
              {mock && (
                <div className="mt-4">
                  <h3 className="mb-1 text-sm font-bold">Mock photo checks will…</h3>
                  <div className="inline-grid grid-cols-4 gap-1 rounded-lg bg-apricot p-1">
                    {(["auto", "pass", "flag", "retake"] as ForceMode[]).map((m) => (
                      <button
                        key={m}
                        onClick={() => chooseForce(m)}
                        className={`rounded-md px-3 py-1 text-sm font-semibold capitalize ${
                          force === m ? "bg-graphite text-apricot" : "hover:bg-white/60"
                        }`}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                  <div>
                    <button
                      onClick={() => {
                        if (window.confirm("Reset all mock orders back to the seed data?")) {
                          resetMock();
                          addLog("Mock data reset");
                        }
                      }}
                      className="mt-3 text-sm text-graphite-soft underline"
                    >
                      Reset mock data
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      <section className={card}>
        <h2 className="mb-3 text-lg font-bold">submitVoiceOrder</h2>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              disabled={busy || scriptRunning}
              onClick={() =>
                run(async () => {
                  const o = await submitVoiceOrder({ items: p.items });
                  return `Voice order #${o.id} created`;
                })
              }
              className={`${btn} bg-apricot hover:bg-coral/40`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </section>

      <div className="grid gap-5 md:grid-cols-[1fr_22rem]">
        <section className={card}>
          <h2 className="mb-3 text-lg font-bold">Orders</h2>
          {orders === null ? (
            <p className="text-graphite-soft">Loading…</p>
          ) : (
            <table className="w-full text-left">
              <thead className="text-xs tracking-wider text-graphite-soft uppercase">
                <tr>
                  <th className="py-1">#</th>
                  <th>Items</th>
                  <th>Board shows</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {[...open, ...done].map((o) => {
                  const swap = o.status === "flagged" ? inspections[o.id]?.[0]?.possible_swap_order_id : null;
                  const canPhoto = o.status === "pending" || o.status === "flagged";
                  return (
                    <tr key={o.id} className="border-t border-apricot align-top">
                      <td className="py-2 pr-3 text-xl font-black">#{o.id}</td>
                      <td className="py-2 pr-3">
                        <OrderItems items={o.items} size="sm" />
                      </td>
                      <td className="py-2 pr-3 text-sm font-semibold">{displayStatus(o, inspecting.has(o.id))}</td>
                      <td className="space-x-1 space-y-1 py-2 text-right whitespace-nowrap">
                        {canPhoto && (
                          <button
                            disabled={busy || scriptRunning}
                            onClick={() => run(() => photoFor(o))}
                            className={`${btn} bg-navy text-white`}
                          >
                            submitMealPhoto
                          </button>
                        )}
                        {swap && (
                          <button
                            disabled={busy || scriptRunning}
                            onClick={() =>
                              run(async () => {
                                await confirmSwap(o.id, swap);
                                return `confirmSwap(${o.id}, ${swap}): #${swap} ready for pickup`;
                              })
                            }
                            className={`${btn} bg-coral`}
                          >
                            confirmSwap → #{swap}
                          </button>
                        )}
                        {o.status === "in_cubby" && (
                          <button
                            disabled={busy || scriptRunning}
                            onClick={() =>
                              run(async () => {
                                await pickupOrder(o.id);
                                return `#${o.id} picked up`;
                              })
                            }
                            className={`${btn} bg-verified text-white`}
                          >
                            pickupOrder
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        <section className={`${card} max-h-[32rem] overflow-auto`}>
          <h2 className="mb-2 text-lg font-bold">Log</h2>
          {log.length === 0 ? (
            <p className="text-sm text-graphite-soft">Nothing yet.</p>
          ) : (
            <ul className="space-y-1 font-mono text-xs">
              {log.map((l, i) => (
                <li key={i} className={l.includes("ERROR") ? "text-strawberry" : ""}>
                  {l}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
