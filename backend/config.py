from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Google OAuth
    google_client_id: str
    google_client_secret: str
    google_redirect_uri: str = "http://localhost:8080/auth/callback"

    # Session
    session_secret: str
    session_ttl_seconds: int = 86400 * 7  # 7 days

    # Sheets cache
    sheets_cache_ttl_seconds: int = 300   # 5 minutes

    # Supabase (SDK Version Management)
    supabase_url: str = ""
    supabase_service_key: str = ""
    adoption_warn_threshold: int = 80
    adoption_critical_threshold: int = 50

    # Ticket Reminder — External API
    ticket_api_base_url: str = "https://ticket.vnggames.net/integration/v1"
    ticket_api_client_id: str = ""
    ticket_api_client_secret: str = ""
    debug_ticket_api: bool = False

    # Server — Railway inject PORT tự động
    host: str = "0.0.0.0"
    port: int = 8080          # bị override bởi env var PORT trên Railway
    frontend_dir: str = "frontend"

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        # Railway dùng "PORT" (uppercase), pydantic-settings tự map PORT → port
        env_prefix = ""


settings = Settings()

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"

OAUTH_SCOPES = [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/spreadsheets.readonly",
]
