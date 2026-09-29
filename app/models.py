from typing import Optional

from pydantic import BaseModel


class Listing(BaseModel):
    product_id: str
    title: str
    source: str  # retailer / store name
    price: float
    currency: str
    rating: Optional[float] = None
    review_count: Optional[int] = None
    product_url: str
    thumbnail_url: Optional[str] = None
    fetched_at: str  # ISO timestamp
    availability: str = "UNKNOWN"  # IN_STOCK | OUT_OF_STOCK | UNKNOWN


class AlternativeRecommendation(BaseModel):
    listing: Listing
    value_score: float
    reasoning: str


class ComparisonResult(BaseModel):
    query: str
    best_listing: Optional[Listing]
    other_listings: list[Listing]
    alternatives: list[AlternativeRecommendation]
    summary: str
    fetched_at: str
