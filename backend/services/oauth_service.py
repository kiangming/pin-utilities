"""
Google OAuth 2.0 Authorization Code Flow.
"""
import time
import secrets
import httpx
from urllib.parse import urlencode

from backend.config import (
    settings,
    GOOGLE_AUTH_URL,
    GOOGLE_TOKEN_URL,
    GOOGLE_USERINFO_URL,
    OAUTH_SCOPES,
)
from backend.models.schemas import SessionData, UserInfo


def build_auth_url(state: str) -> str:
    params = {
        "client_id": settings.google_client_id,
        "redirect_uri": settings.google_redirect_uri,
        "response_type": "code",
        "scope": " ".join(OAUTH_SCOPES),
        "access_type": "offline",   # request refresh_token
        "prompt": "consent",        # always show consent to get refresh_token
        "state": state,
    }
    return f"{GOOGLE_AUTH_URL}?{urlencode(params)}"


def generate_state() -> str:
    return secrets.token_urlsafe(32)


async def exchange_code(code: str) -> SessionData:
    async with httpx.AsyncClient() as client:
        token_resp = await client.post(
            GOOGLE_TOKEN_URL,
            data={
                "code": code,
                "client_id": settings.google_client_id,
                "client_secret": settings.google_client_secret,
                "redirect_uri": settings.google_redirect_uri,
                "grant_type": "authorization_code",
            },
        )
    token_resp.raise_for_status()
    tokens = token_resp.json()

    user = await _fetch_userinfo(tokens["access_token"])

    return SessionData(
        session_id="",   # filled by session_store.create()
        access_token=tokens["access_token"],
        refresh_token=tokens.get("refresh_token"),
        expires_at=time.time() + tokens.get("expires_in", 3600) - 60,
        user=user,
    )


async def refresh_access_token(session: SessionData) -> SessionData:
    if not session.refresh_token:
        raise ValueError("No refresh_token available — user must re-login")

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            GOOGLE_TOKEN_URL,
            data={
                "client_id": settings.google_client_id,
                "client_secret": settings.google_client_secret,
                "refresh_token": session.refresh_token,
                "grant_type": "refresh_token",
            },
        )
    resp.raise_for_status()
    tokens = resp.json()

    session.access_token = tokens["access_token"]
    session.expires_at = time.time() + tokens.get("expires_in", 3600) - 60
    return session


async def _fetch_userinfo(access_token: str) -> UserInfo:
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            GOOGLE_USERINFO_URL,
            headers={"Authorization": f"Bearer {access_token}"},
        )
    resp.raise_for_status()
    data = resp.json()
    return UserInfo(
        email=data["email"],
        name=data.get("name", data["email"]),
        picture=data.get("picture"),
    )
