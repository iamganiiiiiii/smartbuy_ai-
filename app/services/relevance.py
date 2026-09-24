"""Filters out listings that Google Shopping's fuzzy matching pulled in but
that aren't actually the product searched for (observed live: a query for
"Sony WH-1000XM5 headphones" also returned a MacBook Air, sunglasses, and a
smart display alongside real headphone listings).

Only used for the exact-product search_products tool - NOT for
find_alternatives, which deliberately wants different products in the same
category (that's the whole point of an "alternative").
"""

import re

_STOPWORDS = {
    "a", "an", "the", "for", "with", "in", "on", "of", "and", "or",
    "best", "price", "buy", "new", "cheap", "cheapest",
}

# A listing titled "iPhone 15 Pro Case" shares every token with a search for
# "iPhone 15 Pro" (including the model-number identifier "15") but is an
# accessory for the device, not the device - observed live. Reject any
# listing carrying one of these words unless the query itself asked for the
# accessory (e.g. a search that already says "case" or "cover").
_ACCESSORY_KEYWORDS = {
    "case", "cover", "skin", "sticker", "decal", "screen", "protector",
    "glass", "tempered", "charger", "cable", "adapter", "dock", "stand",
    "mount", "strap", "band", "holster", "sleeve", "pouch", "bumper",
}

# A real product listing can legitimately mention an accessory word as a
# bundled feature (e.g. "... Special Edition Soft Case Premium Noise
# Cancelling ... Headphones" - a carrying case included with the
# headphones, not a case product) - observed live. If the title also names
# the actual device category, that outweighs the accessory word instead of
# vetoing the whole listing.
_DEVICE_NOUNS = {
    "headphones", "headphone", "earbuds", "earbud", "earphones", "earphone",
    "smartphone", "mobile", "tablet", "laptop", "notebook", "smartwatch",
    "watch", "speaker", "television", "monitor", "camera", "console",
    "router", "printer", "keyboard", "mouse", "vacuum", "mixer", "blender",
    "refrigerator", "microwave", "oven", "kettle", "shoes", "sneakers",
    "sandals", "backpack",
}


def _tokens(text: str) -> set[str]:
    return {t for t in re.findall(r"[a-z0-9]+", text.lower()) if t not in _STOPWORDS and len(t) > 1}


def _is_weak_identifier(token: str) -> bool:
    """A bare short number ("15", "141") is too common across unrelated model
    names (iPhone 15 vs. a Reno15, Airdopes 141 vs. a listing that happens to
    contain "1415") to trust as a substring match anywhere inside a title
    token - unlike a richer identifier like "1000xm5" or "128gb", it must
    appear as its own token, not merely be swallowed inside a longer one."""
    return token.isdigit() and len(token) <= 3


def filter_same_product(query: str, listings: list) -> list:
    """Keeps only listings whose title plausibly refers to the same product
    as the query - not just the same category, and not an accessory for it."""
    query_tokens = _tokens(query)
    identifier_tokens = {t for t in query_tokens if any(c.isdigit() for c in t)}
    query_wants_accessory = bool(query_tokens & _ACCESSORY_KEYWORDS)

    if not query_tokens:
        return listings

    kept = []
    for listing in listings:
        title_tokens = _tokens(listing.title)

        is_accessory_listing = (
            not query_wants_accessory
            and (title_tokens & _ACCESSORY_KEYWORDS)
            and not (title_tokens & _DEVICE_NOUNS)
        )
        if is_accessory_listing:
            continue

        if identifier_tokens:
            # A model number / storage size / year in the query (e.g. "wh-1000xm5",
            # "128gb") is the strongest signal - the title must carry it too.
            # Substring match, not exact token equality: real listings often
            # append a suffix to the model number (e.g. "wh-1000xm5sa" for a
            # special-edition variant of "wh-1000xm5").
            def _identifier_matches(ident: str) -> bool:
                if _is_weak_identifier(ident):
                    return ident in title_tokens
                return any(ident in tt for tt in title_tokens)

            if all(_identifier_matches(ident) for ident in identifier_tokens):
                kept.append(listing)
            continue

        overlap = query_tokens & title_tokens
        if len(overlap) >= max(1, len(query_tokens) // 2):
            kept.append(listing)

    return kept
