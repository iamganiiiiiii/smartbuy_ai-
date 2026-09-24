"""Unit tests for the rule-based value-score ranker - no network needed."""

from app.models import Listing
from app.services.ranking import pick_best_listing, rank_alternatives


def _listing(product_id, price, rating=4.0, reviews=100, currency="USD"):
    return Listing(
        product_id=product_id,
        title=f"Product {product_id}",
        source="TestStore",
        price=price,
        currency=currency,
        rating=rating,
        review_count=reviews,
        product_url=f"https://example.com/{product_id}",
        fetched_at="2026-01-01T00:00:00Z",
    )


def test_pick_best_listing_lowest_price_wins():
    listings = [_listing("a", 200), _listing("b", 150), _listing("c", 180)]
    assert pick_best_listing(listings).product_id == "b"


def test_pick_best_listing_empty_returns_none():
    assert pick_best_listing([]) is None


def test_rank_alternatives_filters_outside_budget_band():
    searched = _listing("searched", 100)
    candidates = [
        _listing("too_cheap", 50),  # outside -15% band
        _listing("too_expensive", 200),  # outside +15% band
        _listing("in_band_better", 95, rating=4.8, reviews=500),
    ]
    result = rank_alternatives("headphones", searched, candidates)
    ids = [a.listing.product_id for a in result]
    assert "too_cheap" not in ids
    assert "too_expensive" not in ids


def test_rank_alternatives_only_returns_genuinely_better():
    searched = _listing("searched", 100, rating=4.5, reviews=1000)
    worse_candidate = _listing("worse", 105, rating=3.5, reviews=10)
    better_candidate = _listing("better", 95, rating=4.8, reviews=2000)

    result = rank_alternatives("headphones", searched, [worse_candidate, better_candidate])
    ids = [a.listing.product_id for a in result]
    assert "better" in ids
    assert "worse" not in ids


def test_rank_alternatives_reasoning_cites_concrete_numbers():
    searched = _listing("searched", 100, rating=4.0, reviews=100)
    better = _listing("better", 90, rating=4.5, reviews=500)
    result = rank_alternatives("laptop", searched, [better])
    assert result
    assert "10" in result[0].reasoning  # price difference


def test_rank_alternatives_no_candidates_in_band_returns_empty():
    searched = _listing("searched", 100)
    result = rank_alternatives("headphones", searched, [_listing("far", 1000)])
    assert result == []
