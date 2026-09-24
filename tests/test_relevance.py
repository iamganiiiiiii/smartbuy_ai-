"""Unit tests for the same-product relevance filter - no network needed.
Fixtures below mirror an actual live SerpApi response for "Sony WH-1000XM5
headphones" that included a MacBook Air, sunglasses, and a smart display."""

from app.models import Listing
from app.services.relevance import filter_same_product


def _listing(title, product_id=None):
    return Listing(
        product_id=product_id or title,
        title=title,
        source="TestStore",
        price=100,
        currency="INR",
        product_url=f"https://example.com/{title}",
        fetched_at="2026-01-01T00:00:00Z",
    )


def test_filters_out_unrelated_products_by_model_number():
    query = "Sony WH-1000XM5 headphones"
    listings = [
        _listing("Sony WH-1000XM5SA Special Edition Soft Case Noise Cancelling Headphones"),
        _listing("JBL Club One Wireless Headphones"),
        _listing("Michael Kors MK2205 Montecito"),
        _listing("Apple MacBook Air"),
        _listing("Amazon Echo Show 5 Smart display with Alexa"),
    ]
    kept = filter_same_product(query, listings)
    titles = [l.title for l in kept]
    assert "Sony WH-1000XM5SA Special Edition Soft Case Noise Cancelling Headphones" in titles
    assert "Apple MacBook Air" not in titles
    assert "Michael Kors MK2205 Montecito" not in titles
    assert "Amazon Echo Show 5 Smart display with Alexa" not in titles


def test_no_identifier_falls_back_to_token_overlap():
    query = "wireless mouse"
    listings = [
        _listing("Logitech Wireless Mouse M185"),
        _listing("Apple MacBook Air"),
    ]
    kept = filter_same_product(query, listings)
    titles = [l.title for l in kept]
    assert "Logitech Wireless Mouse M185" in titles
    assert "Apple MacBook Air" not in titles


def test_empty_query_keeps_everything():
    listings = [_listing("Anything")]
    assert filter_same_product("", listings) == listings
