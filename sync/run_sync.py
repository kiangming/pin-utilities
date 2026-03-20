"""
SDK Version Sync — entry point.

Flow:
  1. Gọi MCP tool game_list → lấy game_ids có status ACTIVE hoặc NOT_RELEASED
  2. Với mỗi game_id → gọi MCP sdk_version_snapshot
  3. Game không có data trong snapshot → bỏ qua (không lỗi)
  4. Upsert batch vào Supabase

Crontab ví dụ (chạy mỗi ngày lúc 6:00 AM):
    0 6 * * * cd /path/to/sync && python run_sync.py >> sync.log 2>&1
"""
import os
import sys
import time
from typing import Dict, List

from dotenv import load_dotenv

load_dotenv()

from mcp_client import fetch_game_list, fetch_sdk_snapshot
from supabase_writer import upsert_batch

ERROR_THRESHOLD_PCT = float(os.getenv("ERROR_THRESHOLD_PCT", "20"))


def main():
    start = time.time()

    # Bước 1: Lấy danh sách game từ MCP
    print("[sync] Đang lấy danh sách game từ MCP game_list...", flush=True)
    try:
        games = fetch_game_list()
    except Exception as exc:
        print(f"[sync] FATAL: Không lấy được game_list: {exc}", file=sys.stderr)
        sys.exit(1)

    if not games:
        print("[sync] Không có game nào với status ACTIVE/NOT_RELEASED.", flush=True)
        sys.exit(0)

    print(f"[sync] Tìm thấy {len(games)} games.", flush=True)
    for g in games[:10]:
        print(f"  • {g['game_id']} — {g['product_name']}", flush=True)
    if len(games) > 10:
        print(f"  ... và {len(games) - 10} game khác", flush=True)

    # Bước 2: Lấy SDK snapshot từng game
    all_records: List[Dict] = []
    errors: List[str] = []
    skipped: List[str] = []

    for g in games:
        game_id = g["game_id"]
        label = f"{game_id} ({g['product_name']})" if g["product_name"] else game_id
        try:
            records = fetch_sdk_snapshot(game_id)
            if not records:
                skipped.append(game_id)
                print(f"[sync] – {label}: không có data snapshot, bỏ qua", flush=True)
                continue
            product_name = g["product_name"]
            for rec in records:
                rec["product_name"] = product_name
            all_records.extend(records)
            print(f"[sync] ✓ {label}: {len(records)} records", flush=True)
        except Exception as exc:
            errors.append(game_id)
            print(f"[sync] ✗ {label}: {exc}", file=sys.stderr)

    # Bước 3: Upsert vào Supabase
    if all_records:
        try:
            upsert_batch(all_records)
            print(f"[sync] Upserted {len(all_records)} records vào Supabase", flush=True)
        except Exception as exc:
            print(f"[sync] FATAL: Supabase upsert thất bại: {exc}", file=sys.stderr)
            sys.exit(1)
    else:
        print("[sync] Không có records để upsert.", flush=True)

    elapsed = round(time.time() - start, 1)
    ok_count = len(games) - len(errors) - len(skipped)
    print(
        f"[sync] Hoàn thành trong {elapsed}s — "
        f"{ok_count} OK, {len(skipped)} bỏ qua (no data), {len(errors)} lỗi",
        flush=True,
    )

    if errors:
        print(f"[sync] Games lỗi: {', '.join(errors)}", file=sys.stderr)

    error_pct = len(errors) / len(games) * 100
    if error_pct > ERROR_THRESHOLD_PCT:
        print(
            f"[sync] ERROR: {error_pct:.0f}% games lỗi > threshold {ERROR_THRESHOLD_PCT}%",
            file=sys.stderr,
        )
        sys.exit(1)

    sys.exit(0)


if __name__ == "__main__":
    main()
