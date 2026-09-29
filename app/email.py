"""Transactional email via Resend's plain REST API (over the already-installed
httpx client - same "no SDK dependency for one endpoint" pattern as billing.py).

Failing to send an email should never break the action that triggered it
(signing up, subscribing, cancelling) - every call site treats this as
best-effort and logs rather than raises.
"""

import logging

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

RESEND_API_URL = "https://api.resend.com/emails"


async def send_email(to: str, subject: str, html: str) -> None:
    if not settings.resend_api_key:
        logger.warning("RESEND_API_KEY not configured - skipping email %r to %s", subject, to)
        return

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                RESEND_API_URL,
                headers={"Authorization": f"Bearer {settings.resend_api_key}"},
                json={"from": settings.email_from, "to": [to], "subject": subject, "html": html},
                timeout=10.0,
            )
            resp.raise_for_status()
    except Exception:
        logger.exception("Failed to send email %r to %s", subject, to)


def _wrapper(title: str, body_html: str) -> str:
    return f"""
    <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
      <h2 style="margin: 0 0 16px;">{title}</h2>
      {body_html}
      <p style="color: #888; font-size: 12px; margin-top: 32px;">SmartBuy AI - live price comparison</p>
    </div>
    """


async def send_welcome_email(to: str) -> None:
    html = _wrapper(
        "Welcome to SmartBuy AI",
        f"<p>Your account is ready. You've got {settings.free_trial_limit} free searches to try the AI agent "
        "before a subscription is needed.</p>",
    )
    await send_email(to, "Welcome to SmartBuy AI", html)


async def send_receipt_email(to: str, price_label: str) -> None:
    html = _wrapper(
        "Payment received",
        f"<p>Thanks for subscribing to SmartBuy AI ({price_label}). Your subscription is now active.</p>",
    )
    await send_email(to, "Your SmartBuy AI subscription is active", html)


async def send_cancellation_email(to: str) -> None:
    html = _wrapper(
        "Subscription cancelled",
        "<p>Your SmartBuy AI subscription has been cancelled and won't renew. "
        "You can resubscribe any time from your account.</p>",
    )
    await send_email(to, "Your SmartBuy AI subscription was cancelled", html)


async def send_password_reset_email(to: str, reset_url: str) -> None:
    html = _wrapper(
        "Reset your password",
        f'<p>Click the link below to set a new password. This link expires in 1 hour.</p>'
        f'<p><a href="{reset_url}" style="color: #6366f1;">Reset password</a></p>'
        f"<p style=\"color: #888; font-size: 12px;\">If you didn't request this, you can ignore this email.</p>",
    )
    await send_email(to, "Reset your SmartBuy AI password", html)
