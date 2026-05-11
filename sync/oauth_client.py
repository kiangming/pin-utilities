"""
OAuth 2.0 Client Credentials helper cho MCP gateway.

Cache access_token trong memory, tự refresh khi sắp hết hạn.
Đơn process (sync script), không cần thread-safe.
"""
import os
import time
from typing import Optional

import httpx

TOKEN_URL = os.getenv("MCP_OAUTH_TOKEN_URL", "")
CLIENT_ID = os.getenv("MCP_OAUTH_CLIENT_ID", "")
CLIENT_SECRET = os.getenv("MCP_OAUTH_CLIENT_SECRET", "")
TOKEN_TIMEOUT = int(os.getenv("MCP_OAUTH_TIMEOUT_SECONDS", "15"))

# Refresh sớm 60s trước khi token hết hạn để tránh race với clock skew
_REFRESH_BUFFER_SEC = 60

_access_token: Optional[str] = None
_expires_at: float = 0.0


def _fetch_new_token() -> None:
    """POST /token với client_credentials grant, cache access_token + expires_at."""
    global _access_token, _expires_at
    if not (TOKEN_URL and CLIENT_ID and CLIENT_SECRET):
        raise RuntimeError(
            "OAuth credentials chưa cấu hình: cần MCP_OAUTH_TOKEN_URL, "
            "MCP_OAUTH_CLIENT_ID, MCP_OAUTH_CLIENT_SECRET trong .env"
        )

    with httpx.Client(timeout=TOKEN_TIMEOUT) as client:
        resp = client.post(
            TOKEN_URL,
            data={
                "grant_type": "client_credentials",
                "client_id": CLIENT_ID,
                "client_secret": CLIENT_SECRET,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    if resp.status_code >= 400:
        raise RuntimeError(
            f"OAuth token request failed: HTTP {resp.status_code} — {resp.text[:300]}"
        )

    body = resp.json()
    token = body.get("access_token")
    if not token:
        raise RuntimeError(f"OAuth response thiếu access_token: {body}")

    _access_token = token
    _expires_at = time.time() + int(body.get("expires_in", 3600))


def get_token() -> str:
    """Trả về access_token còn hạn. Refresh tự động nếu sắp hết hạn."""
    if not _access_token or time.time() >= _expires_at - _REFRESH_BUFFER_SEC:
        _fetch_new_token()
    return _access_token  # type: ignore[return-value]


def invalidate() -> None:
    """Xóa cache, force fetch token mới ở lần get_token() kế tiếp.
    Dùng khi MCP API trả 401 (token bị revoke giữa chừng)."""
    global _access_token, _expires_at
    _access_token = None
    _expires_at = 0.0
