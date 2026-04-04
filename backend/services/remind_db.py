"""
Remind DB Service — Supabase CRUD cho Ticket Reminder feature.
Pattern: httpx REST API (nhất quán với sdk_version_service.py).
"""
from __future__ import annotations

import httpx

from backend.config import settings

SB_TABLES = {
    "webhooks":  "webhook_configs",
    "templates": "remind_templates",
    "handlers":  "handler_usernames",
    "logs":      "remind_logs",
    "products":  "products",
    "services":  "services",
}


def _sb_headers(prefer: str = "") -> dict:
    h = {
        "apikey": settings.supabase_service_key,
        "Authorization": f"Bearer {settings.supabase_service_key}",
        "Content-Type": "application/json",
    }
    if prefer:
        h["Prefer"] = prefer
    return h


def _sb_url(table: str, path: str = "") -> str:
    return f"{settings.supabase_url.rstrip('/')}/rest/v1/{table}{path}"


def _check_sb() -> bool:
    """Trả False nếu Supabase chưa config — caller trả empty list thay vì crash."""
    return bool(settings.supabase_url and settings.supabase_service_key)


# ── Webhook Configs ────────────────────────────────────────────────────────────

def get_webhooks() -> list[dict]:
    if not _check_sb():
        return []
    with httpx.Client(timeout=10) as c:
        r = c.get(
            _sb_url("webhook_configs"),
            headers=_sb_headers(),
            params={"select": "*", "order": "created_at.asc"},
        )
        r.raise_for_status()
        return r.json()


def create_webhook(data: dict) -> dict:
    with httpx.Client(timeout=10) as c:
        r = c.post(
            _sb_url("webhook_configs"),
            headers=_sb_headers("return=representation"),
            json=data,
        )
        r.raise_for_status()
        rows = r.json()
        return rows[0] if rows else {}


def update_webhook(id: str, data: dict) -> dict:
    with httpx.Client(timeout=10) as c:
        r = c.patch(
            _sb_url("webhook_configs"),
            headers=_sb_headers("return=representation"),
            params={"id": f"eq.{id}"},
            json=data,
        )
        r.raise_for_status()
        rows = r.json()
        return rows[0] if rows else {}


def delete_webhook(id: str) -> None:
    with httpx.Client(timeout=10) as c:
        r = c.delete(
            _sb_url("webhook_configs"),
            headers=_sb_headers(),
            params={"id": f"eq.{id}"},
        )
        r.raise_for_status()


def find_webhook_for_product(product_name: str) -> dict | None:
    """Case-insensitive match; fallback is_default=true."""
    if not _check_sb():
        return None
    webhooks = get_webhooks()
    name_lower = product_name.lower()
    # Exact case-insensitive match
    for w in webhooks:
        if (w.get("product_name") or "").lower() == name_lower:
            return w
    # Fallback: default webhook
    for w in webhooks:
        if w.get("is_default"):
            return w
    return None


# ── Templates ─────────────────────────────────────────────────────────────────

def get_templates() -> list[dict]:
    if not _check_sb():
        return []
    with httpx.Client(timeout=10) as c:
        r = c.get(
            _sb_url("remind_templates"),
            headers=_sb_headers(),
            params={"select": "*", "order": "created_at.asc"},
        )
        r.raise_for_status()
        return r.json()


def create_template(data: dict) -> dict:
    with httpx.Client(timeout=10) as c:
        r = c.post(
            _sb_url("remind_templates"),
            headers=_sb_headers("return=representation"),
            json=data,
        )
        r.raise_for_status()
        rows = r.json()
        return rows[0] if rows else {}


def update_template(id: str, data: dict) -> dict:
    with httpx.Client(timeout=10) as c:
        r = c.patch(
            _sb_url("remind_templates"),
            headers=_sb_headers("return=representation"),
            params={"id": f"eq.{id}"},
            json=data,
        )
        r.raise_for_status()
        rows = r.json()
        return rows[0] if rows else {}


def delete_template(id: str) -> None:
    with httpx.Client(timeout=10) as c:
        r = c.delete(
            _sb_url("remind_templates"),
            headers=_sb_headers(),
            params={"id": f"eq.{id}"},
        )
        r.raise_for_status()


def get_default_template() -> dict | None:
    if not _check_sb():
        return None
    with httpx.Client(timeout=10) as c:
        r = c.get(
            _sb_url("remind_templates"),
            headers=_sb_headers(),
            params={"select": "*", "is_default": "eq.true", "limit": "1"},
        )
        r.raise_for_status()
        rows = r.json()
        return rows[0] if rows else None


# ── Handler Usernames ──────────────────────────────────────────────────────────

def get_handlers() -> list[dict]:
    if not _check_sb():
        return []
    with httpx.Client(timeout=10) as c:
        r = c.get(
            _sb_url("handler_usernames"),
            headers=_sb_headers(),
            params={"select": "*", "order": "created_at.asc"},
        )
        r.raise_for_status()
        return r.json()


def get_handler_usernames() -> set[str]:
    """Trả về set usernames — dùng cho filter_service."""
    if not _check_sb():
        return set()
    handlers = get_handlers()
    return {h["username"] for h in handlers if h.get("username")}


def create_handler(data: dict) -> dict:
    with httpx.Client(timeout=10) as c:
        r = c.post(
            _sb_url("handler_usernames"),
            headers=_sb_headers("return=representation"),
            json=data,
        )
        r.raise_for_status()
        rows = r.json()
        return rows[0] if rows else {}


def delete_handler(id: str) -> None:
    with httpx.Client(timeout=10) as c:
        r = c.delete(
            _sb_url("handler_usernames"),
            headers=_sb_headers(),
            params={"id": f"eq.{id}"},
        )
        r.raise_for_status()


# ── Remind Logs ────────────────────────────────────────────────────────────────

def create_log(data: dict) -> None:
    if not _check_sb():
        return
    with httpx.Client(timeout=10) as c:
        r = c.post(
            _sb_url("remind_logs"),
            headers=_sb_headers(),
            json=data,
        )
        r.raise_for_status()


def get_logs(status: str | None = None, limit: int = 50) -> list[dict]:
    if not _check_sb():
        return []
    params: dict = {
        "select": "*",
        "order": "reminded_at.desc",
        "limit": str(limit),
    }
    if status:
        params["status"] = f"eq.{status}"
    with httpx.Client(timeout=10) as c:
        r = c.get(_sb_url("remind_logs"), headers=_sb_headers(), params=params)
        r.raise_for_status()
        return r.json()


# ── Products ───────────────────────────────────────────────────────────────────

def upsert_products(products: list[dict]) -> int:
    if not products or not _check_sb():
        return 0
    rows = [
        {
            "id": p["id"],
            "name": p.get("name", ""),
            "code": p.get("code"),
            "alias": p.get("alias"),
        }
        for p in products
    ]
    with httpx.Client(timeout=15) as c:
        r = c.post(
            _sb_url("products"),
            headers=_sb_headers("resolution=merge-duplicates"),
            json=rows,
        )
        r.raise_for_status()
    return len(rows)


def get_products() -> list[dict]:
    if not _check_sb():
        return []
    with httpx.Client(timeout=10) as c:
        r = c.get(
            _sb_url("products"),
            headers=_sb_headers(),
            params={"select": "id,name,code,alias", "order": "name.asc"},
        )
        r.raise_for_status()
        return r.json()


# ── Services ───────────────────────────────────────────────────────────────────

def upsert_services(services: list[dict]) -> int:
    if not services or not _check_sb():
        return 0
    rows = [
        {
            "id": s["id"],
            "name": s.get("name", ""),
            "description": s.get("description"),
        }
        for s in services
    ]
    with httpx.Client(timeout=15) as c:
        r = c.post(
            _sb_url("services"),
            headers=_sb_headers("resolution=merge-duplicates"),
            json=rows,
        )
        r.raise_for_status()
    return len(rows)


def get_services() -> list[dict]:
    if not _check_sb():
        return []
    with httpx.Client(timeout=10) as c:
        r = c.get(
            _sb_url("services"),
            headers=_sb_headers(),
            params={"select": "id,name,description", "order": "name.asc"},
        )
        r.raise_for_status()
        return r.json()
