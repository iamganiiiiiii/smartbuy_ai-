from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app.agent.orchestrator import run_agent
from app.config import settings

app = FastAPI(title="SmartBuy AI")

# Wide open on purpose: this endpoint is unauthenticated, read-only price
# comparison with no cookies/session state, and is called from a separate
# frontend (a different dev-server origin, or a hosted preview) whose exact
# origin isn't known in advance.
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


@app.post("/api/search", response_model=SearchResponse)
async def search(req: SearchRequest):
    if not req.query.strip():
        raise HTTPException(400, "query must not be empty")
    if not settings.gemini_api_key:
        raise HTTPException(500, "GEMINI_API_KEY is not configured on the server")

    try:
        result = await run_agent(req.query)
    except Exception as exc:
        raise HTTPException(502, f"Assistant backend error: {exc}") from exc
    return SearchResponse(
        reply=result.final_text,
        best_listing=result.best_listing,
        other_listings=result.other_listings,
        alternatives=result.alternatives,
        trace=result.trace,
    )
