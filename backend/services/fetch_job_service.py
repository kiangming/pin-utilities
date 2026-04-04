"""
Fetch Job Service — background job cho ticket fetch + comment analysis.
Pattern: giống bootstrap_service.py (threading, in-memory job store).
"""
from __future__ import annotations

import threading
import time
import uuid

from backend.config import settings
from backend.services import ticket_service, filter_service, remind_db

# In-memory job store (tồn tại trong process lifetime)
_fetch_jobs: dict[str, dict] = {}


def start_fetch_job(filters: dict, request_user: str, due_days_threshold: int) -> str:
    """Khởi động background job, trả về job_id ngay lập tức."""
    job_id = uuid.uuid4().hex[:8]
    _fetch_jobs[job_id] = {
        "job_id": job_id,
        "status": "running",
        "phase": "tickets",
        "tickets_page": 0,
        "tickets_total_pages": 0,
        "comments_done": 0,
        "comments_total": 0,
        "result": None,
        "error": None,
    }
    threading.Thread(
        target=_run_fetch,
        args=(job_id, filters, request_user, due_days_threshold),
        daemon=True,
    ).start()
    return job_id


def get_job(job_id: str) -> dict | None:
    return _fetch_jobs.get(job_id)


def _run_fetch(job_id: str, filters: dict, request_user: str, threshold: int) -> None:
    job = _fetch_jobs[job_id]

    # ── Phase 1: Fetch ticket pages ────────────────────────────────────────────
    job["phase"] = "tickets"

    def _on_page(page: int, last_page: int) -> None:
        job["tickets_page"] = page
        job["tickets_total_pages"] = last_page

    debug_collector: list | None = [] if settings.debug_ticket_api else None
    all_tickets, err = ticket_service.fetch_all_tickets(
        filters, request_user, on_page=_on_page, debug_collector=debug_collector
    )
    if err:
        job["status"] = "error"
        job["error"] = err
        return

    # ── Phase 2: Fetch comments for each ticket ────────────────────────────────
    job["phase"] = "comments"
    job["comments_total"] = len(all_tickets)
    job["comments_done"] = 0

    # Lấy handler usernames từ Supabase (1 lần)
    try:
        handler_usernames = remind_db.get_handler_usernames()
    except Exception:
        handler_usernames = set()

    remind_items: list[dict] = []
    no_due_date_count = 0

    for ticket in all_tickets:
        # Bỏ qua ticket không có due_date
        if not ticket.get("due_date"):
            no_due_date_count += 1
            job["comments_done"] += 1
            continue

        # diff_days > threshold → không cần fetch comment (optimization)
        diff = filter_service.calc_diff_days(ticket.get("due_date"))
        if diff is not None and diff > threshold:
            item = filter_service.build_remind_item(ticket, [], handler_usernames, threshold)
            remind_items.append(item)
            job["comments_done"] += 1
            continue

        # Fetch comments
        comments, _err = ticket_service.fetch_ticket_comments(ticket["id"], request_user)
        item = filter_service.build_remind_item(ticket, comments, handler_usernames, threshold)

        # Fetch ticket detail để lấy ticketUrl (chỉ cho tickets cần nhắc)
        if item["need_remind"]:
            detail, _err2 = ticket_service.fetch_ticket_detail(ticket["id"], request_user)
            if detail:
                item["ticket_url"] = detail.get("ticketUrl")

        remind_items.append(item)
        job["comments_done"] += 1
        time.sleep(0.1)  # 100ms delay

    # ── Kết quả ────────────────────────────────────────────────────────────────
    remind_list = [t for t in remind_items if t["need_remind"]]

    job["status"] = "done"
    job["phase"] = "done"
    job["result"] = {
        "total": len(all_tickets),
        "remind_count": len(remind_list),
        "no_due_date_count": no_due_date_count,
        "tickets": remind_items,
        "debug_requests": debug_collector,
    }
