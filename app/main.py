import json
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app import db
from app.agent.orchestrator import run_agent
from app.auth import get_current_user
from app.auth_routes import router as auth_router
from app.billing import router as billing_router
from app.config import settings

db.init_db()

app = FastAPI(title="SmartBuy AI")
app.include_router(auth_router)
app.include_router(billing_router)

# Wide open on purpose: auth is a Bearer token in a header, not a cookie, so
# there's no ambient credential for a foreign origin to ride along with -
# and the app is called from a separate frontend (a different dev-server
# origin, or a hosted preview) whose exact origin isn't known in advance.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


class SearchRequest(BaseModel):
    query: str


class SearchResponse(BaseModel):
    reply: str
    best_listing: dict | None
    other_listings: list[dict]
    alternatives: list[dict]
    trace: list[dict]


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "serpapi_configured": bool(settings.serpapi_key),
        "gemini_configured": bool(settings.gemini_api_key),
    }


MAX_QUERY_LENGTH = 300


@app.post("/api/search", response_model=SearchResponse)
async def search(req: SearchRequest, user=Depends(get_current_user)):
    query = req.query.strip()
    if not query:
        raise HTTPException(400, "query must not be empty")
    if len(query) > MAX_QUERY_LENGTH:
        raise HTTPException(400, f"query must be {MAX_QUERY_LENGTH} characters or fewer")
    if not settings.gemini_api_key:
        raise HTTPException(500, "GEMINI_API_KEY is not configured on the server")

    # Consumed before run_agent() so a request that fails downstream still
    # spends the user's trial - the Gemini/SerpApi cost is incurred either way.
    if not db.try_consume_access(user["id"], settings.free_trial_limit):
        raise HTTPException(402, "Free trial used up. Please subscribe to continue.")

    try:
        result = await run_agent(query)
    except Exception as exc:
        raise HTTPException(502, f"Assistant backend error: {exc}") from exc

    db.log_audit_event(
        user["id"],
        query,
        "search",
        json.dumps({"flags": result.flags, "had_best_listing": result.best_listing is not None}),
    )
    return SearchResponse(
        reply=result.final_text,
        best_listing=result.best_listing,
        other_listings=result.other_listings,
        alternatives=result.alternatives,
        trace=result.trace,
    )
