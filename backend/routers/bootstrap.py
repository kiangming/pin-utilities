"""
Bootstrap router — proxy đến VNGGames Bootstrap API.

Routes:
  GET  /api/config                   → fetch config 1 game
  POST /api/batch                    → start batch job (game_ids từ client)
  GET  /api/batch/status?jobId=xxx   → poll job progress
"""
from fastapi import APIRouter, Query, Depends, HTTPException
from fastapi.responses import JSONResponse

from backend.middleware.auth_guard import require_session
from backend.models.schemas import BatchStartRequest, SessionData
from backend.services import bootstrap_service

router = APIRouter(prefix="/api", tags=["bootstrap"])


@router.get("/config")
async def get_config(
    gameId: str = Query(...),
    platform: str = Query("android"),
    country: str | None = Query(None),
    _session: SessionData = Depends(require_session),
):
    if platform not in ("android", "ios"):
        platform = "android"
    data, err = bootstrap_service.fetch_config(gameId, platform, country)
    if err:
        raise HTTPException(502, detail=err)
    return JSONResponse({"success": True, "gameId": gameId, "platform": platform,
                         "country": country, "data": data})


@router.post("/batch")
async def start_batch(
    body: BatchStartRequest,
    _session: SessionData = Depends(require_session),
):
    if not body.game_ids:
        raise HTTPException(400, detail="No game IDs provided")

    job_id = bootstrap_service.start_batch(body.game_ids, body.countries)
    return JSONResponse({"jobId": job_id, "total": len(body.game_ids),
                         "status": "running", "countries": body.countries}, status_code=202)


@router.get("/batch/status")
async def batch_status(
    jobId: str = Query(...),
    _session: SessionData = Depends(require_session),
):
    job = bootstrap_service.get_job(jobId)
    if not job:
        raise HTTPException(404, detail="Job not found")
    return JSONResponse(job)
