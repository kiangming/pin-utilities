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

def _html_entity_decode(s: str) -> str:
    return (
        s.replace("&amp;", "&")
         .replace("&lt;", "<")
         .replace("&gt;", ">")
         .replace("&quot;", '"')
         .replace("&#039;", "'")
    )


def _build_signature(client_secret: str, params: dict) -> str:
    """Port từ buildSignature() trong api-test.js."""
    sorted_params = dict(sorted(params.items()))
    hash_string = hashlib.sha1(client_secret.encode()).hexdigest()

    for value in sorted_params.values():
        if isinstance(value, list):
            filtered = [v for v in value if v]
            value = json.dumps(filtered, separators=(",", ":"))
        str_val = str(value) if value is not None else ""
        str_val = _html_entity_decode(str_val)
        if str_val:
            hash_string += "|" + str_val

    return hashlib.sha1(hash_string.encode()).hexdigest()


def _build_signature_debug(client_secret: str, params: dict) -> tuple[str, dict]:
    """Giống _build_signature nhưng capture từng bước. Trả về (signature, debug_dict)."""
    sorted_params = dict(sorted(params.items()))
    secret_hash = hashlib.sha1(client_secret.encode()).hexdigest()
    hash_string = secret_hash
    steps = []

    for key, value in sorted_params.items():
        original = value
        note = None
        if isinstance(value, list):
            filtered = [v for v in value if v]
            encoded = json.dumps(filtered, separators=(",", ":"))
            note = f"array → json_encode(array_filter) = {encoded}"
            value = encoded
        str_val = str(value) if value is not None else ""
        str_val = _html_entity_decode(str_val)
        if str_val:
            hash_string += "|" + str_val
            steps.append({"key": key, "raw": original, "appended": f"|{str_val}", "note": note})
        else:
            steps.append({"key": key, "raw": original, "action": "SKIPPED (empty/falsy)", "note": note})

    signature = hashlib.sha1(hash_string.encode()).hexdigest()
    debug = {
        "sorted_params": sorted_params,
        "secret_hash": secret_hash,
        "steps": steps,
        "hash_string_before_sha1": hash_string,
        "signature": signature,
    }

    if settings.debug_ticket_api:
        masked = client_secret[:4] + "*" * max(0, len(client_secret) - 4)
        print("\n========== SIGNATURE BUILD ==========", flush=True)
        print(f"[1] sha1(client_secret)", flush=True)
        print(f"    client_secret = \"{masked}\"", flush=True)
        print(f"    sha1          = \"{secret_hash}\"", flush=True)
        print(f"\n[2] Params sau ksort:", flush=True)
        for s in steps:
            if "appended" in s:
                note_str = f" | {s['note']}" if s.get("note") else ""
                print(f"    key=\"{s['key']}\" | raw={json.dumps(s['raw'])}{note_str}", flush=True)
                print(f"         append → \"{s['appended']}\"", flush=True)
            else:
                print(f"    key=\"{s['key']}\" | raw={json.dumps(s['raw'])} | {s['action']}", flush=True)
        print(f"\n[3] hash_string_before_sha1:", flush=True)
        print(f"    \"{hash_string}\"", flush=True)
        print(f"\n[4] signature = \"{signature}\"", flush=True)
        print("=====================================\n", flush=True)

    return signature, debug


def _log_http(label: str, url: str, headers: dict, resp: httpx.Response) -> None:
    """Print request + response khi DEBUG_TICKET_API=true."""
    if not settings.debug_ticket_api:
        return
    print(f"\n========== {label} ==========", flush=True)
    print(f"REQUEST  {url}", flush=True)
    for k, v in headers.items():
        print(f"  {k}: {v}", flush=True)
    print(f"RESPONSE {resp.status_code}", flush=True)
    try:
        body = resp.json()
        text = json.dumps(body, ensure_ascii=False)
        print(f"  {text[:500]}{'...' if len(text) > 500 else ''}", flush=True)
    except Exception:
        print(f"  {resp.text[:500]}", flush=True)
    print("=" * (len(label) + 22), flush=True)


def _make_auth_headers(params: dict, debug_collector: list | None = None) -> dict:
    """Tạo headers client-id, timestamp, signature. Nếu debug_collector được truyền, append debug info."""
    ts = str(int(time.time() * 1000))
    hash_data = {
        "client-id": settings.ticket_api_client_id,
        "timestamp": ts,
        **params,
    }
    if debug_collector is not None:
        sig, sig_debug = _build_signature_debug(settings.ticket_api_client_secret, hash_data)
        debug_collector.append({"hash_data": hash_data, **sig_debug})
    else:
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
    debug_collector: list | None = None,
) -> tuple[list, str | None]:
    """
    Fetch tất cả tickets (loop pages). delay 300ms giữa pages.
    filters: service_ids, statuses, assignee, created_at_from, created_at_to, per_page
    on_page(page, last_page): callback cập nhật progress (optional)
    debug_collector: nếu truyền vào, capture debug info cho page đầu tiên
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
            # Capture debug info chỉ cho page 1
            page_debug = debug_collector if (page == 1 and debug_collector is not None) else None
            req_url = f"{BASE_URL}/tickets?{query_str}"
            req_headers = _make_auth_headers(sig_params, debug_collector=page_debug)
            if page_debug is not None and page_debug:
                page_debug[-1]["url"] = req_url
                page_debug[-1]["request_headers"] = {
                    k: v for k, v in req_headers.items() if k != "Content-Type"
                }
            with httpx.Client(timeout=30) as client:
                resp = client.get(req_url, headers=req_headers)
            if page == 1:
                _log_http("TICKETS page 1", req_url, req_headers, resp)
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


def fetch_products(request_user: str, debug_collector: list | None = None) -> tuple[list, str | None]:
    """GET /products."""
    sig_params = {"requestUser": request_user}
    req_url = f"{BASE_URL}/products?requestUser={request_user}"
    req_headers = _make_auth_headers(sig_params, debug_collector=debug_collector)
    if debug_collector is not None and debug_collector:
        debug_collector[-1]["url"] = req_url
        debug_collector[-1]["request_headers"] = {
            k: v for k, v in req_headers.items() if k != "Content-Type"
        }
    try:
        with httpx.Client(timeout=15) as client:
            resp = client.get(req_url, headers=req_headers)
        _log_http("PRODUCTS", req_url, req_headers, resp)
        resp.raise_for_status()
        return resp.json().get("data", []), None
    except httpx.HTTPStatusError:
        return [], f"Error fetching products: HTTP {resp.status_code}"
    except Exception as e:
        return [], f"Error fetching products: {e}"


def fetch_statuses(request_user: str, debug_collector: list | None = None) -> tuple[list, str | None]:
    """GET /statuses."""
    sig_params = {"requestUser": request_user}
    req_url = f"{BASE_URL}/statuses?requestUser={request_user}"
    req_headers = _make_auth_headers(sig_params, debug_collector=debug_collector)
    if debug_collector is not None and debug_collector:
        debug_collector[-1]["url"] = req_url
        debug_collector[-1]["request_headers"] = {
            k: v for k, v in req_headers.items() if k != "Content-Type"
        }
    try:
        with httpx.Client(timeout=15) as client:
            resp = client.get(req_url, headers=req_headers)
        _log_http("STATUSES", req_url, req_headers, resp)
        resp.raise_for_status()
        return resp.json().get("data", []), None
    except httpx.HTTPStatusError:
        return [], f"Error fetching statuses: HTTP {resp.status_code}"
    except Exception as e:
        return [], f"Error fetching statuses: {e}"


def fetch_services(request_user: str, debug_collector: list | None = None) -> tuple[list, str | None]:
    """GET /services."""
    sig_params = {"requestUser": request_user}
    req_url = f"{BASE_URL}/services?requestUser={request_user}"
    req_headers = _make_auth_headers(sig_params, debug_collector=debug_collector)
    if debug_collector is not None and debug_collector:
        debug_collector[-1]["url"] = req_url
        debug_collector[-1]["request_headers"] = {
            k: v for k, v in req_headers.items() if k != "Content-Type"
        }
    try:
        with httpx.Client(timeout=15) as client:
            resp = client.get(req_url, headers=req_headers)
        _log_http("SERVICES", req_url, req_headers, resp)
        resp.raise_for_status()
        return resp.json().get("data", []), None
    except httpx.HTTPStatusError:
        return [], f"Error fetching services: HTTP {resp.status_code}"
    except Exception as e:
        return [], f"Error fetching services: {e}"
