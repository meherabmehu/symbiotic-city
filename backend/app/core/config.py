"""Application configuration.

All values are environment driven so that the same image can run locally
(SQLite / no TLS) and in production (PostgreSQL / secure cookies).
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import field_validator, model_validator
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
    def effective_cookie_secure(self) -> bool:
        """Never send a session cookie over plaintext in production.

        The flag defaults to false so local HTTP development works without extra
        setup, but inheriting that default into a production deployment would
        ship a session cookie without the Secure attribute. Production wins here;
        a deployment that genuinely needs plaintext HTTP has to change the
        environment name, which is a deliberate act.
        """
        return self.cookie_secure or self.is_production

    @property
    def cors_origin_regex(self) -> str | None:
        """Sandbox preview origins, honoured outside production only.

        The pattern matches any *.e2b.app host, which is what makes a sandbox
        preview work and is unacceptable as an allow-list entry on a public
        deployment, so it is withdrawn once the environment is production.
        """
        if self.is_production:
            return None
        return r"https://.*\.e2b\.app|http://localhost:\d+|http://127\.0\.0\.1:\d+|http://localhost"

    @model_validator(mode="after")
    def _refuse_default_secret_in_production(self) -> "Settings":
        if self.is_production and self.secret_key == "dev-only-secret-change-me":
            raise ValueError(
                "SECRET_KEY is still the development default. Set a unique value "
                "before running with ENVIRONMENT=production."
            )
        return self

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
