"""Code-level guardrails that don't trust the model to enforce them on its own:
a stated budget is a hard filter, not a suggestion the model might respect,
and the model's final prose is spot-checked against real listing data rather
than taken on faith. See the guardrails design doc this was built against for
the full rationale - this module deliberately implements only the cheap,
concrete slice of it (price-ceiling filtering and price-grounding checks),
not a general hallucination detector.
"""

import re

from app.models import Listing

# Matches a currency symbol/code followed by a number, e.g. "₹1,299", "$49.99", "INR 500".
_PRICE_PATTERN = re.compile(r"(?:[₹$€£]|INR|USD|EUR|GBP)\s?([\d,]+(?:\.\d+)?)", re.IGNORECASE)


def filter_by_max_price(listings: list[Listing], max_price: float | None, max_price_currency: str | None) -> list[Listing]:
    """Drops listings priced above max_price - a hard constraint, not a hint to the LLM.

    Only filters listings whose currency matches max_price_currency (when given);
    a listing in a different currency is left alone rather than wrongly rejected
    on a currency mismatch. Full FX conversion is out of scope.
    """
    if max_price is None:
        return listings

    def _keep(listing: Listing) -> bool:
        if max_price_currency and listing.currency != max_price_currency:
            return True
        return listing.price <= max_price

    return [listing for listing in listings if _keep(listing)]


def check_output_grounding(final_text: str, known_prices: set[float]) -> list[str]:
    """Flags (does not block) prices mentioned in the model's free text that don't
    match any real listing price in scope - the cheapest, most checkable slice of
    'don't invent facts'. `known_prices` is every real price shown to the user this
    turn (best_listing/other_listings/alternatives), caller's responsibility to
    collect - kept decoupled from Listing/dict shape since orchestrator.py works
    with plain dicts, not Pydantic objects, by this point in the pipeline.
    Returns a list of flag descriptions, empty if clean.
    """
    if not final_text:
        return []

    flags = []
    for match in _PRICE_PATTERN.finditer(final_text):
        try:
            mentioned = round(float(match.group(1).replace(",", "")), 2)
        except ValueError:
            continue
        if not any(abs(mentioned - known) < 0.01 for known in known_prices):
            flags.append(f"output_grounding: price {match.group(0)!r} not found in any listing shown this turn")

    return flags
