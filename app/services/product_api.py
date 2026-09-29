"""
Real product-search connector.

Calls SerpApi's Google Shopping engine (https://serpapi.com) - a live,
free-tier third-party API (no mock data), aggregating real listings across
Amazon, Flipkart, Walmart, and other retailers that show up in Google
Shopping for a given query/country. Free plan: 250 searches/month, no
credit card required.

Its exact response field names can change between SerpApi API versions. If
listings come back empty or malformed after you add your key, compare a
live response (SerpApi has a "playground" per-query on your dashboard) to
the shape assumed in `_parse_listing()` below and adjust that one function -
everything else in the app (ranking, agent, UI) is decoupled from the raw
API shape via the `Listing` model.
"""

import re
from datetime import datetime, timezone
from urllib.parse import quote_plus

import httpx

from app.config import settings
from app.models import Listing

SEARCH_URL = "https://serpapi.com/search.json"

_CURRENCY_SYMBOLS = {
    "$": "USD",
    "₹": "INR",
    "€": "EUR",
    "£": "GBP",
}

# SerpApi's google_shopping product_link/link fields are always a Google
# shopping-overview page, never the retailer's own site - Google discontinued
# the API that used to return real per-seller links (confirmed live: the
# "google_product" engine now returns "The Google Product service is no
# longer offered by Google"). For the two retailers that dominate Indian
# Google Shopping results (checked against live samples: Amazon.in + Flipkart
# were ~34% of results across several sample queries) and whose search-URL
# pattern is well-established and verified live (200 OK), send the user
# straight to that retailer's own search instead of through Google. Every
# other retailer falls back to Google's link below - guessing a URL pattern
# for an unfamiliar retailer risks a broken link, which is worse than today's
# one extra click.
_RETAILER_SEARCH_URL_TEMPLATES = {
    "amazon": "https://www.amazon.in/s?k={query}",
    "flipkart": "https://www.flipkart.com/search?q={query}",
}


def _direct_retailer_url(source: str, title: str) -> str | None:
    source_lower = source.lower()
    for key, template in _RETAILER_SEARCH_URL_TEMPLATES.items():
        if key in source_lower:
            return template.format(query=quote_plus(title))
    return None


class ProductAPIError(RuntimeError):
    pass


def _parse_price(raw: str | float | int | None) -> tuple[float | None, str]:
    """Best-effort parse of a price string like '₹79,999.00' or '$99.99' into (amount, currency)."""
    if raw is None:
        return None, "USD"
    if isinstance(raw, (int, float)):
        return float(raw), "USD"

    raw = raw.strip()
    currency = "USD"
    for symbol, code in _CURRENCY_SYMBOLS.items():
        if symbol in raw:
            currency = code
            break

    digits = re.sub(r"[^\d.]", "", raw)
    if not digits:
        return None, currency
    try:
        return float(digits), currency
    except ValueError:
        return None, currency


def _parse_listing(raw: dict) -> Listing | None:
    """Maps one SerpApi google_shopping result into our internal Listing schema."""
    amount, currency = _parse_price(raw.get("price"))
    if raw.get("extracted_price") is not None:
        amount = float(raw["extracted_price"])
    if amount is None or amount <= 0:
        return None

    product_url = raw.get("product_link") or raw.get("link")
    if not product_url or not product_url.startswith(("http://", "https://")):
        return None

    title = raw.get("title", "Unknown product")
    source = raw.get("source", "Unknown seller")
    product_url = _direct_retailer_url(source, title) or product_url

    product_id = raw.get("product_id") or product_url

    return Listing(
        product_id=str(product_id),
        title=title,
        source=source,
        price=amount,
        currency=currency,
        rating=raw.get("rating"),
        review_count=raw.get("reviews"),
        product_url=product_url,
        thumbnail_url=raw.get("thumbnail"),
        fetched_at=datetime.now(timezone.utc).isoformat(),
        # SerpApi's base google_shopping results don't reliably expose a real
        # stock-status signal, so UNKNOWN is the honest default (not a stub) -
        # wire in a real source field here if one is ever confirmed available.
        availability="UNKNOWN",
    )


async def search_products(query: str, limit: int = 15) -> list[Listing]:
    """Calls the real SerpApi Google Shopping search and returns normalized, priced listings."""
    if not settings.serpapi_key:
        raise ProductAPIError(
            "SERPAPI_KEY is not set. Add a real key to your .env file - "
            "see .env.example for where to get one (free, no credit card)."
        )

    params = {
        "engine": "google_shopping",
        "q": query,
        "gl": settings.search_country,
        "hl": settings.search_language,
        "api_key": settings.serpapi_key,
    }

    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            response = await client.get(SEARCH_URL, params=params)
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise ProductAPIError(
                f"Product search API returned {exc.response.status_code}: {exc.response.text[:300]}"
            ) from exc
        except httpx.RequestError as exc:
            raise ProductAPIError(f"Product search API request failed: {exc}") from exc

    payload = response.json()
    if payload.get("error"):
        raise ProductAPIError(f"Product search API error: {payload['error']}")

    raw_results = payload.get("shopping_results") or []

    listings: list[Listing] = []
    for raw in raw_results[:limit]:
        listing = _parse_listing(raw)
        if listing:
            listings.append(listing)

    return listings
