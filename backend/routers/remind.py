"""
Remind Router — tất cả /api/remind/* endpoints.
Tất cả routes require_session().
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from backend.config import settings
from backend.middleware.auth_guard import require_session
from backend.models.schemas import SessionData
from backend.services import (
    fetch_job_service,
    remind_db,
    teams_service,
    template_service,
    ticket_service,
)

router = APIRouter(prefix="/api/remind", tags=["remind"])


def _request_user(session: SessionData) -> str:
    """Lấy username từ email (phần trước @)."""
    return session.user.email.split("@")[0]


# ── Models ─────────────────────────────────────────────────────────────────────

class FetchTicketsRequest(BaseModel):
    service_ids: list[int] = []
    statuses: list[str] = []
    due_days_threshold: int = 5
    assignee: str = ""
    created_at_from: str = ""
    created_at_to: str = ""


class SendTicket(BaseModel):
    id: int
    product_name: str
    requester_name: str
    assignee_name: str = ""
    handler_id: int | None = None
    due_date_fmt: str = ""
    diff_days: int | None = None
    time_label: str = ""
    title: str = ""
    ticket_url: str | None = None


class SendRemindRequest(BaseModel):
    tickets: list[SendTicket]


class WebhookCreateRequest(BaseModel):
    product_name: str
    product_code: str = ""
    channel_name: str
    webhook_url: str
    template_id: str | None = None
    is_default: bool = False


class TemplateCreateRequest(BaseModel):
    name: str
    content: str
    is_default: bool = False


class HandlerCreateRequest(BaseModel):
    username: str
    full_name: str = ""
    note: str = ""


# ── Ticket Fetch ───────────────────────────────────────────────────────────────

@router.post("/tickets/fetch")
async def start_fetch(
    req: FetchTicketsRequest,
    session: SessionData = Depends(require_session),
):
    filters = {
        "service_ids": [str(s) for s in req.service_ids] if req.service_ids else [],
        "statuses": req.statuses,
        "assignee": req.assignee,
        "created_at_from": req.created_at_from,
        "created_at_to": req.created_at_to,
        "per_page": 100,
    }
    job_id = fetch_job_service.start_fetch_job(filters, _request_user(session), req.due_days_threshold)
    return {"job_id": job_id}


@router.get("/tickets/fetch/status")
async def fetch_status(
    job_id: str = Query(...),
    session: SessionData = Depends(require_session),
):
    job = fetch_job_service.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found")
    return job


# ── Send Remind ────────────────────────────────────────────────────────────────

@router.post("/send")
async def send_remind(
    req: SendRemindRequest,
    session: SessionData = Depends(require_session),
):
    if not req.tickets:
        raise HTTPException(status_code=422, detail="No tickets to remind")

    # Batch user lookup — single API call for all unique handler_ids
    unique_handler_ids = list({t.handler_id for t in req.tickets if t.handler_id is not None})
    user_map = ticket_service.fetch_users_by_ids(unique_handler_ids)

    # Load template & webhook config once
    templates = {t["id"]: t for t in remind_db.get_templates()}
    results = []
    sent = failed = skipped = 0

    for ticket in req.tickets:
        # Find webhook
        webhook = remind_db.find_webhook_for_product(ticket.product_name)
        if not webhook:
            skipped += 1
            results.append({
                "ticket_id": ticket.id,
                "status": "skipped",
                "channel": None,
                "message": None,
                "error": f"No webhook config for product: {ticket.product_name}",
            })
            remind_db.create_log({
                "ticket_id": str(ticket.id),
                "ticket_url": ticket.ticket_url,
                "product": ticket.product_name,
                "requester": ticket.requester_name,
                "due_date": None,
                "webhook_id": None,
                "template_id": None,
                "message": None,
                "status": "skipped",
                "error_msg": f"No webhook config for product: {ticket.product_name}",
            })
            continue

        # Find template: webhook's template or default
        tmpl = None
        if webhook.get("template_id") and webhook["template_id"] in templates:
            tmpl = templates[webhook["template_id"]]
        if not tmpl:
            tmpl = remind_db.get_default_template()

        if not tmpl:
            skipped += 1
            results.append({
                "ticket_id": ticket.id,
                "status": "skipped",
                "channel": webhook.get("channel_name"),
                "message": None,
                "error": "No template configured",
            })
            continue

        # Resolve mention: use user_map if handler_id available
        user_info = user_map.get(ticket.handler_id) if ticket.handler_id else None
        if user_info and user_info.get("email") and user_info.get("fullname"):
            tagged_handler = f"<at>{user_info['fullname']}</at>"
            mention = {"id": user_info["email"], "name": user_info["fullname"]}
        else:
            tagged_handler = ticket.assignee_name or ""
            mention = None

        # Render message
        message = template_service.render(tmpl["content"], {
            "requester_name": ticket.requester_name,
            "product_name": ticket.product_name,
            "ticket_id": str(ticket.id),
            "due_date": ticket.due_date_fmt,
            "days_left": str(ticket.diff_days) if ticket.diff_days is not None else "",
            "time_label": ticket.time_label,
            "tagged_handler": tagged_handler,
        })

        # Mask webhook URL for display (30 chars)
        url = webhook["webhook_url"]

        # Send with mention if available, else plain text
        ok, err_msg = teams_service.send_mention_message(url, message, mention)

        if ok:
            sent += 1
            results.append({
                "ticket_id": ticket.id,
                "status": "sent",
                "channel": webhook.get("channel_name"),
                "message": message,
                "error": None,
            })
            remind_db.create_log({
                "ticket_id": str(ticket.id),
                "ticket_url": ticket.ticket_url,
                "product": ticket.product_name,
                "requester": ticket.requester_name,
                "webhook_id": webhook.get("id"),
                "template_id": tmpl.get("id"),
                "message": message,
                "status": "sent",
                "error_msg": None,
            })
        else:
            failed += 1
            results.append({
                "ticket_id": ticket.id,
                "status": "failed",
                "channel": webhook.get("channel_name"),
                "message": message,
                "error": err_msg,
            })
            remind_db.create_log({
                "ticket_id": str(ticket.id),
                "ticket_url": ticket.ticket_url,
                "product": ticket.product_name,
                "requester": ticket.requester_name,
                "webhook_id": webhook.get("id"),
                "template_id": tmpl.get("id"),
                "message": message,
                "status": "failed",
                "error_msg": err_msg,
            })

    return {"results": results, "sent": sent, "failed": failed, "skipped": skipped}


# ── Webhooks CRUD ──────────────────────────────────────────────────────────────

@router.get("/webhooks")
async def get_webhooks(session: SessionData = Depends(require_session)):
    return remind_db.get_webhooks()


@router.post("/webhooks", status_code=201)
async def create_webhook(
    req: WebhookCreateRequest,
    session: SessionData = Depends(require_session),
):
    try:
        return remind_db.create_webhook(req.model_dump(exclude_none=False))
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.put("/webhooks/{id}")
async def update_webhook(
    id: str,
    req: WebhookCreateRequest,
    session: SessionData = Depends(require_session),
):
    try:
        return remind_db.update_webhook(id, req.model_dump(exclude_none=False))
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.delete("/webhooks/{id}", status_code=204)
async def delete_webhook(
    id: str,
    session: SessionData = Depends(require_session),
):
    try:
        remind_db.delete_webhook(id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.post("/webhooks/{id}/test")
async def test_webhook(
    id: str,
    session: SessionData = Depends(require_session),
):
    webhooks = remind_db.get_webhooks()
    webhook = next((w for w in webhooks if w["id"] == id), None)
    if not webhook:
        raise HTTPException(status_code=404, detail="Webhook not found")
    ok, err = teams_service.send_test(webhook["webhook_url"])
    return {"ok": ok, "error": err}


# ── Templates CRUD ─────────────────────────────────────────────────────────────

@router.get("/templates")
async def get_templates(session: SessionData = Depends(require_session)):
    return remind_db.get_templates()


@router.post("/templates", status_code=201)
async def create_template(
    req: TemplateCreateRequest,
    session: SessionData = Depends(require_session),
):
    try:
        return remind_db.create_template(req.model_dump())
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.put("/templates/{id}")
async def update_template(
    id: str,
    req: TemplateCreateRequest,
    session: SessionData = Depends(require_session),
):
    try:
        return remind_db.update_template(id, req.model_dump())
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.delete("/templates/{id}", status_code=204)
async def delete_template(
    id: str,
    session: SessionData = Depends(require_session),
):
    try:
        remind_db.delete_template(id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.post("/templates/{id}/preview")
async def preview_template(
    id: str,
    session: SessionData = Depends(require_session),
):
    templates = remind_db.get_templates()
    tmpl = next((t for t in templates if t["id"] == id), None)
    if not tmpl:
        raise HTTPException(status_code=404, detail="Template not found")
    return {"preview": template_service.preview(tmpl["content"])}


# ── Handlers CRUD ──────────────────────────────────────────────────────────────

@router.get("/handlers")
async def get_handlers(session: SessionData = Depends(require_session)):
    return remind_db.get_handlers()


@router.post("/handlers", status_code=201)
async def create_handler(
    req: HandlerCreateRequest,
    session: SessionData = Depends(require_session),
):
    try:
        return remind_db.create_handler(req.model_dump())
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.delete("/handlers/{id}", status_code=204)
async def delete_handler(
    id: str,
    session: SessionData = Depends(require_session),
):
    try:
        remind_db.delete_handler(id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


# ── Products ───────────────────────────────────────────────────────────────────

@router.post("/products/sync")
async def sync_products(session: SessionData = Depends(require_session)):
    debug_collector: list | None = [] if settings.debug_ticket_api else None
    products, err = ticket_service.fetch_products(_request_user(session), debug_collector=debug_collector)
    if err:
        raise HTTPException(status_code=502, detail=err)
    count = remind_db.upsert_products(products)
    return {"synced": count, "debug_requests": debug_collector}


@router.get("/products")
async def get_products(
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=500),
    session: SessionData = Depends(require_session),
):
    return remind_db.get_products(offset=offset, limit=limit)


# ── Services ───────────────────────────────────────────────────────────────────

@router.post("/services/sync")
async def sync_services(session: SessionData = Depends(require_session)):
    debug_collector: list | None = [] if settings.debug_ticket_api else None
    services, err = ticket_service.fetch_services(_request_user(session), debug_collector=debug_collector)
    if err:
        raise HTTPException(status_code=502, detail=err)
    count = remind_db.upsert_services(services)
    return {"synced": count, "debug_requests": debug_collector}


@router.get("/services")
async def get_services(session: SessionData = Depends(require_session)):
    return remind_db.get_services()


# ── Statuses ───────────────────────────────────────────────────────────────────

@router.post("/statuses/sync")
async def sync_statuses(session: SessionData = Depends(require_session)):
    debug_collector: list | None = [] if settings.debug_ticket_api else None
    statuses, err = ticket_service.fetch_statuses(_request_user(session), debug_collector=debug_collector)
    if err:
        raise HTTPException(status_code=502, detail=err)
    count = remind_db.upsert_statuses(statuses)
    return {"synced": count, "debug_requests": debug_collector}


@router.get("/statuses")
async def get_statuses(session: SessionData = Depends(require_session)):
    return remind_db.get_statuses()


# ── Logs ───────────────────────────────────────────────────────────────────────

@router.get("/logs")
async def get_logs(
    status: str | None = Query(None),
    limit: int = Query(50, le=200),
    session: SessionData = Depends(require_session),
):
    return remind_db.get_logs(status=status, limit=limit)
