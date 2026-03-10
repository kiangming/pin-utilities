"""
File-based session store.
Each session is a JSON file in backend/sessions/{session_id}.json
"""
import json
import os
import time
import uuid
from pathlib import Path

from backend.models.schemas import SessionData

SESSIONS_DIR = Path(__file__).parent.parent / "sessions"


def _session_path(session_id: str) -> Path:
    return SESSIONS_DIR / f"{session_id}.json"


def create(data: dict) -> str:
    session_id = uuid.uuid4().hex
    SESSIONS_DIR.mkdir(exist_ok=True)
    _session_path(session_id).write_text(
        json.dumps({**data, "session_id": session_id}), encoding="utf-8"
    )
    return session_id


def get(session_id: str | None) -> SessionData | None:
    if not session_id:
        return None
    path = _session_path(session_id)
    if not path.exists():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return SessionData(**raw)
    except Exception:
        return None


def update(session: SessionData) -> None:
    path = _session_path(session.session_id)
    path.write_text(session.model_dump_json(), encoding="utf-8")


def delete(session_id: str) -> None:
    path = _session_path(session_id)
    if path.exists():
        path.unlink()


def purge_expired() -> int:
    """Remove expired session files. Returns count removed."""
    now = time.time()
    removed = 0
    for path in SESSIONS_DIR.glob("*.json"):
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            if raw.get("expires_at", 0) < now:
                path.unlink()
                removed += 1
        except Exception:
            pass
    return removed
