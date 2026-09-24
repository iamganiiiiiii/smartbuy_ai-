"""Rule-based value-score ranker (TRD 4.1 step 5 / PRD 3.3).

Explainable by design: every score is a weighted blend of three signals
computed directly from real listing data (never invented), so the
reasoning text the agent produces can always point at a concrete number.
A learned ranking model can replace this later without changing its
interface (`rank_alternatives` in, `AlternativeRecommendation` out).
"""

import json
import math
from pathlib import Path

from app.models import AlternativeRecommendation, Listing

_WEIGHTS_PATH = Path(__file__).parent.parent / "category_weights.json"
_WEIGHTS = json.loads(_WEIGHTS_PATH.read_text())


def _weights_for(category_hint: str) -> dict:
    category_hint = category_hint.lower()
    for key, weights in _WEIGHTS.items():
        if key == "_comment":
            continue
        if key in category_hint:
            return weights
    return _WEIGHTS["default"]


def _score_one(listing: Listing, min_price: float, max_price: float, max_reviews: int, weights: dict) -> float:
    if max_price > min_price:
        price_score = (max_price - listing.price) / (max_price - min_price)
    else:
        price_score = 1.0

    rating_score = (listing.rating / 5.0) if listing.rating is not None else 0.5

    if max_reviews > 0 and listing.review_count:
        reviews_score = math.log1p(listing.review_count) / math.log1p(max_reviews)
    else:
        reviews_score = 0.5

    return round(
        weights["price"] * price_score
        + weights["rating"] * rating_score
        + weights["reviews"] * reviews_score,
        4,
    )


def pick_best_listing(listings: list[Listing]) -> Listing | None:
    """Lowest effective price wins - ties broken by rating."""
    if not listings:
        return None
    return sorted(listings, key=lambda l: (l.price, -(l.rating or 0)))[0]


def rank_alternatives(
    query: str,
    searched_listing: Listing,
    candidate_listings: list[Listing],
    budget_band_pct: float = 0.15,
    top_n: int = 3,
) -> list[AlternativeRecommendation]:
    """Scores category-peer candidates within +/- budget_band_pct of the searched product's
    best price, and returns the top_n as alternatives - only ones that are genuinely
    competitive, not padding (PRD 3.3: 'avoids noise')."""
    low = searched_listing.price * (1 - budget_band_pct)
    high = searched_listing.price * (1 + budget_band_pct)

    in_band = [c for c in candidate_listings if low <= c.price <= high and c.product_id != searched_listing.product_id]
    if not in_band:
        return []

    all_prices = [searched_listing.price] + [c.price for c in in_band]
    all_reviews = [c.review_count or 0 for c in in_band]
    min_price, max_price = min(all_prices), max(all_prices)
    max_reviews = max(all_reviews) if all_reviews else 0

    weights = _weights_for(query)

    searched_score = _score_one(searched_listing, min_price, max_price, max_reviews, weights)

    scored = []
    for candidate in in_band:
        score = _score_one(candidate, min_price, max_price, max_reviews, weights)
        if score <= searched_score:
            continue  # only surface alternatives that actually beat the searched product
        reasoning = _explain(candidate, searched_listing, score, searched_score)
        scored.append(AlternativeRecommendation(listing=candidate, value_score=score, reasoning=reasoning))

    scored.sort(key=lambda a: a.value_score, reverse=True)
    return scored[:top_n]


def _explain(candidate: Listing, searched: Listing, candidate_score: float, searched_score: float) -> str:
    price_diff = searched.price - candidate.price
    bits = []
    if price_diff > 0:
        bits.append(f"{price_diff:.0f} {searched.currency} cheaper")
    elif price_diff < 0:
        bits.append(f"only {-price_diff:.0f} {searched.currency} more")
    if candidate.rating and searched.rating and candidate.rating > searched.rating:
        bits.append(f"rated {candidate.rating} vs {searched.rating}")
    if candidate.review_count and searched.review_count and candidate.review_count > searched.review_count:
        bits.append(f"{candidate.review_count} reviews vs {searched.review_count}")
    detail = ", ".join(bits) if bits else "a better overall value score"
    return f"{candidate.title} scores {candidate_score:.2f} vs {searched_score:.2f} for the searched product - {detail}."
