// FFC Kitchen dashboard — plain JS, no build step.
const $ = (s) => document.querySelector(s);
const state = { menu: {}, orders: [], selectedId: null };

// ---------- api ----------
async function api(path, opts = {}) {
  const init = { ...opts };
  if (opts.json !== undefined) {
    init.method = init.method || "POST";
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(opts.json);
  }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail || data));
  return data;
}

function toast(msg, ok = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (ok ? " ok" : "");
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 3500);
}

async function run(fn) {
  try { return await fn(); } catch (e) { toast(e.message); }
}

function speak(text) {
  if (!$("#tts-on").checked || !("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1;
  speechSynthesis.speak(u);
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const itemName = (id) => state.menu[id]?.name || id;
const compName = (mid, cid) => state.menu[mid]?.components?.[cid]?.name || cid;
const STATUS = { pending: "Awaiting inspection", verified: "Verified", needs_attention: "Needs attention", in_cubby: "In cubby", picked_up: "Picked up" };
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function lineHtml(l) {
  const mods = Object.entries(l.modifiers || {})
    .map(([c, a]) => `<span class="mod ${a}">${a === "no" ? "no" : "+"} ${esc(compName(l.menu_id, c))}</span>`).join("");
  return `<span class="qty">${l.qty}×</span>${esc(itemName(l.menu_id))}${mods}`;
}
const orderSummary = (o) => o.items.map((l) => `${l.qty}× ${itemName(l.menu_id)}${Object.keys(l.modifiers || {}).length ? "*" : ""}`).join(", ");

// ---------- render ----------
async function refresh() {
  const [orders, cubbies, events] = await Promise.all([
    api(`/api/orders?include_done=${$("#show-done").checked}`),
    api("/api/cubbies"),
    api("/api/events"),
  ]);
  state.orders = orders;
  renderOrders();
  renderDetail();
  $("#cubbies").innerHTML = cubbies.map((c) => c.order_id
    ? `<div class="cubby busy"><b>${esc(c.label)}</b>#${c.order_id}<br>${esc(c.customer_name)}</div>`
    : `<div class="cubby"><b>${esc(c.label)}</b>free</div>`).join("");
  $("#events").innerHTML = events.map((e) =>
    `<li><span class="meta">${time(e.created_at)}</span>${e.order_id ? `#${e.order_id} ` : ""}${esc(e.kind.replace(/_/g, " "))}${e.detail ? ` — ${esc(e.detail)}` : ""}</li>`).join("");
}

function renderOrders() {
  const ul = $("#orders");
  if (!state.orders.length) { ul.innerHTML = `<li class="empty">No open tickets. Create a demo order.</li>`; return; }
  ul.innerHTML = state.orders.map((o) => `
    <li data-id="${o.id}" data-status="${o.status}" class="${o.id === state.selectedId ? "selected" : ""}">
      <div class="row"><b>#${o.id} · ${esc(o.customer_name)}</b><span class="status ${o.status}">${STATUS[o.status]}${o.cubby_id && o.status === "in_cubby" ? " C" + o.cubby_id : ""}</span></div>
      <div class="summary">${esc(orderSummary(o))} · ${esc(o.source)}</div>
    </li>`).join("");
}

function renderDetail() {
  const o = state.orders.find((x) => x.id === state.selectedId);
  $("#detail").hidden = !o;
  $("#detail-empty").hidden = !!o;
  if (!o) return;
  $("#d-title").textContent = `#${o.id} · ${o.customer_name}`;
  const st = $("#d-status");
  st.className = "status " + o.status;
  st.textContent = STATUS[o.status] + (o.status === "in_cubby" ? ` · cubby C${o.cubby_id}` : "");
  $("#d-items").innerHTML = o.items.map((l) => `<li>${lineHtml(l)}</li>`).join("");

  const done = ["in_cubby", "picked_up"].includes(o.status);
  document.querySelectorAll("[data-sample], #btn-photo").forEach((b) => (b.disabled = done));
  const needsOverride = o.status !== "verified";
  $("#override-wrap").hidden = done || !needsOverride;
  $("#override-note").hidden = done || !needsOverride || !$("#override").checked;
  $("#btn-assign").disabled = done || (needsOverride && !$("#override").checked);
  $("#btn-pickup").disabled = o.status !== "in_cubby";

  $("#d-inspections").innerHTML = o.inspections.length ? o.inspections.map((i, idx) => `
    <li class="${idx ? "old" : ""}">
      ${i.photo_path ? `<a href="${i.photo_path}" target="_blank"><img src="${i.photo_path}" alt="meal photo"></a>` : ""}
      <div>
        <span class="verdict ${i.verdict}">${i.verdict.replace("_", " ")}</span>
        <span class="meta">#${i.id} · ${esc(i.source)} · ${time(i.created_at)}${i.reassigned_from ? ` · moved from inspection #${i.reassigned_from}` : ""}</span>
        <ul>${i.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
        ${i.swap_suggestion && idx === 0 ? `
          <div class="swap">⚠ ${esc(i.swap_suggestion.message)}
            <div class="btn-row"><button data-reassign="${i.id}" data-target="${i.swap_suggestion.order_id}">Confirm: this meal is for #${i.swap_suggestion.order_id}</button></div>
          </div>` : ""}
      </div>
    </li>`).join("") : `<li class="hint">No inspections yet.</li>`;
}

// ---------- cubby simulation ----------
function showRelease(cubbyLabel, orderId, text, pickup = false) {
  const r = $("#release");
  r.className = "release" + (pickup ? " pickup" : "");
  $("#door-label").textContent = cubbyLabel;
  $("#bag-label").textContent = "#" + orderId;
  $("#release-text").textContent = text;
  r.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => r.classList.add("open")));
  speak(text);
}
$("#release-close").onclick = () => { $("#release").hidden = true; };

// ---------- actions ----------
async function select(id) { state.selectedId = id; $("#override").checked = false; renderOrders(); renderDetail(); }

$("#orders").onclick = (e) => { const li = e.target.closest("li[data-id]"); if (li) select(+li.dataset.id); };
$("#show-done").onchange = () => run(refresh);

$("#btn-demo").onclick = () => run(async () => {
  const o = await api("/api/orders/demo", { method: "POST" });
  state.selectedId = o.id;
  await refresh();
});

document.querySelectorAll("[data-sample]").forEach((b) => (b.onclick = () => run(async () => {
  const i = await api(`/api/orders/${state.selectedId}/inspect/sample?mode=${b.dataset.sample}`, { method: "POST" });
  await refresh();
  toast(`Inspection ${i.verdict.replace("_", " ")}`, i.verdict === "pass");
})));

$("#d-inspections").onclick = (e) => {
  const b = e.target.closest("[data-reassign]");
  if (!b) return;
  if (!confirm(`Move this meal to order #${b.dataset.target}? The original inspection is kept.`)) return;
  run(async () => {
    await api(`/api/inspections/${b.dataset.reassign}/reassign`, { json: { target_order_id: +b.dataset.target } });
    state.selectedId = +b.dataset.target;
    await refresh();
  });
};

$("#override").onchange = renderDetail;

$("#btn-assign").onclick = () => run(async () => {
  const override = $("#override").checked;
  const o = await api(`/api/orders/${state.selectedId}/assign-cubby`, { json: { override, staff_note: $("#override-note").value || null } });
  await refresh();
  showRelease(o.cubby.label, o.id, `Order ${o.id} for ${o.customer_name} is ready in cubby ${o.cubby.label.replace("C", "")}.`);
});

$("#btn-pickup").onclick = () => run(async () => {
  const before = state.orders.find((x) => x.id === state.selectedId);
  const o = await api(`/api/orders/${state.selectedId}/pickup`, { method: "POST" });
  await refresh();
  showRelease("C" + before.cubby_id, o.id, `Enjoy your meal, ${o.customer_name}! Cubby ${before.cubby_id} is now free.`, true);
});

$("#btn-reset").onclick = () => confirm("Delete all orders and inspections?") && run(async () => {
  await api("/api/reset", { method: "POST" });
  state.selectedId = null;
  await refresh();
});

// ---------- manual order form ----------
function addLine(line = { menu_id: "burger", qty: 1, modifiers: {} }) {
  const div = document.createElement("div");
  div.className = "line";
  div.innerHTML = `
    <select class="menu">${Object.entries(state.menu).map(([id, m]) => `<option value="${id}" ${id === line.menu_id ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</select>
    <input class="qty" type="number" min="1" max="20" value="${line.qty}">
    <button type="button" class="ghost rm">✕</button>
    <div class="mods"></div>`;
  const renderMods = (mods = {}) => {
    const comps = state.menu[div.querySelector(".menu").value].components;
    div.querySelector(".mods").innerHTML = Object.entries(comps).filter(([, c]) => c.removable).map(([cid, c]) => `
      <label>${esc(c.name)} <select data-comp="${cid}">
        <option value="">${c.default ? "std" : "none"}</option>
        <option value="${c.default ? "no" : "add"}" ${mods[cid] ? "selected" : ""}>${c.default ? "no" : "add"}</option>
      </select></label>`).join("");
  };
  div.querySelector(".menu").onchange = () => renderMods();
  div.querySelector(".rm").onclick = () => div.remove();
  renderMods(line.modifiers);
  $("#order-lines").appendChild(div);
}

function openOrderForm(draft = null, source = "manual") {
  const f = $("#order-form");
  f.reset();
  f.dataset.source = source;
  $("#order-form-title").textContent = source === "voice" ? "Confirm voice order" : "New order";
  $("#order-lines").innerHTML = "";
  f.customer.value = draft?.customer_name || "";
  (draft?.items?.length ? draft.items : [undefined]).forEach((l) => addLine(l));
  $("#dlg-order").showModal();
}
$("#btn-new").onclick = () => openOrderForm();
$("#add-line").onclick = () => addLine();
$("#order-save").onclick = (e) => {
  e.preventDefault();
  const f = $("#order-form");
  if (!f.reportValidity()) return;
  const items = [...document.querySelectorAll("#order-lines .line")].map((d) => ({
    menu_id: d.querySelector(".menu").value,
    qty: +d.querySelector(".qty").value || 1,
    modifiers: Object.fromEntries([...d.querySelectorAll("[data-comp]")].filter((s) => s.value).map((s) => [s.dataset.comp, s.value])),
  }));
  if (!items.length) return toast("Add at least one item");
  run(async () => {
    const o = await api("/api/orders", { json: { customer_name: f.customer.value, items, source: f.dataset.source || "manual" } });
    $("#dlg-order").close();
    state.selectedId = o.id;
    await refresh();
    toast(`Order #${o.id} saved`, true);
  });
};

// ---------- audio recording (shared by voice order + test lab) ----------
async function recordAudio(ms) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const rec = new MediaRecorder(stream);
  const chunks = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  const done = new Promise((r) => (rec.onstop = r));
  rec.start();
  await new Promise((r) => setTimeout(r, ms));
  rec.stop();
  await done;
  stream.getTracks().forEach((t) => t.stop());
  return new Blob(chunks, { type: rec.mimeType || "audio/webm" });
}
async function uploadAudio(blob) {
  const fd = new FormData();
  fd.append("audio", blob, "clip.webm");
  return api("/api/voice/transcribe", { method: "POST", body: fd });
}

$("#btn-voice").onclick = () => { $("#voice-text").value = ""; $("#voice-state").textContent = ""; $("#dlg-voice").showModal(); };
$("#voice-rec").onclick = () => run(async () => {
  $("#voice-state").textContent = "Recording 5s…";
  const blob = await recordAudio(5000);
  $("#voice-state").textContent = "Uploading…";
  const r = await uploadAudio(blob);
  if (r.transcript) { $("#voice-text").value = r.transcript; $("#voice-state").textContent = "Transcribed."; }
  else $("#voice-state").textContent = `Got ${r.bytes} bytes. ${r.note} Type the order below.`;
});
$("#voice-parse").onclick = () => run(async () => {
  const text = $("#voice-text").value.trim();
  if (!text) return toast("Nothing to parse");
  const draft = await api("/api/voice/parse", { json: { transcript: text } });
  $("#dlg-voice").close();
  openOrderForm(draft, "voice");
});

// ---------- camera ----------
let camStream = null, camBlob = null;
async function openCamera(title) {
  $("#cam-title").textContent = title;
  camBlob = null;
  $("#cam-send").disabled = true;
  $("#cam-still").hidden = true;
  $("#cam-video").hidden = false;
  $("#cam-file").value = "";
  $("#dlg-camera").showModal();
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    $("#cam-video").srcObject = camStream;
  } catch (e) {
    $("#cam-video").hidden = true;
    toast("No camera available — use the file picker instead.");
  }
}
function stopCamera() { camStream?.getTracks().forEach((t) => t.stop()); camStream = null; }
$("#dlg-camera").addEventListener("close", stopCamera);
function showStill(blob) {
  camBlob = blob;
  $("#cam-still").src = URL.createObjectURL(blob);
  $("#cam-still").hidden = false;
  $("#cam-video").hidden = true;
  $("#cam-send").disabled = !state.selectedId || $("#cam-title").dataset.lab === "1";
}
$("#cam-snap").onclick = () => {
  const v = $("#cam-video");
  if (!v.videoWidth) return toast("Camera not ready");
  const c = document.createElement("canvas");
  c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext("2d").drawImage(v, 0, 0);
  c.toBlob((b) => { showStill(b); stopCamera(); }, "image/jpeg", 0.85);
};
$("#cam-file").onchange = (e) => e.target.files[0] && showStill(e.target.files[0]);
$("#cam-send").onclick = () => run(async () => {
  const fd = new FormData();
  fd.append("photo", camBlob, "meal.jpg");
  fd.append("fallback_sample", $("#cam-fallback").value);
  const i = await api(`/api/orders/${state.selectedId}/inspect`, { method: "POST", body: fd });
  $("#dlg-camera").close();
  await refresh();
  toast(`Inspection ${i.verdict.replace("_", " ")}`, i.verdict === "pass");
});
$("#btn-photo").onclick = () => { $("#cam-title").dataset.lab = ""; openCamera(`Photo inspection · order #${state.selectedId}`); };

// ---------- test lab ----------
const labOut = (s) => ($("#lab-out").textContent = s);
$("#lab-mic").onclick = () => run(async () => {
  labOut("Recording 3s…");
  const blob = await recordAudio(3000);
  const a = $("#lab-audio");
  a.src = URL.createObjectURL(blob); a.hidden = false;
  const r = await uploadAudio(blob);
  labOut(`Recorded ${blob.size} bytes (${blob.type}). Server got ${r.bytes} bytes.\nTranscript: ${r.transcript ?? "—"}\n${r.note ?? ""}`);
});
$("#lab-cam").onclick = () => { $("#cam-title").dataset.lab = "1"; openCamera("Camera test (nothing is saved)"); };
$("#lab-tts").onclick = () => { speak("Order 12 for Ava is ready in cubby 3."); labOut("speechSynthesis " + ("speechSynthesis" in window ? "available" : "NOT available")); };

// ---------- boot ----------
(async () => {
  state.menu = await api("/api/menu");
  await run(refresh);
  setInterval(() => run(refresh), 4000); // keeps multiple screens in sync
})();
