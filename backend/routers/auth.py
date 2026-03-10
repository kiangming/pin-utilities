"""
Auth router: Google OAuth 2.0 Authorization Code Flow.

Routes:
  GET  /auth/login     → redirect to Google consent screen
  GET  /auth/callback  → exchange code, create session, redirect to /
  POST /auth/logout    → delete session, redirect to /login
  GET  /auth/me        → return current user info (JSON)
"""
import time
from fastapi import APIRouter, Request, Depends, HTTPException
from fastapi.responses import RedirectResponse, JSONResponse

from backend.config import settings
from backend.models.schemas import SessionData
from backend.middleware.auth_guard import require_session
from backend.services import session_store, oauth_service

router = APIRouter(prefix="/auth", tags=["auth"])

# In-memory state store (CSRF protection). {state: expiry_ts}
_pending_states: dict[str, float] = {}
_STATE_TTL = 300  # 5 minutes


@router.get("/login")
async def login(request: Request):
    state = oauth_service.generate_state()
    _pending_states[state] = time.time() + _STATE_TTL
    _cleanup_states()
    auth_url = oauth_service.build_auth_url(state)
    return RedirectResponse(auth_url)


@router.get("/callback")
async def callback(request: Request, code: str = "", state: str = "", error: str = ""):
    if error:
        return RedirectResponse(f"/login?error={error}")

    # Validate state (CSRF)
    expiry = _pending_states.pop(state, None)
    if not expiry or expiry < time.time():
        raise HTTPException(400, "Invalid or expired state parameter")

    try:
        session_data = await oauth_service.exchange_code(code)
    except Exception as e:
        return RedirectResponse(f"/login?error=oauth_failed")

    data = session_data.model_dump()
    session_id = session_store.create(data)

    response = RedirectResponse("/")
    response.set_cookie(
        key="session_id",
        value=session_id,
        httponly=True,
        samesite="lax",
        max_age=settings.session_ttl_seconds,
    )
    return response


@router.post("/logout")
async def logout(request: Request):
    session_id = request.cookies.get("session_id")
    if session_id:
        session_store.delete(session_id)
    response = RedirectResponse("/login", status_code=302)
    response.delete_cookie("session_id")
    return response


@router.get("/me")
async def me(session: SessionData = Depends(require_session)):
    return JSONResponse(session.user.model_dump())


def _cleanup_states():
    now = time.time()
    expired = [s for s, exp in _pending_states.items() if exp < now]
    for s in expired:
        del _pending_states[s]
