from fastapi import APIRouter, HTTPException, Query
from .utils_ccxt import get_ticker

from ..schemas import MarketTicker

router = APIRouter()


@router.get("/ticker/{symbol}", response_model=MarketTicker)
def get_market_ticker(symbol: str, exchange: str = Query("binance", description="Exchange id for ccxt")):
    try:
        t = get_ticker(exchange, symbol)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    return MarketTicker(**t)
