"""Canonical role and permission catalogue.

Permissions are strings of the form ``<resource>:<action>``. Roles are mapped to
permission sets here (single source of truth) and persisted to the database so
the assignment is auditable and admin-editable.
"""
from __future__ import annotations

from enum import StrEnum


class Role(StrEnum):
    SUPER_ADMIN = "super_admin"
    CITY_OPERATOR = "city_operator"
    FIELD_ENGINEER = "field_engineer"
    CITY_ANALYST = "city_analyst"


ROLE_LABELS: dict[str, str] = {
    Role.SUPER_ADMIN: "Super Admin",
    Role.CITY_OPERATOR: "City Operator",
    Role.FIELD_ENGINEER: "Field Engineer",
    Role.CITY_ANALYST: "City Analyst",
}

PERMISSIONS: dict[str, str] = {
    # infrastructure
    "infrastructure:read": "View infrastructure assets and dependencies",
    "infrastructure:write": "Create and update infrastructure assets",
    "infrastructure:delete": "Archive infrastructure assets",
    # digital twin
    "twin:read": "View the interactive city twin",
    # simulation
    "simulation:read": "View simulation runs and results",
    "simulation:run": "Create and execute failure simulations",
    # optimisation
    "optimization:read": "View optimisation requests and plans",
    "optimization:run": "Submit resource constrained optimisation requests",
    "optimization:approve": "Approve or reject recovery plans",
    # incidents
    "incident:read": "View incidents",
    "incident:write": "Create and update incidents",
    "incident:resolve": "Verify and resolve incidents",
    # tasks
    "task:read": "View repair tasks",
    "task:write": "Create and manage repair tasks",
    "task:execute": "Accept and progress assigned repair tasks",
    "task:verify": "Verify completed repair tasks",
    # resources
    "resource:read": "View resource inventory",
    "resource:write": "Manage resource inventory and reservations",
    # analytics
    "analytics:read": "View analytics dashboards",
    "analytics:export": "Export analytics reports",
    # administration
    "user:read": "View users",
    "user:manage": "Create, update, deactivate users and change roles",
    "settings:manage": "Manage system settings",
    "audit:read": "Read system audit logs",
    "workflow:read": "View workflow instances",
    "workflow:manage": "Advance or retry workflow instances",
}

ROLE_PERMISSIONS: dict[str, set[str]] = {
    Role.SUPER_ADMIN: set(PERMISSIONS.keys()),
    Role.CITY_OPERATOR: {
        "infrastructure:read",
        "infrastructure:write",
        "twin:read",
        "simulation:read",
        "simulation:run",
        "optimization:read",
        "optimization:approve",
        "incident:read",
        "incident:write",
        "incident:resolve",
        "task:read",
        "task:write",
        "task:verify",
        "resource:read",
        "analytics:read",
        "workflow:read",
        "workflow:manage",
    },
    Role.FIELD_ENGINEER: {
        "infrastructure:read",
        "twin:read",
        "incident:read",
        "task:read",
        "task:execute",
        "resource:read",
    },
    Role.CITY_ANALYST: {
        "infrastructure:read",
        "twin:read",
        "simulation:read",
        "simulation:run",
        "optimization:read",
        "optimization:run",
        "incident:read",
        "analytics:read",
        "analytics:export",
        "workflow:read",
    },
}

ROLE_DESCRIPTIONS: dict[str, str] = {
    Role.SUPER_ADMIN: "Full platform control: users, settings, audit trail.",
    Role.CITY_OPERATOR: "Runs the city: incidents, approvals, dispatch, verification.",
    Role.FIELD_ENGINEER: "Receives and executes assigned repair tasks in the field.",
    Role.CITY_ANALYST: "Simulates failures and builds constrained recovery plans.",
}


def permissions_for(role: str) -> set[str]:
    return ROLE_PERMISSIONS.get(role, set())
