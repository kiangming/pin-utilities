from pydantic import BaseModel
from typing import Optional


class UserInfo(BaseModel):
    email: str
    name: str
    picture: Optional[str] = None


class SessionData(BaseModel):
    session_id: str
    access_token: str
    refresh_token: Optional[str] = None
    expires_at: float          # unix timestamp
    user: UserInfo


class BatchStartRequest(BaseModel):
    filepath: str
    countries: list[str] = []


class SheetsRefreshRequest(BaseModel):
    tab: Optional[str] = None  # None = refresh all tabs
