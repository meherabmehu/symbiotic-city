"""Small in-process sliding-window rate limiter.

Deliberately dependency free: appropriate for a single-node deployment. In a
multi-replica deployment this would move to Redis (see docs/deployment.md).
"""
from __future__ import annotations

import time
from collections import deque
from threading import Lock

from fastapi import Request, status

from app.core.config import settings
from app.core.responses import ApiError


class SlidingWindowLimiter:
    def __init__(self, limit: int, window_seconds: int = 60) -> None:
        self.limit = limit
        self.window = window_seconds
        self._hits: dict[str, deque[float]] = {}
        self._lock = Lock()

    def check(self, key: str) -> tuple[bool, int]:
        now = time.monotonic()
        with self._lock:
            bucket = self._hits.setdefault(key, deque())
            while bucket and now - bucket[0] > self.window:
                bucket.popleft()
            if len(bucket) >= self.limit:
                retry_after = int(self.window - (now - bucket[0])) + 1
                return False, retry_after
            bucket.append(now)
            return True, 0

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


auth_limiter = SlidingWindowLimiter(settings.auth_rate_limit_per_minute)
write_limiter = SlidingWindowLimiter(max(60, settings.auth_rate_limit_per_minute * 6))


def _key(request: Request, scope: str) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    ip = forwarded.split(",")[0].strip() if forwarded else (request.client.host if request.client else "unknown")
    return f"{scope}:{ip}"


def enforce_auth_limit(request: Request) -> None:
    allowed, retry = auth_limiter.check(_key(request, "auth"))
    if not allowed:
        raise ApiError(
            f"Too many attempts. Try again in {retry} seconds.",
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            code="rate_limited",
            details={"retry_after": retry},
        )


def enforce_write_limit(request: Request) -> None:
    allowed, retry = write_limiter.check(_key(request, "write"))
    if not allowed:
        raise ApiError(
            "Too many requests in a short period. Please slow down.",
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            code="rate_limited",
            details={"retry_after": retry},
        )
