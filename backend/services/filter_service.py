"""
Filter Service — xác định ticket nào cần nhắc.
Không có I/O — pure functions, unit testable.
"""
from __future__ import annotations

from datetime import date

TICKET_URL_TEMPLATE = "https://nexus.vnggames.com/home/tickets-v2/{id}"


def calc_diff_days(due_date_str: str | None) -> int | None:
    """
    "YYYY-MM-DD" → số ngày còn lại (âm = quá hạn).
    None nếu input invalid hoặc rỗng.
    """
    if not due_date_str:
        return None
    try:
        due = date.fromisoformat(due_date_str)
        return (due - date.today()).days
    except (ValueError, TypeError):
        return None


def is_need_remind(
    ticket: dict,
    comments: list,
    handler_usernames: set[str],
    threshold: int = 5,
) -> bool:
    """
    Logic xác định ticket cần nhắc:
    - Không có due_date → False
    - diffDays > threshold → False (còn nhiều ngày)
    - Không có comment → True
    - Comment cuối là handler → True (requester chưa reply)
    - Comment cuối là requester → False
    """
    diff = calc_diff_days(ticket.get("due_date"))
    if diff is None:
        return False
    if diff > threshold:
        return False

    if not comments:
        return True

    last_comment = comments[-1]
    last_username = (last_comment.get("user") or {}).get("username", "")
    return last_username in handler_usernames


def build_time_label(due_date_str: str, diff_days: int) -> str:
    """
    "will expire on DD/MM/YYYY" hoặc "expired on DD/MM/YYYY"
    """
    fmt = format_due_date(due_date_str)
    if diff_days < 0:
        return f"expired on {fmt}"
    return f"will expire on {fmt}"


def format_due_date(due_date_str: str) -> str:
    """"2026-04-08" → "08/04/2026"."""
    try:
        d = date.fromisoformat(due_date_str)
        return d.strftime("%d/%m/%Y")
    except (ValueError, TypeError):
        return due_date_str or ""


def _extract_product(ticket: dict) -> tuple[str, str]:
    """Lấy product id và name từ ticket.
    API có thể trả về 'product' (object) hoặc 'products' (array).
    """
    # Thử dạng object trước (theo spec mới)
    product = ticket.get("product")
    if product and isinstance(product, dict):
        return str(product.get("id", "")), product.get("name", "")
    # Fallback: dạng array cũ
    products = ticket.get("products") or []
    if products:
        return str(products[0].get("id", "")), products[0].get("name", "")
    return "", ""


def _extract_last_comment(comments: list) -> dict | None:
    """Trích thông tin comment cuối cùng."""
    if not comments:
        return None
    last = comments[-1]
    return {
        "name":       last.get("name", ""),
        "notes":      last.get("notes", ""),
        "created_on": last.get("created_on", ""),
    }


def build_remind_item(
    ticket: dict,
    comments: list,
    handler_usernames: set[str],
    threshold: int = 5,
) -> dict:
    """
    Tính toán đầy đủ thông tin cho 1 ticket: need_remind, diff_days, time_label, v.v.
    """
    due_date = ticket.get("due_date")
    diff_days = calc_diff_days(due_date)
    need_remind = is_need_remind(ticket, comments, handler_usernames, threshold)

    # Last comment — structured object + legacy username fields
    last_comment_by = ""
    last_comment_is_handler = False
    if comments:
        last = comments[-1]
        last_comment_by = (last.get("user") or {}).get("username", "")
        last_comment_is_handler = last_comment_by in handler_usernames

    product_id, product_name = _extract_product(ticket)
    requester = ticket.get("requester") or {}
    handler = ticket.get("handler") or {}

    time_label = ""
    due_date_fmt = ""
    if due_date and diff_days is not None:
        time_label = build_time_label(due_date, diff_days)
        due_date_fmt = format_due_date(due_date)

    return {
        "id":           ticket.get("id"),
        "ticket_url":   TICKET_URL_TEMPLATE.format(id=ticket.get("id", "")),
        "product_id":   product_id,
        "product_name": product_name,
        "title":        ticket.get("title", ""),
        "requester_name":  requester.get("fullname", ""),
        "requester_login": requester.get("login", ""),
        "assignee_name":   handler.get("fullname", ""),
        "created_at":      ticket.get("created_at", ""),
        "status":       (ticket.get("status") or {}).get("name", ""),
        "due_date":     due_date,
        "due_date_fmt": due_date_fmt,
        "diff_days":    diff_days,
        "need_remind":  need_remind,
        "time_label":   time_label,
        # Last comment — structured (for display) + legacy fields (for send_remind compat)
        "last_comment":          _extract_last_comment(comments),
        "last_comment_by":       last_comment_by,
        "last_comment_is_handler": last_comment_is_handler,
    }
