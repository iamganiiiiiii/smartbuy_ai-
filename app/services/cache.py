"""Tiny in-memory TTL cache for search results (stands in for Redis in this MVP).

Swap for a real Redis client later without touching callers - they only
use `get`/`set`.
"""

import time
from typing import Any

from app.config import settings


class TTLCache:
    def __init__(self, ttl_seconds: int | None = None):
        self.ttl_seconds = ttl_seconds or settings.cache_ttl_seconds
        self._store: dict[str, tuple[float, Any]] = {}

    def get(self, key: str) -> Any | None:
        entry = self._store.get(key)
        if not entry:
            return None
        expires_at, value = entry
        if time.time() > expires_at:
            del self._store[key]
            return None
        return value

    def set(self, key: str, value: Any) -> None:
        self._store[key] = (time.time() + self.ttl_seconds, value)


search_cache = TTLCache()
