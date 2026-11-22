"""SYMBIOTIC CITY API — application factory."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from app.api.routes import (
    admin,
    analytics,
    auth,
    incidents,
    infrastructure,
    optimization,
    resources,
    simulations,
    tasks,
    workflows,
)
from app.core.config import settings
from app.core.database import Base, engine, session_scope
from app.core.responses import error_body, install_error_handlers
from app.core.security import csrf_matches

logger = logging.getLogger("symbiotic")

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
CSRF_EXEMPT = {"/api/auth/login", "/api/auth/register", "/api/auth/forgot-password", "/api/auth/reset-password"}


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        response.headers.setdefault(
            "Permissions-Policy", "geolocation=(), microphone=(), camera=()"
        )
        return response


class CsrfMiddleware(BaseHTTPMiddleware):
    """Double-submit cookie check for state changing requests.

    The session cookie is httpOnly; the CSRF cookie is readable by the SPA and
    must be mirrored in the ``X-CSRF-Token`` header. A token is only required
    when a session cookie is present, so anonymous demo calls still work.
    """

    async def dispatch(self, request: Request, call_next):
        if (
            request.method not in SAFE_METHODS
            and request.url.path.startswith("/api")
            and request.url.path not in CSRF_EXEMPT
            and request.cookies.get(settings.session_cookie_name)
        ):
            cookie = request.cookies.get(settings.csrf_cookie_name)
            header = request.headers.get("x-csrf-token")
            if not csrf_matches(cookie, header):
                return JSONResponse(
                    status_code=403,
                    content=error_body(
                        "Your session token expired. Refresh the page and try again.",
                        "csrf_failed",
                    ),
                )
        return await call_next(request)


def create_app() -> FastAPI:
    @asynccontextmanager
    async def lifespan(_: FastAPI):
        Base.metadata.create_all(engine)
        if settings.seed_demo_data:
            from app.seed.demo import seed_all

            with session_scope() as db:
                summary = seed_all(db)
                logger.info("demo data ready: %s", summary)
        yield

    app = FastAPI(
        title="SYMBIOTIC CITY API",
        version="1.0.0",
        description=(
            "Self-Healing Urban Intelligence — a synthetic smart city digital twin with "
            "graph based cascading failure simulation, OR-Tools constrained recovery "
            "optimisation and an automated multi-step recovery workflow.\n\n"
            "All data is synthetic demonstration data for the fictional city of Aurora Vale."
        ),
        lifespan=lifespan,
        docs_url="/api/docs",
        redoc_url="/api/redoc",
        openapi_url="/api/openapi.json",
    )
    app.add_middleware(SecurityHeadersMiddleware)
    app.add_middleware(CsrfMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_origin_regex=r"https://.*\.e2b\.app|http://localhost:\d+|http://127\.0\.0\.1:\d+",
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["Content-Disposition"],
    )
    install_error_handlers(app)

    for router in (
        auth.router,
        infrastructure.router,
        simulations.router,
        optimization.router,
        incidents.router,
        tasks.router,
        resources.router,
        workflows.router,
        analytics.router,
        admin.router,
    ):
        app.include_router(router, prefix=settings.api_prefix)

    @app.get("/api/health", tags=["system"])
    def health():
        return {"success": True, "data": {"status": "ok", "service": "symbiotic-city-api"}}

    @app.get("/health", include_in_schema=False)
    def root_health():
        return {"status": "ok"}

    return app


app = create_app()
