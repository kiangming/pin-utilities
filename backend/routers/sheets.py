"""
Sheets router — fetch Google Sheet pipeline data.

Routes:
  GET  /api/sheets/config          → trả về tab names + sheet URL config
  GET  /api/sheets/{tab}           → fetch 1 tab (cached)
  GET  /api/sheets/all             → fetch tất cả 4 tabs
  POST /api/sheets/refresh         → force-refresh cache
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse

from backend.middleware.auth_guard import require_session
from backend.models.schemas import SessionData, SheetsRefreshRequest
from backend.services import sheets_service

router = APIRouter(prefix="/api/sheets", tags=["sheets"])

VALID_TABS = {"release2026", "release2025", "close2026", "close2025"}


@router.get("/config")
async def get_config(_session: SessionData = Depends(require_session)):
    return JSONResponse({
        "tabs": sheets_service.TAB_NAMES,
        "cacheTtlSeconds": 300,
    })


@router.get("/all")
async def get_all(
    sheetUrl: str = Query(..., description="Google Sheet URL hoặc Sheet ID"),
    _session: SessionData = Depends(require_session),
):
    try:
        data = await sheets_service.fetch_all(sheetUrl, _session.access_token)
        return JSONResponse(data)
    except PermissionError:
        raise HTTPException(401, detail="AUTH_EXPIRED")
    except Exception as e:
        raise HTTPException(502, detail=str(e))


@router.get("/{tab}")
async def get_tab(
    tab: str,
    sheetUrl: str = Query(..., description="Google Sheet URL hoặc Sheet ID"),
    _session: SessionData = Depends(require_session),
):
    if tab not in VALID_TABS:
        raise HTTPException(404, detail=f"Unknown tab '{tab}'. Valid: {sorted(VALID_TABS)}")
    try:
        data = await sheets_service.fetch_tab(sheetUrl, tab, _session.access_token)
        return JSONResponse({"tab": tab, "count": len(data), "data": data})
    except PermissionError:
        raise HTTPException(401, detail="AUTH_EXPIRED")
    except Exception as e:
        raise HTTPException(502, detail=str(e))


@router.post("/refresh")
async def refresh_cache(
    body: SheetsRefreshRequest,
    sheetUrl: str = Query(...),
    _session: SessionData = Depends(require_session),
):
    sheets_service.invalidate(sheetUrl, body.tab)
    label = body.tab or "all tabs"
    return JSONResponse({"message": f"Cache cleared for {label}"})
