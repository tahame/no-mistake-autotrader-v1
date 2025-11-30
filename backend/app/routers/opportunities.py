from fastapi import APIRouter, Query
from typing import List

router = APIRouter()


@router.get("/", summary="List realtime opportunities (placeholder)")
def list_opportunities(
    exchange: str = Query("binance", description="Exchange id"),
    limit: int = Query(20, ge=1, le=100),
):
    """Placeholder endpoint for realtime opportunity finder.

    In future versions this will:
    - Scan multiple symbols on multiple exchanges
    - Rank them by opportunity_score
    - Enrich with prediction data
    """
    # For now we just return an empty list with metadata.
    return {
        "exchange": exchange,
        "limit": limit,
        "items": [],
        "note": "Opportunity Finder module scaffold – logic to be implemented in later versions.",
    }
