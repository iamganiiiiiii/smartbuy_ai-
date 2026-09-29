"""Auth, free-trial gating, and billing-webhook tests - no real Gemini/
SerpApi/Razorpay calls (run_agent is stubbed, DB points at a temp file)."""

import hashlib
import hmac
import json

import pytest
from fastapi.testclient import TestClient

from app import db
from app.config import settings


class _FakeResult:
    final_text = "ok"
    best_listing = None
    other_listings = []
    alternatives = []
    trace = []
    flags = []


async def _fake_run_agent(query):
    return _FakeResult()


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "db_path", str(tmp_path / "test.db"))
    monkeypatch.setattr(settings, "free_trial_limit", 2)
    monkeypatch.setattr(settings, "gemini_api_key", "test-key")
    db.init_db()

    import app.main as main_module

    monkeypatch.setattr(main_module, "run_agent", _fake_run_agent)
    return TestClient(main_module.app)


def _signup(client, email="user@example.com", password="password123"):
    res = client.post("/api/auth/signup", json={"email": email, "password": password})
    assert res.status_code == 200, res.text
    return res.json()["token"]


def test_signup_and_me(client):
    token = _signup(client)
    res = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 200
    body = res.json()
    assert body["email"] == "user@example.com"
    assert body["trial_searches_used"] == 0
    assert body["free_trial_limit"] == 2


def test_signup_duplicate_email_rejected(client):
    _signup(client)
    res = client.post("/api/auth/signup", json={"email": "user@example.com", "password": "password123"})
    assert res.status_code == 409


def test_login_wrong_password_rejected(client):
    _signup(client)
    res = client.post("/api/auth/login", json={"email": "user@example.com", "password": "wrongpass"})
    assert res.status_code == 401


def test_search_requires_auth(client):
    res = client.post("/api/search", json={"query": "headphones"})
    assert res.status_code == 401


def test_trial_limit_then_402(client):
    token = _signup(client)
    headers = {"Authorization": f"Bearer {token}"}

    for _ in range(settings.free_trial_limit):
        res = client.post("/api/search", json={"query": "headphones"}, headers=headers)
        assert res.status_code == 200, res.text

    res = client.post("/api/search", json={"query": "headphones"}, headers=headers)
    assert res.status_code == 402


def test_search_writes_audit_event(client):
    token = _signup(client)
    headers = {"Authorization": f"Bearer {token}"}
    res = client.post("/api/search", json={"query": "headphones"}, headers=headers)
    assert res.status_code == 200, res.text

    with db._connect() as conn:
        rows = conn.execute("SELECT * FROM audit_events WHERE event_type = 'search'").fetchall()
    assert len(rows) == 1
    assert rows[0]["query"] == "headphones"


def test_search_rejects_overlong_query(client):
    token = _signup(client)
    headers = {"Authorization": f"Bearer {token}"}
    res = client.post("/api/search", json={"query": "x" * 301}, headers=headers)
    assert res.status_code == 400


def test_logout_invalidates_token(client):
    token = _signup(client)
    headers = {"Authorization": f"Bearer {token}"}
    assert client.post("/api/auth/logout", headers=headers).status_code == 200
    res = client.get("/api/auth/me", headers=headers)
    assert res.status_code == 401


def test_webhook_rejects_bad_signature(client, monkeypatch):
    monkeypatch.setattr(settings, "razorpay_webhook_secret", "whsec_test")
    body = json.dumps({"event": "subscription.activated", "payload": {}}).encode()
    res = client.post(
        "/api/billing/webhook",
        content=body,
        headers={"X-Razorpay-Signature": "not-a-real-signature"},
    )
    assert res.status_code == 400


def test_webhook_activates_subscription_on_valid_signature(client, monkeypatch):
    monkeypatch.setattr(settings, "razorpay_webhook_secret", "whsec_test")

    token = _signup(client)
    headers = {"Authorization": f"Bearer {token}"}
    assert client.get("/api/auth/me", headers=headers).json()["subscription_status"] == "none"

    # Simulate this user already having a subscription id on file, as if
    # /api/billing/create-subscription had run against a real Razorpay account.
    user = db.get_user_by_email("user@example.com")
    db.set_subscription_pending(user["id"], "sub_test123")

    body = json.dumps(
        {
            "event": "subscription.activated",
            "payload": {"subscription": {"entity": {"id": "sub_test123", "current_end": 9999999999}}},
        }
    ).encode()
    signature = hmac.new(b"whsec_test", body, hashlib.sha256).hexdigest()

    res = client.post(
        "/api/billing/webhook",
        content=body,
        headers={"X-Razorpay-Signature": signature},
    )
    assert res.status_code == 200
    assert client.get("/api/auth/me", headers=headers).json()["subscription_status"] == "active"


def test_cancel_subscription_requires_active_subscription(client):
    token = _signup(client)
    res = client.post("/api/billing/cancel-subscription", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 400


def test_cancel_subscription_success(client, monkeypatch):
    import app.billing as billing_module

    async def fake_razorpay_post(path, payload):
        return {"id": "sub_test123", "status": "cancelled"}

    monkeypatch.setattr(billing_module, "_razorpay_post", fake_razorpay_post)

    token = _signup(client)
    headers = {"Authorization": f"Bearer {token}"}
    user = db.get_user_by_email("user@example.com")
    db.set_subscription_pending(user["id"], "sub_test123")
    db.set_subscription_active("sub_test123", 9999999999)

    res = client.post("/api/billing/cancel-subscription", headers=headers)
    assert res.status_code == 200
    assert client.get("/api/auth/me", headers=headers).json()["subscription_status"] == "cancelled"


def test_password_reset_flow(client, monkeypatch):
    captured = {}

    async def fake_send_reset(to, reset_url):
        captured["reset_url"] = reset_url

    import app.auth_routes as auth_routes_module

    monkeypatch.setattr(auth_routes_module.email, "send_password_reset_email", fake_send_reset)

    token = _signup(client)
    headers = {"Authorization": f"Bearer {token}"}
    assert client.get("/api/auth/me", headers=headers).status_code == 200

    res = client.post("/api/auth/forgot-password", json={"email": "user@example.com"})
    assert res.status_code == 200
    reset_token = captured["reset_url"].split("reset_token=")[1]

    res = client.post("/api/auth/reset-password", json={"token": reset_token, "new_password": "newpassword123"})
    assert res.status_code == 200

    # Resetting the password invalidates the pre-existing session token.
    assert client.get("/api/auth/me", headers=headers).status_code == 401
    assert client.post("/api/auth/login", json={"email": "user@example.com", "password": "password123"}).status_code == 401
    assert client.post("/api/auth/login", json={"email": "user@example.com", "password": "newpassword123"}).status_code == 200


def test_forgot_password_unknown_email_returns_ok_without_sending(client, monkeypatch):
    calls = []

    async def fake_send_reset(to, reset_url):
        calls.append(to)

    import app.auth_routes as auth_routes_module

    monkeypatch.setattr(auth_routes_module.email, "send_password_reset_email", fake_send_reset)

    res = client.post("/api/auth/forgot-password", json={"email": "nobody@example.com"})
    assert res.status_code == 200
    assert calls == []


def test_reset_password_rejects_invalid_token(client):
    res = client.post("/api/auth/reset-password", json={"token": "not-a-real-token", "new_password": "newpassword123"})
    assert res.status_code == 400


def test_change_password(client):
    token = _signup(client)
    headers = {"Authorization": f"Bearer {token}"}

    res = client.post(
        "/api/auth/change-password", json={"current_password": "wrong", "new_password": "newpassword123"}, headers=headers
    )
    assert res.status_code == 401

    res = client.post(
        "/api/auth/change-password", json={"current_password": "password123", "new_password": "newpassword123"}, headers=headers
    )
    assert res.status_code == 200
    assert client.post("/api/auth/login", json={"email": "user@example.com", "password": "newpassword123"}).status_code == 200


def test_delete_account_removes_user_and_cancels_subscription(client, monkeypatch):
    import app.billing as billing_module

    cancel_calls = []

    async def fake_razorpay_post(path, payload):
        cancel_calls.append(path)
        return {"id": "sub_test123", "status": "cancelled"}

    monkeypatch.setattr(billing_module, "_razorpay_post", fake_razorpay_post)

    token = _signup(client)
    headers = {"Authorization": f"Bearer {token}"}
    user = db.get_user_by_email("user@example.com")
    db.set_subscription_pending(user["id"], "sub_test123")
    db.set_subscription_active("sub_test123", 9999999999)

    res = client.delete("/api/auth/account", headers=headers)
    assert res.status_code == 200
    assert any("cancel" in c for c in cancel_calls)

    assert client.get("/api/auth/me", headers=headers).status_code == 401
    assert db.get_user_by_email("user@example.com") is None
