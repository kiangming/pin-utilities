"""
Ticket Service — gọi external Nexus Ticket API với HMAC signature auth.
Port từ api-test.js buildSignature().
"""
from __future__ import annotations

import hashlib
import json
import time

import httpx

from backend.config import settings

BASE_URL = settings.ticket_api_base_url


# ── Signature Auth ─────────────────────────────────────────────────────────────

def _build_signature(client_secret: str, params: dict) -> str:
    """
    Port từ buildSignature() trong api-test.js.
    params: dict gồm client_id + timestamp + tất cả query params.
    """
    sorted_params = dict(sorted(params.items()))
    hash_string = hashlib.sha1(client_secret.encode()).hexdigest()

    for value in sorted_params.values():
        if isinstance(value, list):
            # PHP array_filter: loại bỏ falsy values, json_encode compact
            filtered = [v for v in value if v]
            value = json.dumps(filtered, separators=(",", ":"))
        str_val = str(value) if value is not None else ""
        # html_entity_decode basic
        str_val = (
            str_val
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", '"')
        )
        if str_val:
            hash_string += "|" + str_val

    return hashlib.sha1(hash_string.encode()).hexdigest()


def _make_auth_headers(params: dict) -> dict:
    """Tạo headers client-id, timestamp, signature."""
    ts = str(int(time.time() * 1000))
    hash_data = {
        "client-id": settings.ticket_api_client_id,
        "timestamp": ts,
        **params,
    }
    sig = _build_signature(settings.ticket_api_client_secret, hash_data)
    return {
        "client-id": settings.ticket_api_client_id,
        "timestamp": ts,
        "signature": sig,
        "Content-Type": "application/json",
    }


# ── API Calls ──────────────────────────────────────────────────────────────────

def fetch_all_tickets(
    filters: dict,
    request_user: str,
    on_page: callable | None = None,
) -> tuple[list, str | None]:
    """
    Fetch tất cả tickets (loop pages). delay 300ms giữa pages.
    filters: service_ids, statuses, assignee, created_at_from, created_at_to, per_page
    on_page(page, last_page): callback cập nhật progress (optional)
    Returns (tickets, error_message)
    """
    all_tickets: list[dict] = []
    page = 1
    per_page = filters.get("per_page", 100)

    while True:
        params: dict = {"requestUser": request_user, "per_page": per_page, "page": page}

        if filters.get("service_ids"):
            params["service_ids"] = filters["service_ids"]
        if filters.get("statuses"):
            params["statuses"] = filters["statuses"]
        if filters.get("assignee"):
            params["assignee"] = filters["assignee"]
        if filters.get("created_at_from"):
            params["created_at_from"] = filters["created_at_from"]
        if filters.get("created_at_to"):
            params["created_at_to"] = filters["created_at_to"]

        # Build query string — array params dùng PHP-style: key[]=val
        query_parts: list[str] = []
        for k, v in params.items():
            if isinstance(v, list):
                for item in v:
                    query_parts.append(f"{k}[]={item}")
            else:
                query_parts.append(f"{k}={v}")
        query_str = "&".join(query_parts)

        # Params cho signature (flat, arrays dùng list)
        sig_params: dict = {"requestUser": request_user, "per_page": per_page, "page": page}
        if filters.get("service_ids"):
            sig_params["service_ids"] = filters["service_ids"]
        if filters.get("statuses"):
            sig_params["statuses"] = filters["statuses"]
        if filters.get("assignee"):
            sig_params["assignee"] = filters["assignee"]
        if filters.get("created_at_from"):
            sig_params["created_at_from"] = filters["created_at_from"]
        if filters.get("created_at_to"):
            sig_params["created_at_to"] = filters["created_at_to"]

        try:
            with httpx.Client(timeout=30) as client:
                resp = client.get(
                    f"{BASE_URL}/tickets?{query_str}",
                    headers=_make_auth_headers(sig_params),
                )
            if resp.status_code == 401:
                return [], "External API: 401 UNAUTHORIZED — signature sai hoặc timestamp lệch"
            if resp.status_code == 403:
                return [], "External API: 403 FORBIDDEN — client_id không có quyền"
            resp.raise_for_status()
            body = resp.json()
        except httpx.TimeoutException:
            return [], f"External API timeout (page {page})"
        except Exception as e:
            return [], f"External API error (page {page}): {e}"

        data = body.get("data", [])
        all_tickets.extend(data)

        meta = body.get("meta", {})
        last_page = meta.get("last_page", 1)

        if on_page:
            on_page(page, last_page)

        if page >= last_page:
            break

        page += 1
        time.sleep(0.3)  # 300ms delay giữa pages

    return all_tickets, None


def fetch_ticket_comments(ticket_id: int, request_user: str) -> tuple[list, str | None]:
    """GET /tickets/{id}/comments. Delay gọi bởi caller."""
    sig_params = {"requestUser": request_user, "ticketId": ticket_id}
    try:
        with httpx.Client(timeout=15) as client:
            resp = client.get(
                f"{BASE_URL}/tickets/{ticket_id}/comments?requestUser={request_user}",
                headers=_make_auth_headers(sig_params),
            )
        if resp.status_code == 404:
            return [], None  # Ticket không có comment cũng OK
        resp.raise_for_status()
        return resp.json().get("data", []), None
    except httpx.TimeoutException:
        return [], f"Timeout fetching comments for ticket {ticket_id}"
    except Exception as e:
        return [], f"Error fetching comments for ticket {ticket_id}: {e}"


def fetch_ticket_detail(ticket_id: int, request_user: str) -> tuple[dict | None, str | None]:
    """GET /tickets/{id} — lấy ticketUrl."""
    sig_params = {"requestUser": request_user, "ticketId": ticket_id}
    try:
        with httpx.Client(timeout=15) as client:
            resp = client.get(
                f"{BASE_URL}/tickets/{ticket_id}?requestUser={request_user}",
                headers=_make_auth_headers(sig_params),
            )
        if resp.status_code == 404:
            return None, f"Ticket {ticket_id} not found"
        resp.raise_for_status()
        return resp.json().get("data"), None
    except httpx.TimeoutException:
        return None, f"Timeout fetching detail for ticket {ticket_id}"
    except Exception as e:
        return None, f"Error fetching detail for ticket {ticket_id}: {e}"


def fetch_products(request_user: str) -> tuple[list, str | None]:
    """GET /products."""
    sig_params = {"requestUser": request_user}
    try:
        with httpx.Client(timeout=15) as client:
            resp = client.get(
                f"{BASE_URL}/products?requestUser={request_user}",
                headers=_make_auth_headers(sig_params),
            )
        resp.raise_for_status()
        return resp.json().get("data", []), None
    except Exception as e:
        return [], f"Error fetching products: {e}"


def fetch_services(request_user: str) -> tuple[list, str | None]:
    """GET /services."""
    sig_params = {"requestUser": request_user}
    try:
        with httpx.Client(timeout=15) as client:
            resp = client.get(
                f"{BASE_URL}/services?requestUser={request_user}",
                headers=_make_auth_headers(sig_params),
            )
        resp.raise_for_status()
        return resp.json().get("data", []), None
    except Exception as e:
        return [], f"Error fetching services: {e}"
