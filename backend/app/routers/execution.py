from fastapi import APIRouter

router = APIRouter()


@router.get("/status", summary="Execution connector status (placeholder)")
def execution_status():
    """Placeholder endpoint for execution / exchange connectors.

    Later this module will:
    - Show configured exchanges and connection health
    - Display last N executed orders
    - Provide test order functionality (e.g. ping testnet)
    """
    return {
        "exchanges": [],
        "note": "Execution module scaffold – wiring to exchanges and orders will be implemented later.",
    }
