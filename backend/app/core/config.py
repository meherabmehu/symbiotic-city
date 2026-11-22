"""Application configuration.

All values are environment driven so that the same image can run locally
(SQLite / no TLS) and in production (PostgreSQL / secure cookies).
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[2]
REPO_DIR = BACKEND_DIR.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(REPO_DIR / ".env", BACKEND_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "SYMBIOTIC CITY"
    api_prefix: str = "/api"
    environment: str = "development"

    # --- database -----------------------------------------------------------
    database_url: str = f"sqlite:///{BACKEND_DIR / 'data' / 'symbiotic_city.db'}"

    # --- auth ---------------------------------------------------------------
    secret_key: str = "dev-only-secret-change-me"
    access_token_expire_minutes: int = 480
    session_cookie_name: str = "symbiotic_session"
    csrf_cookie_name: str = "symbiotic_csrf"
    cookie_secure: bool = False
    cookie_domain: str | None = None

    # --- cors / proxy -------------------------------------------------------
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"

    # --- demo data ----------------------------------------------------------
    seed_demo_data: bool = True

    # --- misc ---------------------------------------------------------------
    auth_rate_limit_per_minute: int = 30
    reset_token_ttl_minutes: int = 30
    demo_reset_emails_to_console: bool = True

    @field_validator("cors_origins")
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.strip()

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def is_production(self) -> bool:
        return self.environment.lower() in {"production", "prod"}

    @property
    def sqlite_path(self) -> Path | None:
        if self.database_url.startswith("sqlite"):
            raw = self.database_url.split("///", 1)[-1]
            if raw.startswith("/"):
                return Path(raw)
            return (REPO_DIR / raw).resolve()
        return None


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
