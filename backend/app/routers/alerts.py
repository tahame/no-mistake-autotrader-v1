from fastapi import APIRouter
from typing import List

router = APIRouter()


@router.get("/", summary="List alerts (placeholder)")
def list_alerts():
    """Placeholder endpoint for alerts.

    Later this will:
    - Return alerts from DB (opportunities, Guardian, executions, risk)
    - Support filters by type, severity, read/unread
    """
    return {
        "items": [],
        "note": "Alerts module scaffold – persistence & routing to be implemented later.",
    }
