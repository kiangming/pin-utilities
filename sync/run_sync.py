"""
SDK Version Sync — entry point.

Cách dùng:
    python run_sync.py

Crontab ví dụ (chạy mỗi ngày lúc 6:00 AM):
    0 6 * * * cd /path/to/sync && python run_sync.py >> sync.log 2>&1
"""
import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

from mcp_client import fetch_sdk_snapshot
from supabase_writer import upsert_batch

PLATFORMS = [p.strip() for p in os.getenv("PLATFORMS", "android,ios,windows").split(",") if p.strip()]
ERROR_THRESHOLD_PCT = float(os.getenv("ERROR_THRESHOLD_PCT", "20"))


def load_game_ids(path: str = "game_ids.txt") -> list[str]:
    ids = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            ids.append(line)
    return ids


def sync_game(game_id: str) -> list[dict]:
    """Fetch tất cả platforms cho 1 game. Trả về list records."""
    records = fetch_sdk_snapshot(game_id)
    # Nếu API không hỗ trợ all-platforms trong 1 call, fetch từng platform
    if not records:
        records = []
        for platform in PLATFORMS:
            records.extend(fetch_sdk_snapshot(game_id, platform))
    return records


def main():
    start = time.time()
    game_ids = load_game_ids()
    if not game_ids:
        print("[sync] game_ids.txt trống — không có gì để sync.")
        sys.exit(0)

    print(f"[sync] Bắt đầu sync {len(game_ids)} games × platforms: {PLATFORMS}")

    all_records: list[dict] = []
    errors: list[str] = []

    for game_id in game_ids:
        try:
            records = sync_game(game_id)
            all_records.extend(records)
            print(f"[sync] ✓ {game_id}: {len(records)} records")
        except Exception as exc:
            errors.append(game_id)
            print(f"[sync] ✗ {game_id}: {exc}", file=sys.stderr)

    # Upsert batch
    if all_records:
        try:
            upsert_batch(all_records)
            print(f"[sync] Upserted {len(all_records)} records vào Supabase")
        except Exception as exc:
            print(f"[sync] FATAL: Supabase upsert thất bại: {exc}", file=sys.stderr)
            sys.exit(1)

    elapsed = round(time.time() - start, 1)
    error_pct = len(errors) / len(game_ids) * 100

    print(f"[sync] Hoàn thành trong {elapsed}s — "
          f"{len(game_ids) - len(errors)}/{len(game_ids)} OK, {len(errors)} lỗi")

    if errors:
        print(f"[sync] Games lỗi: {', '.join(errors)}", file=sys.stderr)

    if error_pct > ERROR_THRESHOLD_PCT:
        print(f"[sync] ERROR: {error_pct:.0f}% games lỗi > threshold {ERROR_THRESHOLD_PCT}%",
              file=sys.stderr)
        sys.exit(1)

    sys.exit(0)


if __name__ == "__main__":
    main()
