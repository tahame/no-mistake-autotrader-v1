from fastapi import APIRouter
from typing import Any

router = APIRouter()


@router.get("/summary", summary="Portfolio summary (placeholder)")
def portfolio_summary():
    """Placeholder endpoint for unified portfolio.

    Future responsibilities:
    - Aggregate balances and positions across exchanges
    - Compute total equity in USDT
    - Per-coin allocations and risk
    """
    return {
        "total_equity_usdt": None,
        "positions": [],
        "note": "Portfolio module scaffold – will be wired into exchanges and DB later.",
    }
