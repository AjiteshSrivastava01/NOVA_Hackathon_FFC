import importlib
import os

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("FFC_DB", str(tmp_path / "test.db"))
    from backend import db, app as app_mod
    importlib.reload(db)
    importlib.reload(app_mod)
    with TestClient(app_mod.app) as c:
        yield c


def burger_obs(lettuce="present", **extra):
    comps = {"bun": "present", "patty": "present", "lettuce": lettuce, "tomato": "present",
             "cheese": "present", "onion": "absent", "pickles": "absent"}
    comps.update(extra)
    return {"menu_id": "burger", "components": comps}


def make(client, name, items):
    r = client.post("/api/orders", json={"customer_name": name, "items": items})
    assert r.status_code == 201, r.text
    return r.json()


def test_full_flow(client):
    o = make(client, "Ava", [{"menu_id": "burger", "qty": 2}, {"menu_id": "fries", "qty": 1}])
    assert [x["id"] for x in client.get("/api/orders").json()] == [o["id"]]

    r = client.post(f"/api/orders/{o['id']}/inspect/sample?mode=correct").json()
    assert r["verdict"] == "pass"

    r = client.post(f"/api/orders/{o['id']}/assign-cubby", json={})
    assert r.status_code == 200 and r.json()["cubby"]["label"] == "C1"
    assert client.get("/api/cubbies").json()[0]["order_id"] == o["id"]

    r = client.post(f"/api/orders/{o['id']}/pickup")
    assert r.json()["status"] == "picked_up"
    assert client.get("/api/cubbies").json()[0]["order_id"] is None
    assert client.get("/api/orders").json() == []


def test_two_burgers_vs_one(client):
    o = make(client, "Ben", [{"menu_id": "burger", "qty": 2}])
    r = client.post(f"/api/orders/{o['id']}/inspect", json={"observations": {"items": [burger_obs()]}}).json()
    assert r["verdict"] == "fail" and "expected 2, saw 1" in r["reasons"][0]


def test_hidden_lettuce_is_review_not_absent(client):
    o = make(client, "Cy", [{"menu_id": "burger", "qty": 1}])
    r = client.post(f"/api/orders/{o['id']}/inspect", json={"observations": {"items": [burger_obs("unknown")]}}).json()
    assert r["verdict"] == "needs_review"
    # can't assign without override
    assert client.post(f"/api/orders/{o['id']}/assign-cubby", json={}).status_code == 409
    assert client.post(f"/api/orders/{o['id']}/assign-cubby", json={"override": True, "staff_note": "checked"}).status_code == 200


def test_retake_keeps_history_and_swap_suggestion(client):
    a = make(client, "Dee", [{"menu_id": "burger", "qty": 1, "modifiers": {"lettuce": "no"}}])
    b = make(client, "Eve", [{"menu_id": "burger", "qty": 1}])
    # Meal photographed for Dee has lettuce -> fail, looks like Eve's order.
    r = client.post(f"/api/orders/{a['id']}/inspect", json={"observations": {"items": [burger_obs()]}}).json()
    assert r["verdict"] == "fail"
    assert r["swap_suggestion"]["order_id"] == b["id"]
    # Nothing was reassigned automatically.
    assert client.get(f"/api/orders/{b['id']}").json()["inspections"] == []
    # Retake for Dee, now correct.
    client.post(f"/api/orders/{a['id']}/inspect", json={"observations": {"items": [burger_obs("absent")]}})
    hist = client.get(f"/api/orders/{a['id']}").json()["inspections"]
    assert [h["verdict"] for h in hist] == ["pass", "fail"]
    # Staff confirms reassignment of the first meal.
    r = client.post(f"/api/inspections/{hist[1]['id']}/reassign", json={"target_order_id": b["id"]}).json()
    assert r["verdict"] == "pass" and r["reassigned_from"] == hist[1]["id"]


def test_modifier_validation(client):
    r = client.post("/api/orders", json={"customer_name": "X", "items": [{"menu_id": "burger", "modifiers": {"patty": "no"}}]})
    assert r.status_code == 422
    r = client.post("/api/orders", json={"customer_name": "X", "items": [{"menu_id": "pizza"}]})
    assert r.status_code == 422


def test_photo_upload_with_fallback(client):
    o = make(client, "Flo", [{"menu_id": "fries", "qty": 1}])
    files = {"photo": ("m.jpg", b"\xff\xd8fakejpeg", "image/jpeg")}
    r = client.post(f"/api/orders/{o['id']}/inspect", files=files)
    assert r.status_code == 501
    r = client.post(f"/api/orders/{o['id']}/inspect", files=files, data={"fallback_sample": "correct"})
    assert r.status_code == 200 and r.json()["photo_path"].startswith("/photos/")
    assert client.get(r.json()["photo_path"]).status_code == 200


def test_cubbies_run_out(client):
    for i in range(9):
        o = make(client, f"P{i}", [{"menu_id": "soda"}])
        r = client.post(f"/api/orders/{o['id']}/assign-cubby", json={"override": True})
    assert r.status_code == 409 and "No free cubbies" in r.text


def test_voice_parse(client):
    r = client.post("/api/voice/parse", json={"transcript": "Two burgers no lettuce and fries for Sam"}).json()
    assert r["customer_name"] == "Sam"
    assert r["items"][0] == {"menu_id": "burger", "qty": 2, "modifiers": {"lettuce": "no"}}
    assert r["items"][1]["menu_id"] == "fries"
