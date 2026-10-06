"""The ARI Console API, one module per area. Every route names the permission it
requires (rbac.require), so the UI hiding a button is never the only guard.

Modules are included in this order, which is the order routes are matched in."""
from fastapi import APIRouter

from . import session, search, strategies, treatments, handoffs, dashboards, customers, decisions, compliance, workbench, reports, alerts, admin

router = APIRouter(prefix="/console", tags=["console"])
for _module in (session, search, strategies, treatments, handoffs, dashboards, customers, decisions, compliance, workbench, reports, alerts, admin):
    router.include_router(_module.router)
