import ccxt


def get_exchange(exchange_id: str):
    try:
        ex_class = getattr(ccxt, exchange_id)
    except AttributeError:
        raise ValueError(f"Unsupported exchange: {exchange_id}")
    return ex_class({"enableRateLimit": True})


def get_ticker(exchange_id: str, symbol: str) -> dict:
    ex = get_exchange(exchange_id)
    # normalize symbol to ccxt format (e.g. AVAX/USDT)
    if symbol.endswith("USDT") and "/" not in symbol:
        symbol_ccxt = symbol.replace("USDT", "/USDT")
    else:
        symbol_ccxt = symbol
    t = ex.fetch_ticker(symbol_ccxt)
    return {
        "symbol": symbol.upper(),
        "exchange": exchange_id,
        "last": float(t.get("last") or 0.0),
        "bid": float(t.get("bid") or 0.0) if t.get("bid") is not None else None,
        "ask": float(t.get("ask") or 0.0) if t.get("ask") is not None else None,
        "high24h": float(t.get("high") or 0.0) if t.get("high") is not None else None,
        "low24h": float(t.get("low") or 0.0) if t.get("low") is not None else None,
        "change24h": float(t.get("percentage") or 0.0) if t.get("percentage") is not None else None,
        "volume24h": float(t.get("baseVolume") or 0.0) if t.get("baseVolume") is not None else None,
    }
