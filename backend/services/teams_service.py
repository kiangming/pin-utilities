"""
Teams Service — gửi message đến Microsoft Teams Incoming Webhook.
"""
from __future__ import annotations

import time

import httpx


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
            return True, None
        return False, f"Teams trả lỗi HTTP {resp.status_code}: {resp.text[:200]}"
    except httpx.TimeoutException:
        return False, "Teams webhook timeout (10s)"
    except Exception as e:
        return False, f"Teams webhook error: {e}"


def send_mention_message(
    webhook_url: str,
    message_text: str,
    mention: dict | None,
) -> tuple[bool, str | None]:
    """
    Gửi Adaptive Card với Teams mention nếu mention được cung cấp.
    mention = { "id": "user@vng.com.vn", "name": "Fullname" }
    Fallback về plain text khi mention=None.
    """
    if mention:
        mention_entity = {
            "type": "mention",
            "text": f"<at>{mention['name']}</at>",
            "mentioned": {
                "id": mention["id"],
                "name": mention["name"],
            },
        }
        payload = {
            "type": "message",
            "attachments": [{
                "contentType": "application/vnd.microsoft.card.adaptive",
                "content": {
                    "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                    "type": "AdaptiveCard",
                    "version": "1.0",
                    "body": [{"type": "TextBlock", "text": message_text, "wrap": True}],
                    "msteams": {"entities": [mention_entity]},
                },
            }],
        }
    else:
        payload = {"text": message_text}

    try:
        with httpx.Client(timeout=10) as client:
            resp = client.post(
                webhook_url,
                json=payload,
                headers={"Content-Type": "application/json"},
            )
        if resp.status_code < 300:
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
