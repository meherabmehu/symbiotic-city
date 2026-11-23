#!/usr/bin/env python3
"""Summarise a Playwright JSON report as GitHub Actions annotations.

The sandbox this project is audited from cannot download Actions logs or
artifacts (Azure blob storage is blocked), so a red e2e run was previously
unreadable. Annotations, however, are served by the GitHub API.

This reads test-results/results.json and emits one ``::error::`` line per failure
with the spec, the test title and the first line of the actual error, so the
failure is diagnosable from ``gh api .../check-runs/<id>/annotations``.

Usage:
    python3 scripts/pw_summary.py [path/to/results.json]
Exit code is 0 when every test passed, 1 otherwise (so it can gate the job).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

DEFAULT = Path("frontend/test-results/results.json")


def walk(suite: dict, out: list[dict], trail: list[str]) -> None:
    title = suite.get("title") or ""
    path = trail + ([title] if title else [])
    for spec in suite.get("specs", []):
        for test in spec.get("tests", []):
            results = test.get("results", [])
            status = "passed" if results and all(r.get("status") == "passed" for r in results) else "failed"
            if test.get("status") == "skipped" or spec.get("ok") is True:
                status = "passed"
            message = ""
            for result in results:
                for error in result.get("errors", []) or []:
                    message = (error.get("message") or "").strip()
                    break
                if message:
                    break
                for step in result.get("steps", []) or []:
                    if step.get("error"):
                        message = str(step["error"])[:400]
                        break
                if message:
                    break
            out.append(
                {
                    "file": spec.get("file", ""),
                    "title": spec.get("title", ""),
                    "project": test.get("projectName", ""),
                    "status": status,
                    "message": message,
                }
            )
    for child in suite.get("suites", []):
        walk(child, out, path)


def main(argv: list[str]) -> int:
    path = Path(argv[1]) if len(argv) > 1 else DEFAULT
    if not path.exists():
        print(f"::error::Playwright produced no JSON report at {path} — the run died before any test.")
        return 1
    data = json.loads(path.read_text())
    tests: list[dict] = []
    for suite in data.get("suites", []):
        walk(suite, tests, [])

    failed = [t for t in tests if t["status"] != "passed"]
    print(f"::notice::Playwright: {len(tests) - len(failed)} passed, {len(failed)} failed, of {len(tests)} total")
    for test in failed:
        # The whole message, newlines folded, so the annotation alone is enough to
        # diagnose the failure without access to the job log.
        detail = " | ".join(
            line.strip() for line in (test["message"] or "no error recorded").splitlines() if line.strip()
        )[:1400]
        print(f"::error file={test['file']}::[{test['project']}] {test['title']} — {detail}")

    if failed:
        print(f"\n{len(failed)} failing test(s):")
        for test in failed:
            print(f"  - [{test['project']}] {test['file']} :: {test['title']}")
            for line in (test["message"] or "").splitlines()[:12]:
                print(f"      {line}")
        return 1
    print(f"All {len(tests)} Playwright tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
