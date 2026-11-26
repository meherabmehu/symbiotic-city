"""SQLite URL handling must work on every platform this project claims to run on.

`DATABASE_URL` accepts three shapes and one of them was broken on Windows. The
default (no `.env`) is fine because it is built from `Path`, but copying
`.env.example` on Windows produces ``sqlite:///C:/Users/.../data/x.db``, and the
parser tested for a leading ``/`` to decide "absolute". A drive letter is not a
slash, so that path was treated as relative and resolved against the repository
root -- yielding a path under the repository named after the drive letter, a
directory that cannot be created. The failure is silent until the engine tries to open the file.

These tests exercise the parser directly rather than going through the engine, so
they run identically on Linux, macOS and Windows.
"""
from __future__ import annotations

import os
from pathlib import Path, PureWindowsPath

import pytest

from app.core.config import REPO_DIR, Settings


def _settings(url: str) -> Settings:
    # _env_file=None so a developer's real .env cannot influence the assertion.
    return Settings(database_url=url, _env_file=None)


def test_posix_absolute_url():
    url = "sqlite:////tmp/symbiotic_test.db"
    resolved = _settings(url).sqlite_path
    assert resolved is not None
    if os.name == "nt":
        # A POSIX-rooted path has no native Windows drive. SQLite/Path anchors
        # it to the current drive, which is the only usable local equivalent.
        assert resolved == Path("/tmp/symbiotic_test.db").resolve()
    else:
        assert resolved == Path("/tmp/symbiotic_test.db")


def test_windows_absolute_url_is_not_resolved_against_the_repo():
    """The regression: a drive-letter path must not become <repo>/C:/..."""
    url = "sqlite:///C:/Users/USER/symbiotic-city/backend/data/symbiotic_city.db"
    resolved = _settings(url).sqlite_path

    assert resolved is not None
    assert PureWindowsPath(str(resolved)).is_absolute()
    assert resolved.as_posix() == "C:/Users/USER/symbiotic-city/backend/data/symbiotic_city.db"
    assert "/C:/" not in resolved.as_posix(), (
        "a Windows absolute path must not be prefixed as <repo>/C:/..."
    )


def test_relative_url_resolves_against_the_repository_root():
    """Relative paths are repo-relative, not cwd-relative, so uvicorn and pytest
    agree about which database they are using."""
    resolved = _settings("sqlite:///./data/x.db").sqlite_path
    assert resolved is not None
    assert resolved == (REPO_DIR / "./data/x.db").resolve()
    assert resolved.parent.parent == REPO_DIR


def test_bare_relative_url_also_resolves_against_the_repo():
    resolved = _settings("sqlite:///data/x.db").sqlite_path
    assert resolved == (REPO_DIR / "data/x.db").resolve()


@pytest.mark.parametrize(
    "url",
    [
        "postgresql+psycopg2://user@localhost:5432/db",
        "postgresql://user@localhost/db",
    ],
)
def test_non_sqlite_urls_have_no_path(url):
    assert _settings(url).sqlite_path is None


def test_default_url_is_absolute():
    """Whatever DATABASE_URL is set to, the resolved path is absolute.

    The default itself is built from ``Path``, so it is already absolute; the
    test suite overrides DATABASE_URL with a temp file, so the claim worth making
    is the property rather than the filename.
    """
    from app.core.config import settings

    resolved = settings.sqlite_path
    assert resolved is not None
    assert resolved.is_absolute()
    assert resolved == Path(resolved).resolve()


def test_env_example_points_at_the_default_database():
    """Copying `.env.example` must not move the database.

    It used to: the example said ``sqlite:///./data/symbiotic_city.db``, which
    resolves under the repository root, while the built-in default is
    ``backend/data/symbiotic_city.db``. A user who ran once without a `.env` and
    then copied the example was silently pointed at a different, empty file --
    their data looked deleted. Keeping the two in step is the fix, and this test
    is what stops them drifting apart again.
    """
    example = (REPO_DIR / ".env.example").read_text(encoding="utf-8")

    urls = [
        line.split("=", 1)[1].strip()
        for line in example.splitlines()
        if line.startswith("DATABASE_URL=")
    ]
    assert len(urls) == 1, "exactly one DATABASE_URL should be set, not a block of them"

    # The default is itself a computed f-string, so read it off the field rather
    # than restating the path here.
    builtin_default = Settings(
        database_url=Settings.model_fields["database_url"].default
    ).sqlite_path
    from_example = Settings(database_url=urls[0], _env_file=None).sqlite_path

    assert from_example == builtin_default
