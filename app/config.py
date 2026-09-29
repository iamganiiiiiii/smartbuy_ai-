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

    db_path: str = os.getenv("DB_PATH", "app/data/smartbuy.db")
    free_trial_limit: int = int(os.getenv("FREE_TRIAL_LIMIT", "5"))

    razorpay_key_id: str = os.getenv("RAZORPAY_KEY_ID", "")
    razorpay_key_secret: str = os.getenv("RAZORPAY_KEY_SECRET", "")
    razorpay_webhook_secret: str = os.getenv("RAZORPAY_WEBHOOK_SECRET", "")
    razorpay_plan_id: str = os.getenv("RAZORPAY_PLAN_ID", "")
    subscription_price_label: str = os.getenv("SUBSCRIPTION_PRICE_LABEL", "₹50/month")

    resend_api_key: str = os.getenv("RESEND_API_KEY", "")
    email_from: str = os.getenv("EMAIL_FROM", "SmartBuy AI <onboarding@resend.dev>")
    # Where the frontend is served - embedded in password-reset email links.
    # Update this once the app has a real deployed URL.
    frontend_url: str = os.getenv("FRONTEND_URL", "http://127.0.0.1:5180")


settings = Settings()
