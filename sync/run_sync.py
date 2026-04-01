"""
SDK Version Sync — entry point.

Flow:
  1. Gọi MCP tool game_list → filter ACTIVE/NOT_RELEASED → save sync/data/game_list.json
  2. Gọi MCP sdk_version_snapshot (không filter game) → save sync/data/snapshot_data.json
  3. Map & filter: loại bỏ records không có game_id trong game_list
  4. Upsert batch vào Supabase

Crontab ví dụ (chạy mỗi ngày lúc 6:00 AM):
    0 6 * * * cd /path/to/sync && python run_sync.py >> sync.log 2>&1
"""
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List

from dotenv import load_dotenv

load_dotenv()

from mcp_client import fetch_game_list, fetch_sdk_snapshot_all
from supabase_writer import upsert_batch

ERROR_THRESHOLD_PCT = float(os.getenv("ERROR_THRESHOLD_PCT", "20"))
DATA_DIR = Path(__file__).parent / "data"
GAME_LIST_FILE = DATA_DIR / "game_list.json"
SNAPSHOT_FILE  = DATA_DIR / "snapshot_data.json"


def _save_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def main():
    start = time.time()
    now_iso = datetime.now(timezone.utc).isoformat()

    # ── Bước 1: Lấy danh sách game từ MCP ────────────────────────────────────
    print("[sync] Bước 1: Lấy danh sách game từ MCP game_list...", flush=True)
    try:
        games = fetch_game_list()
    except Exception as exc:
        print(f"[sync] FATAL: Không lấy được game_list: {exc}", file=sys.stderr)
        sys.exit(1)

    if not games:
        print("[sync] Không có game nào với status ACTIVE/NOT_RELEASED.", flush=True)
        sys.exit(0)

    _save_json(GAME_LIST_FILE, {
        "synced_at": now_iso,
        "count": len(games),
        "games": games,
    })
    print(f"[sync] Tìm thấy {len(games)} games → {GAME_LIST_FILE}", flush=True)
    for g in games[:10]:
        print(f"  • {g['game_id']} — {g['product_name']}", flush=True)
    if len(games) > 10:
        print(f"  ... và {len(games) - 10} game khác", flush=True)

    # ── Bước 2: Lấy toàn bộ SDK snapshot từ MCP ──────────────────────────────
    print("\n[sync] Bước 2: Lấy toàn bộ SDK snapshot từ MCP...", flush=True)
    try:
        all_snapshots = fetch_sdk_snapshot_all()
    except Exception as exc:
        print(f"[sync] FATAL: Không lấy được sdk_version_snapshot: {exc}", file=sys.stderr)
        sys.exit(1)

    _save_json(SNAPSHOT_FILE, {
        "synced_at": now_iso,
        "count": len(all_snapshots),
        "records": all_snapshots,
    })
    print(f"[sync] Tổng {len(all_snapshots)} snapshot records → {SNAPSHOT_FILE}", flush=True)

    # ── Bước 3: Map & filter ──────────────────────────────────────────────────
    print("\n[sync] Bước 3: Map snapshot với game list...", flush=True)
    game_id_set: set = {g["game_id"] for g in games}
    product_name_map: Dict[str, str] = {g["game_id"]: g["product_name"] for g in games}

    matched: List[Dict] = []
    skipped_game_ids: set = set()
    for rec in all_snapshots:
        gid = str(rec.get("game_id") or "")
        if not gid or gid not in game_id_set:
            skipped_game_ids.add(gid or "(empty)")
            continue
        rec["product_name"] = product_name_map[gid]
        matched.append(rec)

    print(
        f"[sync] {len(matched)} records khớp game list "
        f"({len(all_snapshots) - len(matched)} loại bỏ — không trong ACTIVE/NOT_RELEASED)",
        flush=True,
    )

    # ── Bước 4: Upsert vào Supabase ───────────────────────────────────────────
    print("\n[sync] Bước 4: Upsert vào Supabase...", flush=True)
    if not matched:
        print("[sync] Không có records để upsert.", flush=True)
        sys.exit(0)

    try:
        upsert_batch(matched)
        print(f"[sync] Upserted {len(matched)} records vào Supabase.", flush=True)
    except Exception as exc:
        print(f"[sync] FATAL: Supabase upsert thất bại: {exc}", file=sys.stderr)
        sys.exit(1)

    elapsed = round(time.time() - start, 1)
    matched_games = len({r.get("game_id") for r in matched})
    print(
        f"\n[sync] ✅ Hoàn thành trong {elapsed}s — "
        f"{matched_games} games, {len(matched)} records upserted",
        flush=True,
    )
    sys.exit(0)


if __name__ == "__main__":
    main()
