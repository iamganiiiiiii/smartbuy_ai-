# SmartBuy AI — Best Price & Best Value Finder

A working MVP of the agentic shopping assistant described in
`../PRD_Agentic_Shopping_App.md` and `../TRD_Agentic_Shopping_App.md`:
you type a product, a Gemini-powered agent calls a **real, live product
search API** (not mock data), picks the best real price, and surfaces
genuinely better alternatives within a budget band — with full reasoning
grounded in the actual data it fetched.

Runs entirely on **free, no-credit-card tiers**: Google Gemini API
(function calling, free via AI Studio) + SerpApi's Google Shopping engine
(250 free searches/month). No billing setup required anywhere.

**Scope note:** this build covers PRD sections 3.1–3.5 (search, price
aggregation, alternatives, comparison, transparency). It deliberately does
**not** implement the payment/checkout flow (PRD 4.4, FR11–14) — that needs
a PCI-DSS payment gateway account (Razorpay/Stripe) you don't have yet.
Right now, "book/purchase" just hands the user the real `product_url` to
buy directly from the seller. Wire in checkout once you have gateway
sandbox keys — the `Order`/`SavedPaymentMethod` entities from the TRD slot
in without changing anything here.

## Setup

```bash
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt   # Windows
# source .venv/bin/activate && pip install -r requirements.txt   # macOS/Linux

copy .env.example .env
```

Then fill in `.env` — both are genuinely free, no credit card needed:

1. **`GEMINI_API_KEY`** — go to https://aistudio.google.com/apikey, sign in
   with a Google account, click "Create API key".
2. **`SERPAPI_KEY`** — this is the "real API" piece:
   - Create a free account at https://serpapi.com/users/sign_up
   - Your key is on your dashboard: https://serpapi.com/manage-api-key
   - Free plan: 250 searches/month, real Google Shopping data aggregated
     across Amazon, Flipkart, Walmart, etc.

Run it:

```bash
# CLI, one query, full trace
.venv\Scripts\python.exe scripts\run_search.py "Sony WH-1000XM5 headphones"

# Web app
.venv\Scripts\python.exe -m uvicorn app.main:app --reload
# open http://127.0.0.1:8000
```

Run the offline tests (no API key needed — these don't touch the network):

```bash
.venv\Scripts\python.exe -m pytest tests\ -v
```

All 14 currently pass — they pin down price parsing and the ranking math,
not the live API call itself.

## Why it's built this way

This follows the same process as the generic agent-building README that
was in this folder before the real spec was found — worth restating here
since it's the actual design discipline, not boilerplate:

1. **Two hard outcomes, not vibes.** Every search ends in exactly one of:
   a grounded comparison, or a clarifying question (ambiguous product).
   `app/agent/prompts.py` rule 1–3 exist to enforce that.
2. **What the model can't be trusted to know becomes a tool, not prompt
   text.** Prices and specs live in `app/services/product_api.py`
   (real API) and `app/services/ranking.py` (real math) — never typed
   into the prompt where the model could misremember a number.
3. **Blast radius decides what's a hard rule.** A wrong price or
   fabricated alternative is the one thing this app must never do
   (PRD 3.5) — that's rule 1 and rule 4 in `prompts.py`, not "use good
   judgment."
4. **"Done" is a function call.** The agent's turn ends when it produces
   grounded text from real tool results, not when it "feels helpful."
5. **No eval suite yet** — because there's no live API key in this
   environment to run one against. Once you add real keys: run
   `scripts/run_search.py` against a handful of realistic queries (exact
   product, ambiguous product, nonexistent product, angry/urgent
   phrasing), read the trace, and for every real failure add exactly one
   rule to `prompts.py` (bump `PROMPT_V2` to `V3`) — the same
   read-the-trace-then-add-one-rule loop the original README taught.
   Don't pre-write rules for failures you haven't seen yet.

## Architecture (maps to TRD section 2)

```
Client (static/index.html + app.js)
  -> POST /api/search  (app/main.py, FastAPI)
    -> Agent Orchestrator (app/agent/orchestrator.py)
       Gemini function-calling loop, MAX_TURNS=6, every tool result fed back
       -> search_products tool -> app/services/product_api.py
            real HTTP call to SerpApi's Google Shopping engine
            -> app/services/cache.py (15-60 min TTL, in-memory - swap for
               Redis later without touching callers)
       -> find_alternatives tool -> app/services/ranking.py
            rule-based value-score (price/rating/reviews weighted by
            category, app/category_weights.json) within +/-15% budget band
    <- grounded reply + full trace
```

## If listings come back empty/wrong after you add a key

The SerpApi response shape assumed in
`app/services/product_api.py::_parse_listing()` is based on that API's
publicly documented `google_shopping` engine schema, but third-party API
schemas do drift. Run one query and look at the raw JSON on your SerpApi
dashboard, compare it to that one function, and adjust field names there —
everything downstream (ranking, agent, UI) only talks to the internal
`Listing` model in `app/models.py`, so a schema fix never has to ripple past
that one function. `tests/test_product_api.py` pins the expected shape —
update those fixtures alongside any fix.

Also note the free SerpApi plan's 250 searches/month cap: each user query
can cost 1–2 searches (search_products + find_alternatives), and the
15–30 minute cache absorbs repeat queries, but heavy testing will burn
through it faster than you'd expect.

## What to build next (from the PRD/TRD, in order)

1. Run real queries, harden `prompts.py` from actual failures (see above).
2. Budget-based search (FR7 — "I have ₹50,000, suggest a laptop") — needs
   `find_alternatives` to be callable without a `search_products` call first.
3. Saved comparisons (FR8) — needs a real DB; currently nothing persists
   between requests.
4. Checkout flow (PRD 4.4) once you have a payment gateway sandbox account.
5. Move the in-memory cache to Redis before this sees real concurrent traffic.
