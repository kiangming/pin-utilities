"""
PIN Utilities — FastAPI Backend
Usage:
    python -m uvicorn backend.main:app --reload --port 8080
"""
import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

from backend.config import settings
from backend.routers import auth, bootstrap, sheets
from backend.services import session_store

FRONTEND_DIR = Path(__file__).parent.parent / settings.frontend_dir


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: schedule periodic session cleanup
    task = asyncio.create_task(_purge_sessions_loop())
    yield
    task.cancel()


app = FastAPI(title="PIN Utilities API", lifespan=lifespan)

# CORS — chỉ cho localhost trong dev
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8080", "http://127.0.0.1:8080"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# API routers
app.include_router(auth.router)
app.include_router(bootstrap.router)
app.include_router(sheets.router)


# ── Frontend routes ────────────────────────────────────────────────────────────

@app.get("/login")
async def login_page():
    return FileResponse(FRONTEND_DIR / "login.html")


@app.get("/")
async def index(request: Request):
    # Nếu chưa có session → redirect về /login
    session_id = request.cookies.get("session_id")
    session = session_store.get(session_id)
    if not session:
        return RedirectResponse("/login")
    return FileResponse(FRONTEND_DIR / "index.html")


# Mount static assets (css, js) — sau các route cụ thể
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR)), name="static")


# ── Background tasks ──────────────────────────────────────────────────────────

async def _purge_sessions_loop():
    """Dọn file session hết hạn mỗi 1 giờ."""
    while True:
        await asyncio.sleep(3600)
        removed = session_store.purge_expired()
        if removed:
            print(f"[session] Purged {removed} expired session(s)")
