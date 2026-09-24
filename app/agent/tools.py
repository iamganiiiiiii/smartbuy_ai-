"""Tool schemas (what the model sees) paired with their dispatch functions
(what actually runs), kept in one file so they can't drift apart - the
schema/function split is the whole point: swap the function bodies for a
different backend later and the model-facing contract never changes.

Two tools, matching the TRD's agent workflow:
- search_products: real call to the product-search API (app/services/product_api.py),
  cached for CACHE_TTL_SECONDS, returns normalized listings + the best (lowest
  effective price) one already picked out - so the model never has to do
  price arithmetic itself.
- find_alternatives: searches the same category within a budget band of a
  reference price and returns only candidates that score higher on the
  rule-based value score (app/services/ranking.py) - "genuinely better",
  not just "different".
"""

from app.models import Listing
from app.services import product_api, ranking, relevance
from app.services.cache import search_cache

TOOL_SCHEMAS = [
    {
        "name": "search_products",
        "description": (
            "Search real, live retailer listings for a product. Returns normalized "
            "listings (price, currency, seller, rating, review count, URL, fetched_at) "
            "and the single best (lowest effective price) listing. Always call this "
            "before stating any price - never state a price from memory."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The product to search for, as specific as possible (include storage/size/color/model if the user gave it).",
                }
            },
            "required": ["query"],
        },
    },
    {
        "name": "find_alternatives",
        "description": (
            "Search for category-peer products within a budget band of a reference price "
            "and return only the ones that score higher on price/rating/reviews than the "
            "reference - i.e. genuine alternatives, not just similar products. Call this "
            "after search_products, using the category (e.g. 'wireless headphones', not the "
            "exact model) and the best_listing price/currency from search_products as the reference."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "category_query": {
                    "type": "string",
                    "description": "A category-level search query, e.g. 'noise cancelling headphones' rather than a specific model.",
                },
                "reference_price": {"type": "number"},
                "reference_currency": {"type": "string"},
                "reference_product_id": {
                    "type": "string",
                    "description": "product_id of the searched product's best_listing, so it doesn't get suggested as its own alternative.",
                },
            },
            "required": ["category_query", "reference_price", "reference_currency", "reference_product_id"],
        },
    },
]


async def dispatch(name: str, tool_input: dict) -> dict:
    if name == "search_products":
        return await _search_products(tool_input["query"])
    if name == "find_alternatives":
        return await _find_alternatives(tool_input)
    return {"error": f"Unknown tool: {name}"}


async def _search_products(query: str) -> dict:
    cache_key = f"search:{query.lower().strip()}"
    listings = search_cache.get(cache_key)
    if listings is None:
        try:
            listings = await product_api.search_products(query)
        except product_api.ProductAPIError as exc:
            return {"error": str(exc)}
        search_cache.set(cache_key, listings)

    # Google Shopping's fuzzy matching can return unrelated products alongside
    # real ones (observed live: a MacBook Air and sunglasses for a headphone
    # query) - drop anything that isn't plausibly the same product before
    # picking a "best" price, so a wrong/unrelated item never gets surfaced
    # as the answer.
    relevant = relevance.filter_same_product(query, listings)
    if not relevant and listings:
        return {
            "query": query,
            "listing_count": 0,
            "warning": (
                "No result closely matched this exact product - the retailer "
                "results returned were for different products entirely."
            ),
            "best_listing": None,
            "other_listings": [],
        }
    listings = relevant

    best = ranking.pick_best_listing(listings)
    others = [l for l in listings if best and l.product_id != best.product_id]
    others.sort(key=lambda l: l.price)
    return {
        "query": query,
        "listing_count": len(listings),
        "best_listing": best.model_dump() if best else None,
        "other_listings": [l.model_dump() for l in others][:9],
    }


async def _find_alternatives(tool_input: dict) -> dict:
    category_query = tool_input["category_query"]
    reference_price = tool_input["reference_price"]
    reference_currency = tool_input["reference_currency"]
    reference_product_id = tool_input["reference_product_id"]

    cache_key = f"search:{category_query.lower().strip()}"
    candidates = search_cache.get(cache_key)
    if candidates is None:
        try:
            candidates = await product_api.search_products(category_query)
        except product_api.ProductAPIError as exc:
            return {"error": str(exc)}
        search_cache.set(cache_key, candidates)

    reference = Listing(
        product_id=reference_product_id,
        title="(searched product)",
        source="",
        price=reference_price,
        currency=reference_currency,
        product_url="",
        fetched_at="",
    )

    alternatives = ranking.rank_alternatives(category_query, reference, candidates)
    return {
        "alternative_count": len(alternatives),
        "alternatives": [
            {
                "listing": a.listing.model_dump(),
                "value_score": a.value_score,
                "reasoning": a.reasoning,
            }
            for a in alternatives
        ],
    }
