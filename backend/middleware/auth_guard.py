"""
FastAPI dependency: require a valid session on protected routes.
Auto-refreshes access_token when near expiry.
"""
import time
from fastapi import Request, HTTPException

from backend.models.schemas import SessionData
from backend.services import session_store, oauth_service


async def require_session(request: Request) -> SessionData:
    session_id = request.cookies.get("session_id")
    session = session_store.get(session_id)

    if not session:
        raise HTTPException(status_code=401, detail="Not authenticated")

    # Refresh token if access_token expired or about to expire
    if session.expires_at < time.time():
        try:
            session = await oauth_service.refresh_access_token(session)
            session_store.update(session)
        except Exception:
            session_store.delete(session.session_id)
            raise HTTPException(status_code=401, detail="Session expired — please re-login")

    return session
