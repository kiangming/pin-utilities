"""
SDK Version Service — đọc dữ liệu từ Supabase và tính toán summary/detail.
"""
from __future__ import annotations

import httpx

from backend.config import settings

TABLE = "sdk_version_snapshots"
SELECT_ALL = "game_id,platform,product_name,latest_version,latest_version_records,latest_version_share_ratio,stable_version,stable_version_share_ratio,latest_date,synced_at"


def _supabase_headers() -> dict:
    return {
        "apikey": settings.supabase_service_key,
        "Authorization": f"Bearer {settings.supabase_service_key}",
    }


def _supabase_url(path: str = "") -> str:
    return f"{settings.supabase_url.rstrip('/')}/rest/v1/{TABLE}{path}"


def fetch_all_snapshots() -> list[dict]:
    """Lấy tất cả records từ Supabase, sắp xếp theo game_id, platform."""
    if not settings.supabase_url or not settings.supabase_service_key:
        return []

    with httpx.Client(timeout=15) as client:
        resp = client.get(
            _supabase_url(),
            headers=_supabase_headers(),
            params={"select": SELECT_ALL, "order": "game_id.asc,platform.asc"},
        )
        resp.raise_for_status()
        return resp.json()


def _status(ratio: int | None) -> str:
    if ratio is None:
        return "unknown"
    if ratio >= settings.adoption_warn_threshold:
        return "ok"
    if ratio >= settings.adoption_critical_threshold:
        return "warn"
    return "critical"


def build_summary(snapshots: list[dict]) -> dict:
    """Tính KPI, version distribution, platform usage, mismatch list."""
    if not snapshots:
        return {"kpi": {}, "version_distribution": {}, "platform_usage": [], "mismatch_games": []}

    unique_games = set(s["game_id"] for s in snapshots if s.get("game_id"))
    total = len(unique_games)
    fully_updated = len(set(
        s["game_id"] for s in snapshots
        if s.get("game_id") and s.get("latest_version_share_ratio") == 100
    ))
    warn_count = len(set(
        s["game_id"] for s in snapshots
        if s.get("game_id") and _status(s.get("latest_version_share_ratio")) == "warn"
    ))
    critical_count = len(set(
        s["game_id"] for s in snapshots
        if s.get("game_id") and _status(s.get("latest_version_share_ratio")) == "critical"
    ))
    last_synced = max((s.get("synced_at") or "" for s in snapshots), default=None)

    # Version distribution per platform
    version_dist: dict[str, dict[str, int]] = {}
    for s in snapshots:
        p = s.get("platform", "")
        v = s.get("latest_version") or "unknown"
        version_dist.setdefault(p, {})
        version_dist[p][v] = version_dist[p].get(v, 0) + 1

    distribution: dict[str, list[dict]] = {}
    for platform, versions in version_dist.items():
        total_p = sum(versions.values())
        sorted_v = sorted(versions.items(), key=lambda x: -x[1])
        # Tìm version xuất hiện nhiều nhất → is_latest_dominant
        top_version = sorted_v[0][0] if sorted_v else None
        distribution[platform] = [
            {
                "version": v,
                "game_count": cnt,
                "pct": round(cnt / total_p * 100) if total_p else 0,
                "is_latest_dominant": v == top_version,
            }
            for v, cnt in sorted_v
        ]

    # Platform usage (tổng records)
    platform_records: dict[str, dict] = {}
    for s in snapshots:
        p = s.get("platform", "")
        rec = s.get("latest_version_records") or 0
        if p not in platform_records:
            platform_records[p] = {"total_records": 0, "game_count": 0}
        platform_records[p]["total_records"] += rec
        platform_records[p]["game_count"] += 1

    grand_total_records = sum(v["total_records"] for v in platform_records.values()) or 1
    platform_usage = sorted(
        [
            {
                "platform": p,
                "total_records": v["total_records"],
                "game_count": v["game_count"],
                "pct": round(v["total_records"] / grand_total_records * 100),
            }
            for p, v in platform_records.items()
        ],
        key=lambda x: -x["total_records"],
    )

    # Mismatch: latest ≠ stable
    mismatch = [
        {
            "game_id": s["game_id"],
            "platform": s["platform"],
            "latest_version": s.get("latest_version"),
            "stable_version": s.get("stable_version"),
            "latest_version_share_ratio": s.get("latest_version_share_ratio"),
            "stable_version_share_ratio": s.get("stable_version_share_ratio"),
        }
        for s in snapshots
        if s.get("latest_version") and s.get("stable_version")
        and s["latest_version"] != s["stable_version"]
    ]

    return {
        "kpi": {
            "total_games": total,
            "fully_updated": fully_updated,
            "warn_count": warn_count,
            "critical_count": critical_count,
            "last_synced": last_synced,
        },
        "version_distribution": distribution,
        "platform_usage": platform_usage,
        "mismatch_games": mismatch,
    }


def build_detail(
    snapshots: list[dict],
    platform: str = "",
    status_filter: str = "",
    search: str = "",
) -> dict:
    """Filter và enrich records cho Detail tab."""
    items = []
    for s in snapshots:
        ratio = s.get("latest_version_share_ratio")
        st = _status(ratio)

        if platform and s.get("platform") != platform:
            continue
        if status_filter and st != status_filter:
            continue
        q = search.lower()
        if search and q not in (s.get("game_id") or "").lower() and q not in (s.get("product_name") or "").lower():
            continue

        items.append({
            "game_id": s.get("game_id"),
            "product_name": s.get("product_name"),
            "platform": s.get("platform"),
            "latest_version": s.get("latest_version"),
            "latest_version_records": s.get("latest_version_records"),
            "latest_version_share_ratio": ratio,
            "stable_version": s.get("stable_version"),
            "stable_version_share_ratio": s.get("stable_version_share_ratio"),
            "version_mismatch": (
                s.get("latest_version") != s.get("stable_version")
                and bool(s.get("stable_version"))
            ),
            "status": st,
            "latest_date": s.get("latest_date"),
        })

    return {"items": items, "total": len(items)}
