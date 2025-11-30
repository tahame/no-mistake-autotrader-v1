from fastapi import APIRouter

router = APIRouter()


@router.get("/status", summary="Guardian status (placeholder)")
def guardian_status():
    """Placeholder endpoint for Guardian / Risk Watcher.

    Eventually this will:
    - Show which symbols are being monitored
    - Expose recent adjustment proposals
    - Indicate risk mode (manual / semi-auto / full-auto)
    """
    return {
        "enabled": False,
        "mode": "manual",
        "monitored_symbols": [],
        "note": "Guardian module scaffold – real-time logic to be added in Guardian Lite/Pro versions.",
    }
