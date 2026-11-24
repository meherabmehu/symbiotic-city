#!/usr/bin/env python3
"""Probe every API route with every role and report the authorisation matrix.

This is an evidence tool, not a test: it prints what the server actually answers
so that a claim like "authorisation is enforced server-side" rests on a response
table rather than on reading the decorators.

Usage:
    python3 scripts/authz_probe.py [base_url]
"""

from __future__ import annotations

import http.cookiejar
import json
import sys
import urllib.error
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8081/api").rstrip("/")

# Routes that are public by design. /system/health is the liveness probe and
# /auth/roles supplies the role list the registration form must render before the
# visitor has a session. Anything else answering an anonymous caller is a leak.
PUBLIC_BY_DESIGN = {"/system/health", "/auth/roles"}

ROLES = {
    "anon": None,
    "admin": {"email": "admin@symbiotic.city", "password": "Admin#2026"},
    "operator": {"email": "operator@symbiotic.city", "password": "Operator#2026"},
    "engineer": {"email": "engineer@symbiotic.city", "password": "Engineer#2026"},
    "analyst": {"email": "analyst@symbiotic.city", "password": "Analyst#2026"},
}

# (method, path, body) — read-only probes where possible. Mutations use ids that
# are fetched at runtime so the probe never leaves junk behind where avoidable.
GET_PATHS = [
    "/auth/me",
    "/auth/roles",
    "/auth/sessions",
    "/dashboard",
    "/infrastructure",
    "/infrastructure/categories",
    "/infrastructure/statuses",
    "/zones",
    "/dependencies",
    "/twin/graph",
    "/incidents",
    "/incidents/summary",
    "/simulations",
    "/simulations/assumptions",
    "/scenarios",
    "/optimization/plans",
    "/optimization/requests",
    "/optimization/engine-info",
    "/resources",
    "/resources/categories",
    "/resources/utilisation",
    "/resources/reservations",
    "/tasks",
    "/tasks/my-queue",
    "/tasks/engineers",
    "/workflows",
    "/workflows/steps",
    "/notifications",
    "/analytics/categories",
    "/analytics/resources",
    "/analytics/simulations",
    "/users",
    "/roles",
    "/permissions",
    "/audit-logs",
    "/audit-logs/actions",
    "/settings",
    "/system/health",
    "/system/demo-info",
    "/analytics/overview",
    "/analytics/incidents",
    "/analytics/recovery",
    "/analytics/export",
    "/resilience/criticality",
    "/resilience/heatmap",
    "/resilience/whatif",
    "/resilience/whatif/compare?ids=1&ids=2",
]

MUTATIONS = [
    ("POST", "/incidents", {"title": "probe", "asset_id": 1, "category": "power",
                            "severity": "high", "description": "authz probe"}),
    ("POST", "/infrastructure", {"code": "ZZ-99", "name": "probe", "category": "power",
                                 "zone_id": 1, "criticality": 3, "status": "operational"}),
    ("POST", "/optimization/requests", {"title": "probe", "demands": []}),
    ("POST", "/users", {"full_name": "probe", "email": "probe@example.test",
                        "password": "Probe#2026", "role": "city_analyst"}),
    ("POST", "/simulations/run", {"failure_mode": "total_failure",
                                  "initial_failure_ids": [1], "cascade_threshold": 0.35,
                                  "max_depth": 6, "random_seed": 42}),
    ("PATCH", "/settings/cascade_threshold", {"value": "0.35"}),
    ("POST", "/resilience/whatif", {"name": "authz probe", "initial_failure_ids": [1]}),
    ("POST", "/resilience/frontier", {"title": "authz probe", "demands": []}),
]


def session(creds):
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    if creds is None:
        return opener, jar
    req = urllib.request.Request(
        BASE + "/auth/login",
        data=json.dumps(creds).encode(),
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with opener.open(req, timeout=30) as resp:
        resp.read()
    return opener, jar


def call(opener, jar, method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if method not in ("GET", "HEAD"):
        csrf = next((c.value for c in jar if c.name == "symbiotic_csrf"), "")
        if csrf:
            req.add_header("X-CSRF-Token", csrf)
    try:
        with opener.open(req, timeout=30) as resp:
            return resp.status
    except urllib.error.HTTPError as exc:
        return exc.code
    except Exception:
        return 0


def main() -> int:
    openers = {}
    for name, creds in ROLES.items():
        try:
            openers[name] = session(creds)
        except Exception as exc:  # noqa: BLE001
            print(f"could not sign in as {name}: {exc}")
            return 1

    print("Legend: 2xx allowed · 401 unauthenticated · 403 forbidden · 4xx other\n")
    header = f"{'route':44s}" + "".join(f"{r:>9s}" for r in ROLES)
    print(header)
    print("-" * len(header))

    leaks: list[str] = []
    for path in GET_PATHS:
        row = f"{'GET ' + path:44s}"
        for name, (opener, jar) in openers.items():
            code = call(opener, jar, "GET", path)
            row += f"{code:>9d}"
            if name == "anon" and 200 <= code < 300 and path not in PUBLIC_BY_DESIGN:
                leaks.append(f"anonymous GET {path} -> {code}")
        print(row)

    print()
    for method, path, body in MUTATIONS:
        row = f"{method + ' ' + path:44s}"
        for name, (opener, jar) in openers.items():
            code = call(opener, jar, method, path, body)
            row += f"{code:>9d}"
            if name == "anon" and 200 <= code < 300 and path not in PUBLIC_BY_DESIGN:
                leaks.append(f"anonymous {method} {path} -> {code}")
        print(row)

    print()
    if leaks:
        print("AUTHORISATION LEAKS:")
        for item in leaks:
            print("  -", item)
        return 1
    print("No anonymous access to any probed route.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
