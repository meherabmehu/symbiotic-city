"""Production configuration guards.

These tests exist because three settings had development-shaped defaults that a
production deployment would have inherited without anybody noticing: a session
cookie without the Secure attribute, a wildcard CORS regex that admits any
sandbox-preview origin, and a working development secret.

The behaviour is asserted on the settings object rather than on the environment,
so nothing here needs a running server.
"""

from __future__ import annotations

import pytest

from app.core.config import Settings


def _production(**overrides: object) -> Settings:
    return Settings(environment="production", secret_key="x" * 48, **overrides)  # type: ignore[arg-type]


def test_cookie_is_secure_in_production_even_when_the_flag_is_unset() -> None:
    settings = _production()
    assert settings.cookie_secure is False, "the raw default stays false for local HTTP"
    assert settings.effective_cookie_secure is True, "production must never omit Secure"


def test_cookie_is_not_forced_secure_outside_production() -> None:
    settings = Settings(environment="test", secret_key="y" * 48)
    assert settings.effective_cookie_secure is False


def test_cookie_secure_flag_is_still_honoured_in_production() -> None:
    assert _production(cookie_secure=True).effective_cookie_secure is True


def test_preview_origin_regex_is_withdrawn_in_production() -> None:
    settings = _production()
    assert settings.cors_origin_regex is None, "a wildcard sandbox origin must not survive production"


def test_preview_origin_regex_is_available_for_local_development() -> None:
    regex = Settings(environment="development").cors_origin_regex
    assert regex is not None
    assert "e2b" in regex


def test_production_refuses_to_boot_with_the_development_secret() -> None:
    with pytest.raises(Exception) as excinfo:
        Settings(environment="production")
    assert "SECRET_KEY" in str(excinfo.value)


def test_production_accepts_a_real_secret() -> None:
    # No exception: the guard is about the default value, not about length.
    assert _production().is_production is True
