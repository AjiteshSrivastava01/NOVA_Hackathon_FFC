"use client";

// Staff phone flow. The only interactive screen P4 owns.
// 1) pick the intended ticket  2) photograph the meal  3) result (+ swap confirmation)

import { useEffect, useState } from "react";
import { confirmSwap, submitMealPhoto } from "@/lib/actions";
import { getInspections } from "@/lib/api";
import { DEMO_PHOTOS } from "@/lib/demoPhotos";
import { fileToJpegDataUrl, stripDataUrl, toJpegDataUrl } from "@/lib/image";
import type { Inspection } from "@/lib/types";
import { useOrders } from "@/lib/useOrders";
import { OrderItems } from "./OrderItems";

type Step = "pick" | "photo" | "checking" | "result";
type SwapState = { kind: "idle" } | { kind: "busy" } | { kind: "done"; id: number } | { kind: "declined" } | { kind: "error"; msg: string };

const bigBtn =
  "flex w-full items-center justify-center gap-2 rounded-2xl px-5 py-5 text-xl font-bold transition active:scale-[0.98] disabled:opacity-40";

function timeOf(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

export default function CameraFlow() {
  const { orders } = useOrders();
  const [step, setStep] = useState<Step>("pick");
  const [orderId, setOrderId] = useState<number | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [showDemo, setShowDemo] = useState(false);
  const [result, setResult] = useState<Inspection | null>(null);
  const [history, setHistory] = useState<Inspection[]>([]);
  const [swap, setSwap] = useState<SwapState>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);

  const order = orders?.find((o) => o.id === orderId) ?? null;
  const openOrders = (orders ?? [])
    .filter((o) => o.status === "pending" || o.status === "flagged")
    .sort((a, b) => a.id - b.id);

  useEffect(() => {
    if (orderId === null) return;
    let live = true;
    getInspections(orderId).then((h) => live && setHistory(h));
    return () => {
      live = false;
    };
  }, [orderId, result]);

  const pick = (id: number) => {
    setOrderId(id);
    setPreview(null);
    setResult(null);
    setHistory([]);
    setError(null);
    setShowDemo(false);
    setStep("photo");
  };

  const reset = () => {
    setOrderId(null);
    setPreview(null);
    setResult(null);
    setSwap({ kind: "idle" });
    setError(null);
    setStep("pick");
  };

  const retake = () => {
    setPreview(null);
    setResult(null);
    setSwap({ kind: "idle" });
    setError(null);
    setStep("photo");
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      setPreview(await fileToJpegDataUrl(file));
    } catch {
      setError("Couldn't read that photo. Try again or use a demo photo.");
    }
  };

  const onDemo = async (src: string) => {
    setError(null);
    setPreview(await toJpegDataUrl(src));
    setShowDemo(false);
  };

  const submit = async () => {
    if (!preview || orderId === null) return;
    setStep("checking");
    setError(null);
    setSwap({ kind: "idle" });
    try {
      const ins = await submitMealPhoto(orderId, stripDataUrl(preview));
      setResult(ins);
      setStep("result");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("photo");
    }
  };

  const doSwap = async (actualId: number) => {
    if (orderId === null) return;
    setSwap({ kind: "busy" });
    try {
      await confirmSwap(orderId, actualId);
      setSwap({ kind: "done", id: actualId });
    } catch (e) {
      setSwap({ kind: "error", msg: e instanceof Error ? e.message : String(e) });
    }
  };

  // ---------- Step 1: pick ticket ----------
  if (step === "pick" || orderId === null) {
    return (
      <Shell title="Which ticket is this meal for?" subtitle="Step 1 of 3 · pick the ticket first">
        {orders === null ? (
          <p className="py-10 text-center text-lg text-graphite-soft">Loading tickets…</p>
        ) : openOrders.length === 0 ? (
          <p className="py-10 text-center text-lg text-graphite-soft">No open tickets right now.</p>
        ) : (
          <ul className="space-y-3">
            {openOrders.map((o) => (
              <li key={o.id}>
                <button
                  onClick={() => pick(o.id)}
                  className={`w-full rounded-2xl border-4 bg-white p-4 text-left shadow-sm active:scale-[0.99] ${
                    o.status === "flagged" ? "border-strawberry" : "border-transparent"
                  }`}
                >
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-4xl font-black">#{o.id}</span>
                    {o.status === "flagged" && (
                      <span className="rounded-full bg-strawberry px-3 py-1 text-sm font-bold text-white">
                        CHECK ORDER
                      </span>
                    )}
                  </div>
                  <OrderItems items={o.items} size="lg" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Shell>
    );
  }

  const ticket = (
    <div className="rounded-2xl bg-white p-4 shadow-sm">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-3xl font-black">Ticket #{orderId}</span>
        <button onClick={reset} className="rounded-lg px-3 py-2 text-base font-semibold text-navy underline">
          Change
        </button>
      </div>
      {order ? <OrderItems items={order.items} size="lg" /> : <p className="text-graphite-soft">Loading…</p>}
    </div>
  );

  // ---------- Step 2: photo ----------
  if (step === "photo" || step === "checking") {
    const checking = step === "checking";
    return (
      <Shell title="Photograph the meal" subtitle="Step 2 of 3">
        {ticket}

        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element -- local data URL preview
          <img src={preview} alt="Meal preview" className="w-full rounded-2xl border-4 border-white shadow" />
        ) : (
          <div className="flex aspect-[4/3] items-center justify-center rounded-2xl border-4 border-dashed border-graphite/25 text-6xl">
            📷
          </div>
        )}

        {error && <p className="rounded-xl bg-strawberry/15 p-3 font-semibold text-[#b0123f]">{error}</p>}

        {checking ? (
          <div className={`${bigBtn} status-pulse bg-coral text-graphite`}>Verifying meal…</div>
        ) : (
          <>
            <label className={`${bigBtn} cursor-pointer ${preview ? "bg-white text-graphite" : "bg-navy text-white"}`}>
              {preview ? "↺ Retake photo" : "📷 Take photo"}
              <input
                type="file"
                accept="image/*"
                capture="environment"
                className="sr-only"
                onChange={(e) => {
                  onFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </label>
            {preview && (
              <button onClick={submit} className={`${bigBtn} bg-navy text-white`}>
                Check meal →
              </button>
            )}
            <button
              onClick={() => setShowDemo((s) => !s)}
              className="w-full py-3 text-base font-semibold text-graphite-soft underline"
            >
              {showDemo ? "Hide demo photos" : "Camera not working? Use demo photo"}
            </button>
            {showDemo && (
              <div className="grid grid-cols-2 gap-3">
                {DEMO_PHOTOS.map((p) => (
                  <button key={p.src} onClick={() => onDemo(p.src)} className="rounded-xl bg-white p-2 text-sm font-semibold shadow-sm">
                    {/* eslint-disable-next-line @next/next/no-img-element -- static demo asset */}
                    <img src={p.src} alt="" className="mb-1 aspect-[4/3] w-full rounded-lg object-cover" />
                    {p.label}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        <History items={history} />
      </Shell>
    );
  }

  // ---------- Step 3: result ----------
  const r = result!;
  const swapId = r.verdict === "flag" ? r.possible_swap_order_id : null;
  return (
    <Shell title="Result" subtitle="Step 3 of 3">
      {r.verdict === "pass" && (
        <div className="pop-in rounded-3xl bg-verified p-8 text-center text-white shadow-lg">
          <div className="text-8xl leading-none">✓</div>
          <div className="mt-3 text-3xl font-black">READY FOR PICKUP</div>
          <div className="mt-1 text-xl font-semibold opacity-90">Order #{orderId} matches its ticket</div>
        </div>
      )}

      {r.verdict === "flag" && (
        <div className="pop-in rounded-3xl bg-strawberry p-6 text-white shadow-lg">
          <div className="text-center text-7xl leading-none">✗</div>
          <div className="mt-2 text-center text-3xl font-black">CHECK ORDER #{orderId}</div>
          <ul className="mt-4 space-y-2 text-lg font-semibold">
            {r.differences.map((d) => (
              <li key={d} className="rounded-xl bg-white/15 p-3">
                {d}
              </li>
            ))}
          </ul>
        </div>
      )}

      {r.verdict === "retake" && (
        <div className="pop-in rounded-3xl bg-coral p-8 text-center text-graphite shadow-lg">
          <div className="text-7xl leading-none">↺</div>
          <div className="mt-3 text-3xl font-black">Please retake</div>
          <div className="mt-1 text-lg font-semibold">{r.detected.notes || "The model wasn't confident."}</div>
        </div>
      )}

      {swapId !== null && (
        <div className="rounded-2xl border-4 border-dashed border-coral bg-white p-5">
          {swap.kind === "done" ? (
            <p className="text-lg font-semibold">
              ✓ Order #{swap.id} is ready for pickup. Order #{orderId} still needs its correct meal.
            </p>
          ) : swap.kind === "declined" ? (
            <p className="text-lg font-semibold text-graphite-soft">Swap dismissed. Order #{orderId} stays flagged.</p>
          ) : (
            <>
              <p className="mb-4 text-2xl font-black">This looks like Order {swapId}. Confirm swap?</p>
              {swap.kind === "error" && <p className="mb-3 font-semibold text-strawberry">{swap.msg}</p>}
              <div className="grid grid-cols-2 gap-3">
                <button
                  disabled={swap.kind === "busy"}
                  onClick={() => doSwap(swapId)}
                  className={`${bigBtn} bg-navy text-white`}
                >
                  {swap.kind === "busy" ? "…" : `Yes, #${swapId}`}
                </button>
                <button
                  disabled={swap.kind === "busy"}
                  onClick={() => setSwap({ kind: "declined" })}
                  className={`${bigBtn} bg-apricot text-graphite`}
                >
                  No
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <div className="grid gap-3">
        {r.verdict !== "pass" && (
          <button onClick={retake} className={`${bigBtn} bg-navy text-white`}>
            ↺ Retake photo
          </button>
        )}
        <button onClick={reset} className={`${bigBtn} ${r.verdict === "pass" ? "bg-navy text-white" : "bg-white text-graphite"}`}>
          Next ticket →
        </button>
      </div>

      <History items={history} />
    </Shell>
  );
}

function Shell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-md space-y-4 px-4 pt-5 pb-10">
      <header>
        <p className="text-sm font-bold tracking-widest text-graphite-soft uppercase">{subtitle}</p>
        <h1 className="text-3xl leading-tight font-black">{title}</h1>
      </header>
      {children}
    </div>
  );
}

const VERDICT_STYLE: Record<Inspection["verdict"], string> = {
  pass: "bg-verified text-white",
  flag: "bg-strawberry text-white",
  retake: "bg-coral text-graphite",
};

function History({ items }: { items: Inspection[] }) {
  if (items.length === 0) return null;
  return (
    <section className="pt-2">
      <h2 className="mb-2 text-sm font-bold tracking-widest text-graphite-soft uppercase">
        Earlier attempts ({items.length})
      </h2>
      <ul className="space-y-2">
        {items.map((i) => (
          <li key={i.id} className="rounded-xl bg-white/70 p-3">
            <div className="flex items-center justify-between">
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold uppercase ${VERDICT_STYLE[i.verdict]}`}>
                {i.verdict}
              </span>
              <span className="text-sm text-graphite-soft">{timeOf(i.created_at)}</span>
            </div>
            {i.differences.length > 0 && (
              <ul className="mt-1 text-sm">
                {i.differences.map((d) => (
                  <li key={d}>✗ {d}</li>
                ))}
              </ul>
            )}
            {i.possible_swap_order_id && (
              <p className="mt-1 text-sm text-graphite-soft">Possible swap with #{i.possible_swap_order_id}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
