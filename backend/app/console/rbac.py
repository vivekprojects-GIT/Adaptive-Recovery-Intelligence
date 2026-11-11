"""Roles and permissions, enforced on the server.

The UI hides what a role cannot do, but that is a convenience. Every console
endpoint declares the permission it needs and the check happens here, so a
crafted request from an Executive is refused exactly like a button click would be.

Identity in the PoC is a header (X-User-Id) set by the persona switcher. In a
bank deployment this is replaced by the SSO session; nothing else changes.
"""
from __future__ import annotations

from fastapi import Depends, Header, HTTPException
from sqlalchemy.orm import Session

from ..core.database import get_db
from .models import RolePermission, User

ROLES = {
    "strategist": "Strategy Analyst",
    "leader": "Executive",
    "admin": "Platform Admin",
}

# (key, label, description, category)
PERMISSIONS: list[tuple[str, str, str, str]] = [
    ("create_strategy", "Create strategies", "Build and configure new recovery strategies", "Strategy management"),
    ("edit_strategy", "Edit strategies", "Modify existing strategy parameters", "Strategy management"),
    ("launch_strategy", "Launch strategies", "Activate an approved strategy against customer accounts", "Strategy management"),
    ("pause_archive_strategy", "Pause or archive strategies", "Pause or retire a running strategy", "Strategy management"),
    ("approve_strategy", "Approve strategies", "Approve a submitted strategy (cannot approve your own)", "Strategy management"),
    ("manage_treatments", "Manage the treatment playbook", "Add, edit, retire and delete treatments and their eligibility rules", "Strategy management"),
    ("view_kpi_dashboard", "View the KPI dashboard", "Access portfolio and performance KPIs", "Analytics and reporting"),
    ("export_reports", "Export reports", "Download performance and audit reports", "Analytics and reporting"),
    ("compare_strategies", "Compare strategies", "Access A/B comparison views", "Analytics and reporting"),
    ("view_customer_list", "View the customer list", "Browse all accounts in the pipeline", "Customer data"),
    ("view_ai_decisions", "View decisions", "Inspect the reasoning behind each decision", "Customer data"),
    ("override_decisions", "Override decisions", "Replace or hold a decision, with a reason", "Customer data"),
    ("approve_placements", "Approve agency placements", "Approve, decline or recall placements with collection agencies", "Customer data"),
    ("view_compliance", "View compliance", "See policy violations and compliance scores", "Governance"),
    ("resolve_violations", "Resolve violations", "Investigate and close compliance violations", "Governance"),
    ("use_ai_workbench", "Use the strategy workbench", "Analyse performance and draft improvement ideas", "Governance"),
    ("manage_users", "Manage users", "Invite, deactivate and assign roles to users", "Administration"),
    ("manage_roles", "Manage roles and permissions", "Change what each role is allowed to do", "Administration"),
    ("configure_platform", "Configure the platform", "Change platform-wide decisioning settings", "Administration"),
    ("manage_integrations", "Manage integrations", "Configure data feeds and channel gateways", "Administration"),
    ("view_audit_log", "View the audit log", "Read the full platform audit trail", "Administration"),
    ("manage_alert_rules", "Manage alert rules", "Create and tune monitoring alerts", "Administration"),
    ("view_system_health", "View system health", "See platform uptime, latency and job status", "Administration"),
]
PERMISSION_KEYS = [p[0] for p in PERMISSIONS]

DEFAULT_GRANTS: dict[str, set[str]] = {
    "strategist": {
        "create_strategy", "edit_strategy", "launch_strategy", "pause_archive_strategy",
        "manage_treatments", "view_kpi_dashboard", "compare_strategies", "view_customer_list",
        "view_ai_decisions", "override_decisions",
    },
    "leader": {
        "approve_strategy", "approve_placements", "pause_archive_strategy", "view_kpi_dashboard", "export_reports",
        "compare_strategies", "view_customer_list", "view_ai_decisions", "view_compliance",
        "resolve_violations", "use_ai_workbench",
    },
    # Platform administration only: people, access and platform operation. No
    # customer records, account numbers or banking data (Kumar, Oct 2026).
    "admin": {"manage_users", "manage_roles", "configure_platform", "manage_integrations", "view_audit_log",
              "manage_alert_rules", "view_system_health"},
}

# Permissions that open customer, account or banking data. The admin role can
# never hold them, so an administrator cannot grant them back to themselves.
DATA_PERMISSIONS: set[str] = set(PERMISSION_KEYS) - DEFAULT_GRANTS["admin"]


def sees_customer_data(db: Session, role: str) -> bool:
    return "view_customer_list" in granted(db, role)

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


def require_any(*permissions: str):
    """Dependency factory: the user must hold at least one of the permissions."""

    def check(user: User = Depends(current_user), db: Session = Depends(get_db)) -> User:
        if not set(permissions) & granted(db, user.role):
            labels = " or ".join(next(l for k, l, *_ in PERMISSIONS if k == m) for m in permissions)
            raise HTTPException(403, f"{ROLES.get(user.role, user.role)} role does not have: {labels}.")
        return user

    return check


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
