"""
MCP API client — gọi tool sdk_version_snapshot qua MCP Streamable HTTP (JSON-RPC 2.0).

Server: https://mcp-gateway.gio.vng.vn/mcp
Auth:   Authorization: Bearer <MCP_BEARER_TOKEN>
"""
import json
import os
import time
from typing import Dict, List, Optional

import httpx

MCP_URL = os.getenv("MCP_BASE_URL", "").rstrip("/")
MCP_BEARER_TOKEN = os.getenv("MCP_BEARER_TOKEN", "")
REQUEST_TIMEOUT = int(os.getenv("MCP_TIMEOUT_SECONDS", "30"))

_req_id = 0


def _next_id() -> int:
    global _req_id
    _req_id += 1
    return _req_id


def _headers() -> Dict:
    return {
        "Authorization": f"Bearer {MCP_BEARER_TOKEN}",
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }


def _call_jsonrpc(method: str, params: Dict) -> Dict:
    """Gửi 1 JSON-RPC request tới MCP server, trả về result dict."""
    payload = {
        "jsonrpc": "2.0",
        "id": _next_id(),
        "method": method,
        "params": params,
    }
    with httpx.Client(timeout=REQUEST_TIMEOUT) as client:
        resp = client.post(MCP_URL, headers=_headers(), json=payload)
        resp.raise_for_status()

        content_type = resp.headers.get("content-type", "")

        # SSE response — parse event stream
        if "text/event-stream" in content_type:
            return _parse_sse(resp.text)

        return resp.json()


def _parse_sse(text: str) -> Dict:
    """Parse SSE stream, lấy event 'message' đầu tiên có JSON-RPC response."""
    for line in text.splitlines():
        if line.startswith("data:"):
            data = line[5:].strip()
            if data:
                try:
                    return json.loads(data)
                except json.JSONDecodeError:
                    continue
    return {}


def _extract_records(rpc_response: Dict) -> List[Dict]:
    """Trích xuất list records từ JSON-RPC response của tools/call."""
    if os.getenv("MCP_DEBUG"):
        print(f"[mcp_debug] rpc_response keys: {list(rpc_response.keys())}", flush=True)
        print(f"[mcp_debug] rpc_response: {json.dumps(rpc_response)[:800]}", flush=True)

    if "error" in rpc_response:
        raise RuntimeError(f"MCP error: {rpc_response['error']}")

    result = rpc_response.get("result", rpc_response)

    # result.content là list[{type, text}] theo MCP spec
    content = result.get("content", []) if isinstance(result, dict) else []
    records = []
    for item in content:
        text = item.get("text") if isinstance(item, dict) else None
        if not text:
            continue
        try:
            parsed = json.loads(text)
        except (json.JSONDecodeError, TypeError):
            continue
        if isinstance(parsed, list):
            records.extend(parsed)
        elif isinstance(parsed, dict):
            records.append(parsed)

    # Fallback: nếu result chính là list
    if not records and isinstance(result, list):
        records = result

    return records


ACTIVE_STATUSES = {"ACTIVE", "NOT_RELEASED"}


def fetch_game_list() -> List[Dict]:
    """
    Gọi MCP tool game_list, trả về list {"game_id", "product_name"}
    cho các game có status ACTIVE hoặc NOT_RELEASED.
    """
    response = _call_jsonrpc("tools/call", {
        "name": "game_list",
        "arguments": {
            "fields": ["game_id", "product_name", "status"],
        },
    })
    records = _extract_records(response)
    games = []
    for r in records:
        status = (r.get("status") or "").upper()
        if status not in ACTIVE_STATUSES:
            continue
        gid = r.get("game_id") or r.get("product_code") or r.get("id") or r.get("gameId")
        if not gid:
            continue
        games.append({
            "game_id": str(gid),
            "product_name": r.get("product_name") or r.get("name") or "",
        })
    return games


def fetch_sdk_snapshot(game_id: str, platform: Optional[str] = None) -> List[Dict]:
    """
    Gọi MCP sdk_version_snapshot cho 1 game_id.
    Trả về list records (mỗi record = 1 platform).
    """
    arguments: Dict = {"game_id": game_id}
    if platform:
        arguments["platform"] = platform

    response = _call_jsonrpc("tools/call", {
        "name": "sdk_version_snapshot",
        "arguments": arguments,
    })
    return _extract_records(response)
