"""SQLite storage. One file, no server. Delete data/ffc.db to reset."""

import json
import os
import sqlite3
from datetime import datetime, timezone

DB_PATH = os.environ.get("FFC_DB", os.path.join(os.path.dirname(__file__), "..", "data", "ffc.db"))
CUBBY_COUNT = int(os.environ.get("FFC_CUBBIES", "8"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name TEXT NOT NULL,
    items_json TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',      -- manual | voice | demo
    status TEXT NOT NULL DEFAULT 'pending',     -- pending | verified | needs_attention | in_cubby | picked_up
    cubby_id INTEGER,
    created_at TEXT NOT NULL,
    picked_up_at TEXT
);
CREATE TABLE IF NOT EXISTS inspections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    photo_path TEXT,
    source TEXT NOT NULL,                       -- sample | vision | manual | reassigned
    observations_json TEXT NOT NULL,            -- what was SEEN
    verdict TEXT NOT NULL,                      -- what the backend DECIDED
    reasons_json TEXT NOT NULL,
    swap_suggestion_json TEXT,
    reassigned_from INTEGER REFERENCES inspections(id),
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cubbies (
    id INTEGER PRIMARY KEY,
    label TEXT NOT NULL,
    order_id INTEGER REFERENCES orders(id)
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER,
    kind TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL
);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init() -> None:
    with connect() as conn:
        conn.executescript(SCHEMA)
        have = conn.execute("SELECT COUNT(*) FROM cubbies").fetchone()[0]
        for i in range(have + 1, CUBBY_COUNT + 1):
            conn.execute("INSERT INTO cubbies (id, label) VALUES (?, ?)", (i, f"C{i}"))


def log(conn, order_id, kind, detail=None):
    conn.execute(
        "INSERT INTO events (order_id, kind, detail, created_at) VALUES (?, ?, ?, ?)",
        (order_id, kind, detail, now()),
    )


def order_row(row) -> dict:
    d = dict(row)
    d["items"] = json.loads(d.pop("items_json"))
    return d


def inspection_row(row) -> dict:
    d = dict(row)
    d["observations"] = json.loads(d.pop("observations_json"))
    d["reasons"] = json.loads(d.pop("reasons_json"))
    s = d.pop("swap_suggestion_json")
    d["swap_suggestion"] = json.loads(s) if s else None
    return d
