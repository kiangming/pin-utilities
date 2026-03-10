"""
Google Sheets service: fetch + parse pipeline data.
Sử dụng access_token của user (OAuth user flow).
Có TTL cache theo tab.
"""
import re
import time
import httpx
from cachetools import TTLCache

from backend.config import settings

SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets"
FETCH_RANGE_ROWS = 300

TAB_NAMES = {
    "release2026": "List game release 2026",
    "release2025": "List game release 2025",
    "close2026":   "List game close 2026",
    "close2025":   "List game close 2025",
}

# Cache: key = "{sheet_id}:{tab_key}", value = parsed list
_cache: TTLCache = TTLCache(maxsize=20, ttl=settings.sheets_cache_ttl_seconds)


def extract_sheet_id(url_or_id: str) -> str:
    m = re.search(r"/d/([a-zA-Z0-9-_]+)", url_or_id)
    return m.group(1) if m else url_or_id.strip()


async def fetch_tab(sheet_url: str, tab_key: str, access_token: str, force: bool = False) -> list[dict]:
    """Fetch + parse 1 tab. Trả về list game objects."""
    if tab_key not in TAB_NAMES:
        raise ValueError(f"Unknown tab: {tab_key}")

    sheet_id = extract_sheet_id(sheet_url)
    cache_key = f"{sheet_id}:{tab_key}"

    if not force and cache_key in _cache:
        return _cache[cache_key]

    tab_name = TAB_NAMES[tab_key]
    rows = await _fetch_raw(sheet_id, tab_name, access_token)
    parsed = _parse_close(rows) if tab_key.startswith("close") else _parse_release(rows)

    _cache[cache_key] = parsed
    return parsed


async def fetch_all(sheet_url: str, access_token: str, force: bool = False) -> dict:
    """Fetch tất cả 4 tabs. Trả về dict với keys release2026/release2025/close2026/close2025."""
    result = {"fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "sheetUrl": sheet_url}
    for key in TAB_NAMES:
        result[key] = await fetch_tab(sheet_url, key, access_token, force)
    return result


def invalidate(sheet_url: str, tab_key: str | None = None):
    """Force-expire cache cho 1 tab hoặc tất cả tabs."""
    sheet_id = extract_sheet_id(sheet_url)
    if tab_key:
        _cache.pop(f"{sheet_id}:{tab_key}", None)
    else:
        for key in list(_cache.keys()):
            if key.startswith(f"{sheet_id}:"):
                del _cache[key]


# ── Internal helpers ──────────────────────────────────────────────────────────

async def _fetch_raw(sheet_id: str, tab_name: str, access_token: str) -> list[list]:
    range_param = f"'{tab_name}'!A1:P{FETCH_RANGE_ROWS}"
    url = f"{SHEETS_API}/{sheet_id}/values/{range_param}"
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(url, headers={"Authorization": f"Bearer {access_token}"})
    if resp.status_code == 401:
        raise PermissionError("AUTH_EXPIRED")
    resp.raise_for_status()
    return resp.json().get("values", [])


def _pd(v) -> str | None:
    """Parse date cell → ISO string | 'TBU' | 'No CBT' | None."""
    if not v or str(v).strip() in ("", "-"):
        return None
    s = str(v).strip()
    if s in ("TBU", "TBD"):
        return "TBU"
    if re.search(r"no.?cbt", s, re.IGNORECASE):
        return "No CBT"
    try:
        from datetime import datetime
        d = datetime.strptime(s[:10], "%Y-%m-%d")
        return d.strftime("%Y-%m-%d")
    except ValueError:
        pass
    # Try other formats
    for fmt in ("%d/%m/%Y", "%m/%d/%Y", "%d-%m-%Y"):
        try:
            from datetime import datetime
            d = datetime.strptime(s, fmt)
            return d.strftime("%Y-%m-%d")
        except ValueError:
            continue
    return s  # fallback: keep as-is


def _pm(raw) -> list[str]:
    """Parse markets cell → ['VN', 'TH', ...]"""
    if not raw or str(raw) in ("TBU", "-"):
        return []
    return [
        m.strip().upper()
        for m in re.split(r"[,;、\n]", str(raw))
        if m.strip() and 2 <= len(m.strip()) <= 12
    ]


def _ps(s) -> str:
    """Normalize status string."""
    if not s or str(s).startswith("="):
        return "On Process"
    lo = str(s).lower()
    if "released" in lo:   return "Released"
    if "terminated" in lo: return "Terminated"
    if "cancelled" in lo:  return "Cancelled"
    if "pending" in lo:    return "Pending"
    if "closing" in lo:    return "Closing"
    if "closed" in lo:     return "Closed"
    return str(s).strip() or "On Process"


def _cell(row: list, idx: int) -> str:
    return str(row[idx]).strip() if idx < len(row) else ""


def _parse_release(rows: list[list]) -> list[dict]:
    if not rows:
        return []
    # Find header row
    hi = next(
        (i for i, r in enumerate(rows) if re.search(r"sản phẩm|^game$", str(r[0] if r else ""), re.IGNORECASE)),
        -1,
    )
    start = hi + 1 if hi >= 0 else 3
    result = []
    for row in rows[start:]:
        if not row or not _cell(row, 0):
            continue
        result.append({
            "name":        _cell(row, 0),
            "faCode":      _cell(row, 1),
            "alias":       _cell(row, 2),
            "owner":       _cell(row, 3),
            "ranking":     _cell(row, 4).upper(),
            "status":      _ps(_cell(row, 5)),
            "cbtFrom":     _pd(_cell(row, 7)),
            "cbtTo":       _pd(_cell(row, 8)),
            "cbtPlatform": _cell(row, 9),
            "obDate":      _pd(_cell(row, 11)),
            "obPlatform":  _cell(row, 12),
            "markets":     _pm(_cell(row, 13)),
            "kickstart":   _pd(_cell(row, 14)),
            "note":        _cell(row, 15),
        })
    return result


def _parse_close(rows: list[list]) -> list[dict]:
    if not rows:
        return []
    hi = next(
        (i for i, r in enumerate(rows)
         if re.search(r"fa.?code", str(r[0] if r else ""), re.IGNORECASE)
         or re.search(r"product", str(r[2] if len(r) > 2 else ""), re.IGNORECASE)),
        -1,
    )
    start = hi + 1 if hi >= 0 else 1
    result = []
    for row in rows[start:]:
        if not row or (not _cell(row, 0) and not _cell(row, 2)):
            continue
        name = _cell(row, 2) or _cell(row, 0)
        if not name:
            continue
        result.append({
            "faCode":      _cell(row, 0),
            "alias":       _cell(row, 1),
            "name":        name,
            "markets":     _pm(_cell(row, 3)),
            "productType": _cell(row, 4),
            "status":      _ps(_cell(row, 5)),
            "owner":       _cell(row, 6),
            "releaseDate": _pd(_cell(row, 7)),
            "closeDate":   _pd(_cell(row, 8)),
            "paymentClose":_pd(_cell(row, 9)),
        })
    return result
