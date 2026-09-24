"""Pure unit tests for price/listing parsing - no network, no API key needed.
These pin down the assumed SerpApi google_shopping response shape so a
schema change shows up as a failing test instead of a silent bad parse in
production."""

from app.services.product_api import _parse_listing, _parse_price


def test_parse_price_dollar():
    assert _parse_price("$99.99") == (99.99, "USD")


def test_parse_price_rupee_with_commas():
    assert _parse_price("₹79,999.00") == (79999.0, "INR")


def test_parse_price_plain_number():
    amount, currency = _parse_price(1499)
    assert amount == 1499.0


def test_parse_price_none():
    assert _parse_price(None) == (None, "USD")


def test_parse_listing_happy_path():
    raw = {
        "product_id": "abc123",
        "title": "Sony WH-1000XM5",
        "product_link": "https://example.com/product/abc123",
        "link": "https://www.google.com/shopping/product/abc123",
        "thumbnail": "https://example.com/photo.jpg",
        "rating": 4.6,
        "reviews": 12000,
        "price": "$348.00",
        "extracted_price": 348.0,
        "source": "Amazon",
    }
    listing = _parse_listing(raw)
    assert listing is not None
    assert listing.price == 348.0
    assert listing.currency == "USD"
    assert listing.source == "Amazon"
    assert listing.thumbnail_url == "https://example.com/photo.jpg"
    assert listing.product_url == "https://example.com/product/abc123"


def test_parse_listing_falls_back_to_link_when_no_product_link():
    raw = {"product_id": "x", "price": "$10", "link": "https://www.google.com/shopping/product/x"}
    listing = _parse_listing(raw)
    assert listing is not None
    assert listing.product_url == "https://www.google.com/shopping/product/x"


def test_parse_listing_missing_price_is_dropped():
    raw = {"product_id": "no-price", "product_link": "https://example.com/x"}
    assert _parse_listing(raw) is None


def test_parse_listing_missing_url_is_dropped():
    raw = {"product_id": "no-url", "price": "$10"}
    assert _parse_listing(raw) is None
