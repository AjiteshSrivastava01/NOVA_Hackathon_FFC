import { transcribeAudio, parseOrder } from "@/lib/openrouter";
import { parseRecall } from "@/lib/table";
import { addOrder, getOpenForTable, listOpen } from "@/lib/store";
import { formatSummary } from "@/lib/format";

// Accepts multipart form data with either:
//   audio: WAV file   (spoken)
//   text:  string     (typed fallback)
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    let transcript = String(form.get("text") ?? "").trim();

    const audio = form.get("audio");
    if (!transcript && audio && typeof audio !== "string") {
      if (audio.size === 0) {
        return Response.json({ ok: false, error: "No audio was recorded. Tap the mic and try again." }, { status: 422 });
      }
      const bytes = Buffer.from(await audio.arrayBuffer());
      transcript = await transcribeAudio(bytes.toString("base64"));
    }

    if (!transcript) {
      return Response.json({ ok: false, error: "I didn't catch anything. Tap the mic and speak clearly." }, { status: 422 });
    }

    // "Table 12" -> look up (plain code, no AI)
    const recallTable = parseRecall(transcript);
    if (recallTable !== null) {
      const found = getOpenForTable(recallTable);
      if (found.length === 0) {
        return Response.json({
          ok: true, action: "not_found", transcript, table: recallTable,
          message: `No open order for table ${recallTable}.`, orders: listOpen(),
        });
      }
      return Response.json({
        ok: true, action: "recalled", transcript, table: recallTable,
        summary: formatSummary(found.flatMap((o) => o.items), recallTable),
        orders: listOpen(),
      });
    }

    // Otherwise it's a new order -> let the AI structure it
    const parsed = await parseOrder(transcript);
    if (parsed.table === null) {
      return Response.json({ ok: false, transcript, error: "I didn't hear a table number. Say it like “Table 12, burger and fries”." }, { status: 422 });
    }
    if (parsed.items.length === 0) {
      return Response.json({ ok: false, transcript, error: `I didn't hear any food or drinks for table ${parsed.table}.` }, { status: 422 });
    }

    const order = addOrder(parsed.table, parsed.items, transcript);
    return Response.json({
      ok: true, action: "created", transcript, table: order.table,
      summary: formatSummary(order.items, order.table),
      orders: listOpen(),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Something went wrong.";
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
