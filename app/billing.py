"""Razorpay subscriptions via plain REST calls over httpx (no razorpay SDK
dependency - it's a thin wrapper we don't need for two endpoints).
"""

import hashlib
import hmac
import json

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request

from app import db, email
from app.auth import get_current_user
from app.config import settings

router = APIRouter(prefix="/api/billing")

RAZORPAY_BASE = "https://api.razorpay.com/v1"

# Razorpay has no "indefinite monthly" plan - a long total_count is the
# standard workaround (10 years of monthly charges).
_TOTAL_BILLING_CYCLES = 120


async def _razorpay_post(path: str, payload: dict) -> dict:
    async with httpx.AsyncClient(auth=(settings.razorpay_key_id, settings.razorpay_key_secret)) as client:
        resp = await client.post(f"{RAZORPAY_BASE}{path}", json=payload)
        resp.raise_for_status()
        return resp.json()


@router.post("/create-subscription")
async def create_subscription(user=Depends(get_current_user)):
    if user["subscription_status"] == "active":
        raise HTTPException(400, "Already subscribed")

    if user["razorpay_subscription_id"]:
        # Reuse the pending subscription instead of creating a duplicate on a double-click.
        return {"subscription_id": user["razorpay_subscription_id"], "key_id": settings.razorpay_key_id}

    if not settings.razorpay_plan_id:
        raise HTTPException(500, "RAZORPAY_PLAN_ID is not configured on the server")

    data = await _razorpay_post(
        "/subscriptions",
        {
            "plan_id": settings.razorpay_plan_id,
            "customer_notify": 1,
            "total_count": _TOTAL_BILLING_CYCLES,
            "notes": {"user_id": str(user["id"])},
        },
    )
    db.set_subscription_pending(user["id"], data["id"])
    return {"subscription_id": data["id"], "key_id": settings.razorpay_key_id}


async def cancel_subscription_for_user(user) -> None:
    """Shared by the /cancel-subscription endpoint and account deletion -
    deletion must not leave someone being billed for an account that no
    longer exists.

    Cancels immediately rather than at the end of the current billing
    cycle - simplest behavior for now, revisit if partial-period access
    on cancellation matters later.
    """
    if user["subscription_status"] != "active" or not user["razorpay_subscription_id"]:
        return
    await _razorpay_post(f"/subscriptions/{user['razorpay_subscription_id']}/cancel", {})
    db.set_subscription_cancelled(user["razorpay_subscription_id"])


@router.post("/cancel-subscription")
async def cancel_subscription(user=Depends(get_current_user)):
    if user["subscription_status"] != "active" or not user["razorpay_subscription_id"]:
        raise HTTPException(400, "No active subscription to cancel")

    await cancel_subscription_for_user(user)
    await email.send_cancellation_email(user["email"])
    return {"ok": True}


@router.post("/webhook")
async def webhook(request: Request):
    raw_body = await request.body()
    signature = request.headers.get("x-razorpay-signature", "")
    expected = hmac.new(settings.razorpay_webhook_secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise HTTPException(400, "Invalid webhook signature")

    payload = json.loads(raw_body)
    event = payload.get("event", "")
    entity = payload.get("payload", {}).get("subscription", {}).get("entity", {})
    subscription_id = entity.get("id")
    if not subscription_id:
        return {"ok": True}

    if event in ("subscription.activated", "subscription.charged"):
        db.set_subscription_active(subscription_id, entity.get("current_end"))
        if event == "subscription.charged":
            # Sent only on an actual payment capture, not on "activated" alone,
            # so the first successful payment doesn't produce two receipt emails.
            user = db.get_user_by_razorpay_subscription_id(subscription_id)
            if user:
                await email.send_receipt_email(user["email"], settings.subscription_price_label)
    elif event in ("subscription.cancelled", "subscription.completed", "subscription.halted"):
        db.set_subscription_cancelled(subscription_id)

    return {"ok": True}
