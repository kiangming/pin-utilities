"""
Supabase writer — upsert sdk_version_snapshots via Supabase REST API.
Dùng httpx trực tiếp, không cần supabase-py.
"""
import os
from datetime import datetime, timezone
from typing import Dict, List

import httpx

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")
TABLE = "sdk_version_snapshots"

# Chỉ giữ các cột tồn tại trong bảng
ALLOWED_COLUMNS = {
    "game_id", "platform", "product_name",
    "latest_version", "latest_version_records", "latest_version_share_ratio",
    "stable_version", "stable_version_share_ratio",
    "latest_date", "updated_time", "synced_at",
}


def _headers() -> Dict:
    return {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        # merge-duplicates: upsert dựa trên UNIQUE(game_id, platform)
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }


def upsert_batch(records: List[Dict]) -> None:
    """
    Upsert danh sách records vào sdk_version_snapshots.
    Mỗi record phải có game_id và platform.
    """
    if not records:
        return

    # Filter chỉ giữ cột hợp lệ + thêm synced_at
    now = datetime.now(timezone.utc).isoformat()
    cleaned = [
        {k: v for k, v in {**r, "synced_at": now}.items() if k in ALLOWED_COLUMNS}
        for r in records
    ]

    # Deduplicate theo (game_id, platform) — giữ record cuối cùng
    seen: Dict = {}
    for row in cleaned:
        key = (row.get("game_id"), row.get("platform"))
        seen[key] = row
    rows = list(seen.values())

    url = f"{SUPABASE_URL}/rest/v1/{TABLE}?on_conflict=game_id,platform"
    with httpx.Client(timeout=30) as client:
        resp = client.post(url, headers=_headers(), json=rows)
        if not resp.is_success:
            print(f"[supabase] {resp.status_code} — {resp.text}", flush=True)
        resp.raise_for_status()
