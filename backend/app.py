"""FFC kitchen backend. Run: uvicorn backend.app:app --reload --port 8000

Integration contract (do not break without telling the team):
  POST /api/orders                    save a confirmed order
  GET  /api/orders                    populate the dashboard
  POST /api/orders/{id}/inspect       inspect a photo against the SELECTED order
  POST /api/orders/{id}/assign-cubby  reserve a cubby (verified, or staff override)
  POST /api/orders/{id}/pickup        confirm pickup, release the cubby
"""

import base64
import json
import os
import random
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import db, matching, vision, voice
from .menu import MENU, expected_components

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PHOTO_DIR = os.path.join(ROOT, "data", "photos")
FRONTEND = os.path.join(ROOT, "frontend")
os.makedirs(PHOTO_DIR, exist_ok=True)


@asynccontextmanager
async def lifespan(_app):
    db.init()
    yield


app = FastAPI(title="FFC Kitchen", lifespan=lifespan)


# ---------- models ----------

class OrderLine(BaseModel):
    menu_id: str
    qty: int = Field(1, ge=1, le=20)
    modifiers: dict[str, str] = Field(default_factory=dict)  # {"lettuce": "no", "onion": "add"}


class OrderIn(BaseModel):
    customer_name: str = Field(..., min_length=1, max_length=60)
    items: list[OrderLine] = Field(..., min_length=1)
    source: str = "manual"


class AssignIn(BaseModel):
    override: bool = False
    staff_note: str | None = None


class ReassignIn(BaseModel):
    target_order_id: int


class TranscriptIn(BaseModel):
    transcript: str


# ---------- helpers ----------

def _get_order(conn, order_id: int) -> dict:
    row = conn.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
    if not row:
        raise HTTPException(404, f"Order {order_id} not found")
    return db.order_row(row)


def _inspections(conn, order_id: int) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM inspections WHERE order_id = ? ORDER BY id DESC", (order_id,)
    ).fetchall()
    return [db.inspection_row(r) for r in rows]


def _full_order(conn, order_id: int) -> dict:
    o = _get_order(conn, order_id)
    o["inspections"] = _inspections(conn, order_id)
    o["latest_inspection"] = o["inspections"][0] if o["inspections"] else None
    return o


def _validate_items(items: list[OrderLine]) -> list[dict]:
    out = []
    for i, line in enumerate(items, 1):
        if line.menu_id not in MENU:
            raise HTTPException(422, f"Unknown menu_id '{line.menu_id}'")
        try:
            expected_components(line.menu_id, line.modifiers)
        except ValueError as e:
            raise HTTPException(422, str(e))
        out.append({"line_id": i, "menu_id": line.menu_id, "qty": line.qty, "modifiers": line.modifiers})
    return out


def _save_photo(data: bytes, ext: str = "jpg") -> str:
    name = f"{uuid.uuid4().hex}.{ext}"
    with open(os.path.join(PHOTO_DIR, name), "wb") as f:
        f.write(data)
    return f"/photos/{name}"


def _record_inspection(conn, order: dict, observations: dict, source: str,
                       photo_path: str | None, reassigned_from: int | None = None) -> dict:
    result = matching.evaluate(order["items"], observations)
    swap = None
    if result["verdict"] != matching.PASS:
        others = [
            db.order_row(r) for r in conn.execute(
                "SELECT * FROM orders WHERE id != ? AND status NOT IN ('in_cubby', 'picked_up')",
                (order["id"],),
            ).fetchall()
        ]
        swap = matching.suggest_swap(observations, others)
    cur = conn.execute(
        """INSERT INTO inspections (order_id, photo_path, source, observations_json, verdict,
           reasons_json, swap_suggestion_json, reassigned_from, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (order["id"], photo_path, source, json.dumps(observations), result["verdict"],
         json.dumps(result["reasons"]), json.dumps(swap) if swap else None, reassigned_from, db.now()),
    )
    status = "verified" if result["verdict"] == matching.PASS else "needs_attention"
    conn.execute("UPDATE orders SET status = ? WHERE id = ?", (status, order["id"]))
    db.log(conn, order["id"], "inspected", f"{source}: {result['verdict']}")
    row = conn.execute("SELECT * FROM inspections WHERE id = ?", (cur.lastrowid,)).fetchone()
    return db.inspection_row(row)


def _sample_observations(order: dict, mode: str) -> dict:
    """Fake what vision would report. mode: correct | mistake | hidden."""
    units = matching.expand_order(order["items"])
    items = [{"menu_id": u["menu_id"],
              "components": {c: "present" if v else "absent" for c, v in u["expected"].items()}}
             for u in units]
    if mode == "mistake":
        flippable = [(i, c) for i, it in enumerate(items) for c in it["components"]
                     if MENU[it["menu_id"]]["components"][c]["removable"]]
        if flippable:
            i, c = random.choice(flippable)
            comps = items[i]["components"]
            comps[c] = "absent" if comps[c] == "present" else "present"
        else:
            items.pop()
    elif mode == "hidden":
        for it in items:
            if "lettuce" in it["components"]:
                it["components"]["lettuce"] = "unknown"
                break
        else:
            items[0]["components"][next(iter(items[0]["components"]))] = "unknown"
    return {"items": items, "notes": f"sample inspection ({mode})"}


# ---------- menu ----------

@app.get("/api/menu")
def get_menu():
    return MENU


# ---------- orders ----------

@app.post("/api/orders", status_code=201)
def create_order(body: OrderIn):
    items = _validate_items(body.items)
    with db.connect() as conn:
        cur = conn.execute(
            "INSERT INTO orders (customer_name, items_json, source, created_at) VALUES (?, ?, ?, ?)",
            (body.customer_name.strip(), json.dumps(items), body.source, db.now()),
        )
        db.log(conn, cur.lastrowid, "created", body.source)
        return _full_order(conn, cur.lastrowid)


@app.post("/api/orders/demo", status_code=201)
def create_demo_order():
    names = ["Ava", "Ben", "Chloe", "Dev", "Ella", "Finn", "Grace", "Hugo", "Isla", "Jay"]
    lines = [{"menu_id": "burger", "qty": random.choice([1, 1, 2]),
              "modifiers": random.choice([{}, {"lettuce": "no"}, {"onion": "add"}, {"cheese": "no", "pickles": "add"}])}]
    if random.random() < 0.7:
        lines.append({"menu_id": "fries", "qty": 1, "modifiers": {}})
    if random.random() < 0.4:
        lines.append({"menu_id": random.choice(["chicken_sandwich", "salad"]), "qty": 1, "modifiers": {}})
    if random.random() < 0.5:
        lines.append({"menu_id": "soda", "qty": 1, "modifiers": {}})
    return create_order(OrderIn(customer_name=random.choice(names),
                                items=[OrderLine(**l) for l in lines], source="demo"))


@app.get("/api/orders")
def list_orders(include_done: bool = False):
    with db.connect() as conn:
        q = "SELECT id FROM orders" + ("" if include_done else " WHERE status != 'picked_up'") + " ORDER BY id"
        return [_full_order(conn, r["id"]) for r in conn.execute(q).fetchall()]


@app.get("/api/orders/{order_id}")
def get_order(order_id: int):
    with db.connect() as conn:
        return _full_order(conn, order_id)


@app.post("/api/orders/{order_id}/inspect")
async def inspect(order_id: int, request: Request):
    """Accepts either:
       * JSON: {"observations": {...}, "source": "vision", "photo_base64": "..."}
       * multipart: photo=<file>, observations=<json string, optional>, source=<str>
    Optional "fallback_sample" (correct|mistake|hidden): if vision isn't wired yet,
    use fake observations so the photo path can be tested end to end.
    If no observations are sent, the vision module is asked to produce them.
    Every call creates a NEW inspection record -- retakes never overwrite.
    """
    ctype = request.headers.get("content-type", "")
    photo, observations, source, fallback = None, None, "vision", None
    if ctype.startswith("multipart/form-data"):
        form = await request.form()
        if form.get("photo") is not None:
            photo = await form["photo"].read()
        if form.get("observations"):
            observations = json.loads(form["observations"])
        source = form.get("source") or source
        fallback = form.get("fallback_sample")
    else:
        body = await request.json()
        observations = body.get("observations")
        source = body.get("source") or source
        fallback = body.get("fallback_sample")
        if body.get("photo_base64"):
            b64 = body["photo_base64"].split(",", 1)[-1]
            photo = base64.b64decode(b64)

    with db.connect() as conn:
        order = _get_order(conn, order_id)
        if order["status"] in ("in_cubby", "picked_up"):
            raise HTTPException(409, f"Order {order_id} is already {order['status']}")
        if observations is None:
            if photo is None:
                raise HTTPException(422, "Send a photo, observations, or both")
            observations = vision.analyze(photo, order)
            if observations is None and fallback in ("correct", "mistake", "hidden"):
                # Lets the dashboard test the camera path before vision exists.
                observations, source = _sample_observations(order, fallback), "sample+photo"
            if observations is None:
                raise HTTPException(501, "Vision model not wired up yet (backend/vision.py). "
                                         "Send observations alongside the photo for now.")
        photo_path = _save_photo(photo) if photo else None
        return _record_inspection(conn, order, observations, source, photo_path)


@app.post("/api/orders/{order_id}/inspect/sample")
def inspect_sample(order_id: int, mode: str = "correct"):
    """Dashboard button: pretend vision looked at the meal."""
    if mode not in ("correct", "mistake", "hidden"):
        raise HTTPException(422, "mode must be correct | mistake | hidden")
    with db.connect() as conn:
        order = _get_order(conn, order_id)
        if order["status"] in ("in_cubby", "picked_up"):
            raise HTTPException(409, f"Order {order_id} is already {order['status']}")
        return _record_inspection(conn, order, _sample_observations(order, mode), "sample", None)


@app.post("/api/inspections/{inspection_id}/reassign")
def reassign(inspection_id: int, body: ReassignIn):
    """Staff confirms a suggested swap: the meal is evaluated against another ticket.
    The original inspection is kept; a new linked one is created on the target order."""
    with db.connect() as conn:
        row = conn.execute("SELECT * FROM inspections WHERE id = ?", (inspection_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Inspection not found")
        insp = db.inspection_row(row)
        target = _get_order(conn, body.target_order_id)
        if target["status"] in ("in_cubby", "picked_up"):
            raise HTTPException(409, f"Order {target['id']} is already {target['status']}")
        db.log(conn, insp["order_id"], "meal_reassigned", f"to order {target['id']}")
        return _record_inspection(conn, target, insp["observations"], "reassigned",
                                  insp["photo_path"], reassigned_from=inspection_id)


@app.post("/api/orders/{order_id}/assign-cubby")
def assign_cubby(order_id: int, body: AssignIn | None = None):
    body = body or AssignIn()
    with db.connect() as conn:
        order = _get_order(conn, order_id)
        if order["status"] in ("in_cubby", "picked_up"):
            raise HTTPException(409, f"Order {order_id} is already {order['status']}")
        if order["status"] != "verified" and not body.override:
            raise HTTPException(409, "Order is not verified. Re-inspect, or pass override=true with a staff note.")
        free = conn.execute("SELECT * FROM cubbies WHERE order_id IS NULL ORDER BY id LIMIT 1").fetchone()
        if not free:
            raise HTTPException(409, "No free cubbies")
        conn.execute("UPDATE cubbies SET order_id = ? WHERE id = ?", (order_id, free["id"]))
        conn.execute("UPDATE orders SET status = 'in_cubby', cubby_id = ? WHERE id = ?", (free["id"], order_id))
        detail = f"cubby {free['label']}" + (f" (STAFF OVERRIDE: {body.staff_note or 'no note'})" if body.override else "")
        db.log(conn, order_id, "cubby_assigned", detail)
        out = _full_order(conn, order_id)
        out["cubby"] = dict(free)
        return out


@app.post("/api/orders/{order_id}/pickup")
def pickup(order_id: int):
    with db.connect() as conn:
        order = _get_order(conn, order_id)
        if order["status"] != "in_cubby":
            raise HTTPException(409, f"Order {order_id} is {order['status']}, not in a cubby")
        conn.execute("UPDATE cubbies SET order_id = NULL WHERE order_id = ?", (order_id,))
        conn.execute("UPDATE orders SET status = 'picked_up', picked_up_at = ? WHERE id = ?", (db.now(), order_id))
        db.log(conn, order_id, "picked_up", f"cubby C{order['cubby_id']}")
        return _full_order(conn, order_id)


# ---------- cubbies / events / reset ----------

@app.get("/api/cubbies")
def list_cubbies():
    with db.connect() as conn:
        rows = conn.execute(
            """SELECT c.id, c.label, c.order_id, o.customer_name FROM cubbies c
               LEFT JOIN orders o ON o.id = c.order_id ORDER BY c.id"""
        ).fetchall()
        return [dict(r) for r in rows]


@app.get("/api/events")
def list_events(limit: int = 30):
    with db.connect() as conn:
        rows = conn.execute("SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return [dict(r) for r in rows]


@app.post("/api/reset")
def reset():
    """Wipe everything (demo convenience)."""
    with db.connect() as conn:
        conn.executescript("DELETE FROM events; DELETE FROM inspections; UPDATE cubbies SET order_id = NULL;"
                           " DELETE FROM orders; DELETE FROM sqlite_sequence WHERE name IN ('orders','inspections','events');")
    return {"ok": True}


# ---------- voice (stub hooks for the voice team) ----------

@app.post("/api/voice/parse")
def voice_parse(body: TranscriptIn):
    """Transcript -> draft order. The dashboard shows it for confirmation before POST /api/orders."""
    return voice.parse_order(body.transcript)


@app.post("/api/voice/transcribe")
async def voice_transcribe(request: Request):
    form = await request.form()
    audio = await form["audio"].read()
    text = voice.transcribe(audio, form["audio"].content_type)
    return {"bytes": len(audio), "transcript": text,
            "note": None if text else "Speech-to-text not wired yet (backend/voice.py). Audio was received OK."}


# ---------- static ----------

app.mount("/photos", StaticFiles(directory=PHOTO_DIR, check_dir=False), name="photos")
app.mount("/static", StaticFiles(directory=FRONTEND), name="static")


@app.get("/")
def index():
    return FileResponse(os.path.join(FRONTEND, "index.html"))
