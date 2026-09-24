import os

from dotenv import load_dotenv

load_dotenv()


class Settings:
    gemini_api_key: str = os.getenv("GEMINI_API_KEY", "")
    gemini_model: str = os.getenv("GEMINI_MODEL", "gemini-3.1-flash-lite")

    serpapi_key: str = os.getenv("SERPAPI_KEY", "")

    search_country: str = os.getenv("SEARCH_COUNTRY", "in")
    search_language: str = os.getenv("SEARCH_LANGUAGE", "en")

    cache_ttl_seconds: int = int(os.getenv("CACHE_TTL_SECONDS", "1800"))


settings = Settings()
