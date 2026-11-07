"use client";

import { useEffect, useRef, useState } from "react";
import { Recorder } from "@/lib/audio";
import { formatOrderLine } from "@/lib/format";
import type { Order } from "@/lib/types";

type VoiceResponse = {
  ok: boolean;
  action?: "created" | "recalled" | "not_found";
  transcript?: string;
  summary?: string;
  message?: string;
  error?: string;
  orders?: Order[];
};

type Status = "idle" | "recording" | "processing";

export default function Home() {
  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<VoiceResponse | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [typed, setTyped] = useState("");
  const recorder = useRef<Recorder | null>(null);

  useEffect(() => {
    fetch("/api/orders", { method: "POST", body: JSON.stringify({ action: "list" }) })
      .then((r) => r.json())
      .then((d: { orders: Order[] }) => setOrders(d.orders))
      .catch(() => {});
  }, []);

  async function send(form: FormData) {
    setStatus("processing");
    try {
      const res = await fetch("/api/voice", { method: "POST", body: form });
      const data = (await res.json()) as VoiceResponse;
      setResult(data);
      if (data.orders) setOrders(data.orders);
    } catch {
      setResult({ ok: false, error: "Couldn't reach the server. Check your connection and try again." });
    } finally {
      setStatus("idle");
    }
  }

  async function toggleMic() {
    if (status === "processing") return;
    if (status === "idle") {
      try {
        recorder.current = new Recorder();
        await recorder.current.start();
        setResult(null);
        setStatus("recording");
      } catch {
        setResult({ ok: false, error: "Microphone blocked. Allow mic access in your browser (the page must be on https or localhost)." });
      }
      return;
    }
    setStatus("processing");
    try {
      const wav = await recorder.current!.stop();
      const form = new FormData();
      form.append("audio", wav, "speech.wav");
      await send(form);
    } catch {
      setResult({ ok: false, error: "Couldn't process the recording. Try again." });
      setStatus("idle");
    }
  }

  async function sendTyped(e: React.SyntheticEvent) {
    e.preventDefault();
    if (!typed.trim() || status !== "idle") return;
    const form = new FormData();
    form.append("text", typed);
    setTyped("");
    await send(form);
  }

  async function serve(id: string) {
    const res = await fetch("/api/orders", { method: "POST", body: JSON.stringify({ action: "serve", id }) });
    const d = (await res.json()) as { orders: Order[] };
    setOrders(d.orders);
  }

  const label =
    status === "recording" ? "Listening… tap to finish" : status === "processing" ? "Working on it…" : "Tap and speak";

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-8 px-5 py-8">
      <header>
        <h1 className="text-3xl font-bold">Voice orders</h1>
        <p className="mt-1" style={{ color: "var(--muted)" }}>
          Say “Table 12, burger no lettuce, fries”. Later, say “Table 12” to hear it back.
        </p>
      </header>

      <section className="flex flex-col items-center gap-3">
        <button
          onClick={toggleMic}
          disabled={status === "processing"}
          aria-pressed={status === "recording"}
          className="h-36 w-36 rounded-full text-lg font-bold text-white transition-transform active:scale-95 disabled:opacity-60 focus-visible:outline-4 focus-visible:outline-offset-4"
          style={{
            background: status === "recording" ? "var(--alert)" : "var(--signal)",
            outlineColor: "var(--ink)",
          }}
        >
          {status === "recording" ? "Stop" : status === "processing" ? "…" : "Mic"}
        </button>
        <p aria-live="polite" className="font-medium">{label}</p>
      </section>

      {result && (
        <section
          aria-live="polite"
          className="rounded-md border-2 p-5"
          style={{ borderColor: result.ok ? "var(--signal)" : "var(--alert)", background: "#fff" }}
        >
          {result.ok && result.summary && (
            <>
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                {result.action === "created" ? "Order saved" : "Order for the table"}
              </p>
              <p className="mt-1 text-2xl font-bold">{result.summary}</p>
            </>
          )}
          {result.ok && !result.summary && <p className="text-lg font-bold">{result.message}</p>}
          {!result.ok && <p className="text-lg font-bold" style={{ color: "var(--alert)" }}>{result.error}</p>}
          {result.transcript && (
            <p className="mt-3 text-sm" style={{ color: "var(--muted)" }}>Heard: “{result.transcript}”</p>
          )}
        </section>
      )}

      <section>
        <h2 className="mb-2 text-xl font-bold">Open orders</h2>
        {orders.length === 0 ? (
          <p style={{ color: "var(--muted)" }}>Nothing waiting. Orders you take will show up here.</p>
        ) : (
          <ul className="divide-y" style={{ borderColor: "var(--line)" }}>
            {orders.map((o) => (
              <li key={o.id} className="flex items-center justify-between gap-4 py-3" style={{ borderColor: "var(--line)" }}>
                <span className="text-lg">{formatOrderLine(o)}</span>
                <button
                  onClick={() => serve(o.id)}
                  className="shrink-0 rounded border px-3 py-1 font-medium focus-visible:outline-2"
                  style={{ borderColor: "var(--ink)" }}
                >
                  Mark served
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <form onSubmit={sendTyped} className="mt-auto flex gap-2">
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="Or type: Table 4, two Cokes"
          aria-label="Type an order or a table number"
          className="min-w-0 flex-1 rounded border px-3 py-2"
          style={{ borderColor: "var(--line)", background: "#fff" }}
        />
        <button type="submit" className="rounded px-4 py-2 font-medium text-white" style={{ background: "var(--ink)" }}>
          Send
        </button>
      </form>
    </main>
  );
}
