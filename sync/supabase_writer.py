"""
Supabase writer — upsert sdk_version_snapshots via Supabase REST API.
Dùng httpx trực tiếp, không cần supabase-py.
"""
import os
from datetime import datetime, timezone

import httpx

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")
TABLE = "sdk_version_snapshots"


def _headers() -> dict:
    return {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        # merge-duplicates: upsert dựa trên UNIQUE(game_id, platform)
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }


def upsert_batch(records: list[dict]) -> None:
    """
    Upsert danh sách records vào sdk_version_snapshots.
    Mỗi record phải có game_id và platform.
    """
    if not records:
        return

    # Thêm synced_at vào mỗi record
    now = datetime.now(timezone.utc).isoformat()
    rows = [{**r, "synced_at": now} for r in records]

    url = f"{SUPABASE_URL}/rest/v1/{TABLE}"
    with httpx.Client(timeout=30) as client:
        resp = client.post(url, headers=_headers(), json=rows)
        resp.raise_for_status()
