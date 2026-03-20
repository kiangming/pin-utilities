"""
MCP API client — gọi tool sdk_version_snapshot với Bearer token.

Endpoint mặc định: POST {MCP_BASE_URL}/tools/call
Body: {"tool": "sdk_version_snapshot", "params": {"game_id": ..., "platform": ...}}

Nếu MCP server của bạn dùng endpoint khác, chỉnh MCP_CALL_PATH trong .env.
"""
import os
import httpx

MCP_BASE_URL = os.getenv("MCP_BASE_URL", "").rstrip("/")
MCP_BEARER_TOKEN = os.getenv("MCP_BEARER_TOKEN", "")
MCP_CALL_PATH = os.getenv("MCP_CALL_PATH", "/tools/call")
REQUEST_TIMEOUT = int(os.getenv("MCP_TIMEOUT_SECONDS", "30"))


def fetch_sdk_snapshot(game_id: str, platform: str | None = None) -> list[dict]:
    """
    Gọi MCP sdk_version_snapshot cho 1 game_id.
    Trả về list records (mỗi record = 1 platform).
    Raise httpx.HTTPStatusError nếu API lỗi.
    """
    headers = {
        "Authorization": f"Bearer {MCP_BEARER_TOKEN}",
        "Content-Type": "application/json",
    }
    params: dict = {"game_id": game_id}
    if platform:
        params["platform"] = platform

    payload = {"tool": "sdk_version_snapshot", "params": params}

    with httpx.Client(timeout=REQUEST_TIMEOUT) as client:
        resp = client.post(
            f"{MCP_BASE_URL}{MCP_CALL_PATH}",
            headers=headers,
            json=payload,
        )
        resp.raise_for_status()
        data = resp.json()

    # Normalize: API có thể trả về list hoặc single dict
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        # Một số MCP wrapper bọc kết quả trong {"result": [...]}
        if "result" in data:
            result = data["result"]
            return result if isinstance(result, list) else [result]
        return [data]
    return []
