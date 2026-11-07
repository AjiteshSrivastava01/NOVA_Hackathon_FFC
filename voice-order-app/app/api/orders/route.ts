import { listOpen, serveOrder } from "@/lib/store";

// POST-only on purpose: POST handlers are never statically prerendered,
// so the list is always fresh.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { action?: string; id?: string };
  if (body.action === "serve" && body.id) await serveOrder(body.id);
  return Response.json({ orders: await listOpen() });
}
