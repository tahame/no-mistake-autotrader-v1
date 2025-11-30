from fastapi import APIRouter, HTTPException, Query
from .utils_ccxt import get_ticker
from ..schemas import PredictionSnapshot
import math

router = APIRouter()


def classify_volatility(spread_percent: float | None) -> str:
    if spread_percent is None:
        return "unknown"
    if spread_percent < 0.2:
        return "low"
    if spread_percent < 0.8:
        return "normal"
    return "high"


@router.get("/{symbol}", response_model=PredictionSnapshot)
def get_prediction(symbol: str, exchange: str = Query("binance", description="Exchange id for ccxt")):
    try:
        t = get_ticker(exchange, symbol)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    last = t["last"]
    high = t.get("high24h") or last
    low = t.get("low24h") or last
    change24 = t.get("change24h") or 0.0

    # simple trend signal: based on 24h change
    if change24 > 2:
        trend = "up"
    elif change24 < -2:
        trend = "down"
    else:
        trend = "sideways"

    # simple momentum score
    momentum_score = max(-1.0, min(1.0, (change24 / 20.0)))  # clamp between -1 and 1

    # volatility estimation from range
    if high and low and high != low:
        range_pct = abs(high - low) / ((high + low) / 2) * 100
    else:
        range_pct = 0.0

    vol_label = "low"
    if range_pct > 5:
        vol_label = "normal"
    if range_pct > 12:
        vol_label = "high"

    # approximate 1h and 4h change assuming 24h distributed (placeholder logic)
    change_24 = change24
    change_1h = change_24 / 24.0
    change_4h = change_24 / 6.0

    ai_summary = (
        f"{symbol.upper()} on {exchange}: trend looks {trend}, "
        f"24h change {change_24:.2f}%, volatility {vol_label}, "
        f"estimated hourly change {change_1h:.2f}%."
    )

    snap = PredictionSnapshot(
        symbol=symbol.upper(),
        exchange=exchange,
        trend=trend,
        momentum_score=float(round(momentum_score, 3)),
        volatility=vol_label,
        change_1h=float(round(change_1h, 3)),
        change_4h=float(round(change_4h, 3)),
        change_24h=float(round(change_24, 3)),
        ai_summary=ai_summary,
        raw_ticker=t,
    )
    return snap
