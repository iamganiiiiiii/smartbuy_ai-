# SmartBuy AI — AI Shopping Agent with Guardrails, Auth & Subscriptions

A Gemini-powered shopping agent that searches **real, live product listings**
(not mock data), picks the best genuine price, and surfaces alternatives that
actually score better — gated behind a 5-free-search trial and a Razorpay
subscription, with code-level guardrails so the model is never the final
authority on price, budget, or product facts.

Runs the AI/search stack on **free, no-credit-card tiers**: Google Gemini
(function calling) + SerpApi's Google Shopping engine (250 free searches/month).
Auth, billing, and email are separate integrations you configure yourself
(Razorpay, Resend) — see Setup below.

## Architecture

```
react-ui/ (React + Vite + Tailwind, the real frontend)
  -> POST /api/search  (app/main.py, FastAPI, auth-gated)
       -> db.try_consume_access()          free-trial / subscription check (SQLite)
       -> Agent Orchestrator (app/agent/orchestrator.py)
            Gemini function-calling loop, MAX_TURNS=6
            -> search_products  -> app/services/product_api.py (SerpApi)
                 -> app/services/relevance.py    drops unrelated products
                 -> app/guardrails.py            hard budget filter, price/URL validation
                 -> app/services/ranking.py      best-price + value-score picks
            -> find_alternatives -> app/services/ranking.py (±15% budget band)
            -> app/guardrails.py::check_output_grounding()  flags ungrounded prices
       -> db.log_audit_event()              one row per search (query, user, flags)
    <- grounded reply + structured listings + trace

app/static/  - a minimal vanilla-JS reference frontend (kept in sync less
               closely than react-ui; react-ui is the one to develop against)
```

## What's implemented

**Search agent** — natural-language product search via two tools
(`app/agent/tools.py`): `search_products` (real SerpApi call, cached,
relevance-filtered, budget-filtered) and `find_alternatives` (category-peer
comparison, only returns candidates that genuinely out-score the reference on
price/rating/reviews). Product links go straight to Amazon.in/Flipkart's own
search when the source is one of those two (verified working, not a guess);
other retailers fall back to Google's shopping page (`app/services/product_api.py`).

**Guardrails** (`app/guardrails.py`, `app/agent/prompts.py` `PROMPT_V3`) — the
model is never trusted to enforce these on its own:
- Budget is a hard code-level filter (`max_price`/`max_price_currency`), not
  a hint the model might ignore.
- Listings with a non-positive price or a non-`http(s)` URL are dropped before
  they ever reach the model or the UI.
- `Listing.availability` is a controlled `IN_STOCK`/`OUT_OF_STOCK`/`UNKNOWN`
  field (honestly defaulted to `UNKNOWN` — SerpApi's base results don't
  reliably expose real stock status).
- Tool-returned text is explicitly framed as untrusted data, not instructions
  (prompt-injection defense).
- `check_output_grounding()` flags (doesn't block) any price the model's
  prose mentions that doesn't match a real listing.
- Every search writes one row to `audit_events` (query, user, any flags
  raised) — a real audit trail, not per-tool-call granular, by design (see
  the plan history for the scoping rationale).

**Auth & accounts** (`app/auth.py`, `app/auth_routes.py`, `app/db.py`) —
email+password signup/login, bcrypt-hashed passwords, opaque bearer session
tokens (sha256-hashed at rest, never JWT), forgot/reset password (emailed
link, invalidates existing sessions), change password, self-serve account
deletion (cancels any active subscription first).

**Subscriptions & billing** (`app/billing.py`) — Razorpay subscriptions via
plain REST calls (no SDK dependency). Webhook-verified (HMAC over the raw
body) subscription activation/cancellation; the app maintains its own
entitlement state rather than trusting the client. 5 free searches per
account (`FREE_TRIAL_LIMIT`, currently raised to 50 for testing — see
`.env`), then a subscribe wall; self-serve cancellation refunds nothing
automatically and cancels immediately, not at period end.

**Transactional email** (`app/email.py`) — welcome, subscription receipt,
cancellation confirmation, and password-reset emails via Resend's REST API.
Fails silently (logs a warning) if `RESEND_API_KEY` isn't set, so it never
breaks signup/billing if email delivery has an issue.

**Frontend** (`react-ui/`) — signup/login, forgot/reset password, voice
search (Web Speech API), an account-settings modal (profile, plan
management, change password, delete account), and a priced paywall screen —
all built to match the existing dark/gradient design system rather than
bolted on. `app/static/` is a lighter-weight fallback that has the earlier
auth pass but not the later features (settings modal, voice search,
guardrail-aware UI) — **react-ui is the one to keep developing.**

## Setup

```bash
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt   # Windows
copy .env.example .env
```

Fill in `.env` — see `.env.example` for exactly where to get each key:

| Variable | Required for | Free tier? |
|---|---|---|
| `GEMINI_API_KEY` | the agent itself | Yes, no card |
| `SERPAPI_KEY` | real product search | Yes, 250/month |
| `RAZORPAY_KEY_ID` / `_SECRET` / `_WEBHOOK_SECRET` / `_PLAN_ID` | subscriptions | Yes, test mode |
| `RESEND_API_KEY` | real emails (else they're skipped, logged) | Yes, 3k/month |
| `FRONTEND_URL` | correct links in password-reset emails | — |
| `FREE_TRIAL_LIMIT` | how many free searches before paywall | — |

Run it:

```bash
# Backend
.venv\Scripts\python.exe -m uvicorn app.main:app --reload
# open http://127.0.0.1:8000 (app/static) or run react-ui separately:

cd react-ui
pnpm install
pnpm dev   # open the printed localhost URL
```

`react-ui/.env.local` sets `VITE_API_BASE_URL` to point at wherever the
backend is actually running (defaults assume the same machine).

## Testing

```bash
.venv\Scripts\python.exe -m pytest -v
```

47 tests, all offline (no live API calls) — auth flows, billing/webhook
signature verification, budget/price/URL guardrails, ranking math, relevance
filtering, price parsing. `run_agent`/Gemini/SerpApi are stubbed or untouched
in every test; live-agent behavior is verified manually against real traffic
during development, not in the automated suite.

## Deliberately out of scope (not gaps — considered and skipped)

- **Databricks / Unity Catalog** — wrong scale for a SQLite-backed MVP.
- **Splitting the orchestrator into 8 separate agents** (per the guardrails
  design doc's ideal architecture) — the single tool-calling loop is fine;
  guardrails wrap it rather than replacing its architecture.
- **Full NLP-based hallucination detection** — `check_output_grounding` only
  cross-checks prices (the cheapest, most checkable claim type), not
  subjective spec claims. A second-pass LLM judge is a real future option.
- **Direct-retailer links beyond Amazon/Flipkart** — every other retailer
  falls back to Google's shopping page; extending this means verifying more
  URL patterns the same way (safe, incremental) or a real retailer-API
  integration (bigger project).
- **Watchlist, price tracking/alerts, admin dashboard** — from the product
  vision doc, not built yet; price tracking was flagged as the single
  highest-value next feature.

## Before real production deployment

Not yet done, roughly in blocking order:

1. **Razorpay live-mode KYC** (business verification) — currently test mode
   only; this has an external approval queue, start it early.
2. **Real hosting + domain + HTTPS** — currently runs locally behind an
   ngrok tunnel that changes URL on every restart.
3. Point `FRONTEND_URL` and the Razorpay webhook at the real domain; set a
   real `RESEND_API_KEY`.
4. Terms of Service / Privacy Policy / Refund-Cancellation policy pages.
5. Revisit SerpApi's 250/month cap (shared across the whole app, not
   per-user) and SQLite's lack of built-in backups now that it holds real
   paying customers' accounts.
6. Signup rate-limiting/anti-abuse (currently none).
7. Mobile responsiveness pass (currently desktop-first).
