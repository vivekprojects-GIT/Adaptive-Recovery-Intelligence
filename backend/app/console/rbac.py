"""Roles and permissions, enforced on the server.

The UI hides what a role cannot do, but that is a convenience. Every console
endpoint declares the permission it needs and the check happens here, so a
crafted request from a Viewer is refused exactly like a button click would be.

Identity in the PoC is a header (X-User-Id) set by the persona switcher. In a
bank deployment this is replaced by the SSO session; nothing else changes.
"""
from __future__ import annotations

from fastapi import Depends, Header, HTTPException
from sqlalchemy.orm import Session

from ..core.database import get_db
from .models import RolePermission, User

ROLES = {
    "strategist": "Strategist",
    "leader": "Strategy Leader",
    "admin": "Platform Admin",
    "viewer": "Viewer",
}

# (key, label, description, category)
PERMISSIONS: list[tuple[str, str, str, str]] = [
    ("create_strategy", "Create Strategy", "Build and configure new recovery strategies", "Strategy Management"),
    ("edit_strategy", "Edit Strategy", "Modify existing strategy parameters", "Strategy Management"),
    ("launch_strategy", "Launch Strategy", "Activate an approved strategy against customer accounts", "Strategy Management"),
    ("pause_archive_strategy", "Pause / Archive", "Pause or retire a running strategy", "Strategy Management"),
    ("approve_strategy", "Approve Strategy", "Approve a submitted strategy (cannot approve your own)", "Strategy Management"),
    ("manage_treatments", "Manage Treatment Playbook", "Add, edit, retire and delete treatments and their eligibility rules", "Strategy Management"),
    ("view_kpi_dashboard", "View KPI Dashboard", "Access portfolio and performance KPIs", "Analytics & Reporting"),
    ("export_reports", "Export Reports", "Download performance and audit reports", "Analytics & Reporting"),
    ("compare_strategies", "Compare Strategies", "Access A/B comparison views", "Analytics & Reporting"),
    ("view_customer_list", "View Customer List", "Browse all accounts in the pipeline", "Customer Data"),
    ("view_ai_decisions", "View AI Decisions", "Inspect AI decision reasoning logs", "Customer Data"),
    ("override_decisions", "Override Decisions", "Replace or hold an AI decision, with a reason", "Customer Data"),
    ("view_compliance", "View Compliance", "See policy violations and compliance scores", "Governance"),
    ("resolve_violations", "Resolve Violations", "Investigate and close compliance violations", "Governance"),
    ("use_ai_workbench", "Use AI Workbench", "Analyse performance and draft improvement ideas", "Governance"),
    ("manage_users", "Manage Users", "Invite, deactivate and assign roles to users", "Administration"),
    ("manage_roles", "Manage Roles & Permissions", "Change what each role is allowed to do", "Administration"),
    ("configure_platform", "Configure Platform", "Change platform-wide decisioning settings", "Administration"),
    ("manage_integrations", "Manage Integrations", "Configure data feeds and channel gateways", "Administration"),
    ("view_audit_log", "View Audit Log", "Read the full platform audit trail", "Administration"),
    ("manage_alert_rules", "Manage Alert Rules", "Create and tune monitoring alerts", "Administration"),
    ("view_system_health", "View System Health", "See platform uptime, latency and job status", "Administration"),
]
PERMISSION_KEYS = [p[0] for p in PERMISSIONS]

DEFAULT_GRANTS: dict[str, set[str]] = {
    "strategist": {
        "create_strategy", "edit_strategy", "launch_strategy", "pause_archive_strategy",
        "manage_treatments", "view_kpi_dashboard", "compare_strategies", "view_customer_list",
        "view_ai_decisions", "override_decisions",
    },
    "leader": {
        "approve_strategy", "pause_archive_strategy", "view_kpi_dashboard", "export_reports",
        "compare_strategies", "view_customer_list", "view_ai_decisions", "view_compliance",
        "resolve_violations", "use_ai_workbench",
    },
    "admin": set(PERMISSION_KEYS),
    "viewer": {"view_kpi_dashboard"},
}

# A platform must never be configurable into a state with no way back in.
LOCKED: set[tuple[str, str]] = {("admin", "manage_roles"), ("admin", "manage_users")}


def granted(db: Session, role: str) -> set[str]:
    return {r.permission for r in db.query(RolePermission).filter_by(role=role, granted=True)}


def current_user(
    x_user_id: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> User:
    if not x_user_id:
        raise HTTPException(401, "No user on the request. Select a user in the console.")
    user = db.get(User, x_user_id)
    if not user:
        raise HTTPException(401, f"Unknown user {x_user_id}.")
    if user.status != "Active":
        raise HTTPException(403, f"{user.name}'s account is {user.status.lower()}.")
    return user


def require(*permissions: str):
    """Dependency factory: the user must hold every listed permission."""

    def check(user: User = Depends(current_user), db: Session = Depends(get_db)) -> User:
        have = granted(db, user.role)
        missing = [p for p in permissions if p not in have]
        if missing:
            labels = ", ".join(next(l for k, l, *_ in PERMISSIONS if k == m) for m in missing)
            raise HTTPException(
                403, f"{ROLES.get(user.role, user.role)} role does not have: {labels}.")
        return user

    return check
