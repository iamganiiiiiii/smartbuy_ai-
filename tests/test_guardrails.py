"""Unit tests for code-level guardrails - no network needed."""

from app.guardrails import check_output_grounding, filter_by_max_price
from app.models import Listing


def _listing(product_id, price, currency="INR"):
    return Listing(
        product_id=product_id,
        title=f"Product {product_id}",
        source="TestStore",
        price=price,
        currency=currency,
        product_url=f"https://example.com/{product_id}",
        fetched_at="2026-01-01T00:00:00Z",
    )


def test_filter_by_max_price_drops_over_budget():
    listings = [_listing("a", 100), _listing("b", 300), _listing("c", 250)]
    result = filter_by_max_price(listings, 250, "INR")
    assert {l.product_id for l in result} == {"a", "c"}


def test_filter_by_max_price_none_returns_everything():
    listings = [_listing("a", 100), _listing("b", 300)]
    assert filter_by_max_price(listings, None, None) == listings


def test_filter_by_max_price_all_over_budget_returns_empty():
    listings = [_listing("a", 500), _listing("b", 600)]
    assert filter_by_max_price(listings, 100, "INR") == []


def test_filter_by_max_price_leaves_mismatched_currency_alone():
    listings = [_listing("a", 500, currency="USD")]
    # A 500 USD listing isn't wrongly rejected just because the budget was stated in INR.
    assert filter_by_max_price(listings, 100, "INR") == listings


def test_check_output_grounding_clean_text_has_no_flags():
    text = "The best price is ₹1,299 from TestStore."
    assert check_output_grounding(text, {1299.0}) == []


def test_check_output_grounding_flags_unmatched_price():
    text = "The best price is ₹999 from TestStore."
    flags = check_output_grounding(text, {1299.0})
    assert len(flags) == 1
    assert "999" in flags[0]


def test_check_output_grounding_empty_text_has_no_flags():
    assert check_output_grounding("", {1299.0}) == []
