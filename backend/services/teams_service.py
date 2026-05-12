"""
Teams Service — gửi message đến Microsoft Teams Incoming Webhook.
"""
from __future__ import annotations

import json
import time

import httpx


# Markers trong response body — Teams trả 200 nhưng downstream delivery fail
# (rate limit, bot endpoint timeout, UPN không resolve, v.v.)
_FAILURE_MARKERS = (
    "webhook message delivery failed",
    "error contacting microsoft teams endpoint",
)


def _is_delivery_failure(resp_text: str) -> bool:
    """HTTP 200 nhưng body báo lỗi delivery → coi như failed."""
    if not resp_text:
        return False
    lower = resp_text.lower()
    return any(marker in lower for marker in _FAILURE_MARKERS)


def send_message(webhook_url: str, message: str) -> tuple[bool, str | None]:
    """
    POST webhook_url với body {"text": message}.
    Returns (True, None) nếu 2xx; (False, error_msg) nếu lỗi.
    """
    try:
        with httpx.Client(timeout=10) as client:
            resp = client.post(
                webhook_url,
                json={"text": message},
                headers={"Content-Type": "application/json"},
            )
        if resp.status_code < 300:
            if _is_delivery_failure(resp.text):
                return False, f"Teams delivery failed (HTTP 200): {resp.text[:200]}"
            return True, None
        return False, f"Teams trả lỗi HTTP {resp.status_code}: {resp.text[:200]}"
    except httpx.TimeoutException:
        return False, "Teams webhook timeout (10s)"
    except Exception as e:
        return False, f"Teams webhook error: {e}"


def send_mention_message(
    webhook_url: str,
    message_text: str,
    mentions: list[dict],
) -> tuple[bool, str | None]:
    """
    Gửi Adaptive Card với Teams mentions nếu có.
    mentions = [{ "id": "user@vng.com.vn", "name": "Fullname" }, ...]
    Fallback về plain text khi mentions rỗng.
    """
    if mentions:
        entities = [
            {
                "type": "mention",
                "text": f"<at>{m['name']}</at>",
                "mentioned": {"id": m["id"], "name": m["name"]},
            }
            for m in mentions
        ]
        payload = {
            "type": "message",
            "attachments": [{
                "contentType": "application/vnd.microsoft.card.adaptive",
                "content": {
                    "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                    "type": "AdaptiveCard",
                    "version": "1.2",
                    "body": [{"type": "TextBlock", "text": message_text, "wrap": True}],
                    "msteams": {"entities": entities},
                },
            }],
        }
    else:
        payload = {"text": message_text}

    print("\n========== TEAMS WEBHOOK ==========", flush=True)
    print(f"URL: {webhook_url[:60]}...", flush=True)
    print(f"PAYLOAD: {json.dumps(payload, ensure_ascii=False)}", flush=True)
    print("====================================\n", flush=True)

    try:
        with httpx.Client(timeout=10) as client:
            resp = client.post(
                webhook_url,
                json=payload,
                headers={"Content-Type": "application/json"},
            )
        print(f"TEAMS RESPONSE: {resp.status_code} — {resp.text[:300]}", flush=True)
        if resp.status_code < 300:
            if _is_delivery_failure(resp.text):
                return False, f"Teams delivery failed (HTTP 200): {resp.text[:200]}"
            return True, None
        return False, f"Teams trả lỗi HTTP {resp.status_code}: {resp.text[:200]}"
    except httpx.TimeoutException:
        return False, "Teams webhook timeout (10s)"
    except Exception as e:
        return False, f"Teams webhook error: {e}"


def send_test(webhook_url: str) -> tuple[bool, str | None]:
    """Gửi test message để kiểm tra webhook URL."""
    ts = time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime())
    message = f"[TEST] Remind system connected successfully — {ts}"
    return send_message(webhook_url, message)
