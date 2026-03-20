"""
SDK Versions router.

Routes:
  GET /api/sdk-versions/summary  → KPI, version distribution, platform usage, mismatch
  GET /api/sdk-versions/detail   → Bảng chi tiết với filter
"""
from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse

from backend.middleware.auth_guard import require_session
from backend.models.schemas import SessionData
from backend.services import sdk_version_service

router = APIRouter(prefix="/api/sdk-versions", tags=["sdk-versions"])


@router.get("/summary")
async def get_summary(_session: SessionData = Depends(require_session)):
    snapshots = sdk_version_service.fetch_all_snapshots()
    return JSONResponse(sdk_version_service.build_summary(snapshots))


@router.get("/detail")
async def get_detail(
    platform: str = Query(""),
    status: str = Query(""),
    search: str = Query(""),
    _session: SessionData = Depends(require_session),
):
    snapshots = sdk_version_service.fetch_all_snapshots()
    return JSONResponse(
        sdk_version_service.build_detail(snapshots, platform, status, search)
    )
