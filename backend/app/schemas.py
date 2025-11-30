from datetime import datetime
from typing import Optional, Any
from pydantic import BaseModel, EmailStr


# ---------- Users / Auth ----------

class UserCreate(BaseModel):
    email: EmailStr
    password: str
    role: str = "trader"


class UserOut(BaseModel):
    id: str
    email: EmailStr
    role: str
    is_active: bool
    created_at: datetime

    class Config:
        orm_mode = True


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


# ---------- Strategies ----------

class StrategyCreate(BaseModel):
    name: str
    description: Optional[str] = None
    type: str = "no_mistake"
    risk_profile: str = "conservative"
    timeframe: str = "4h"
    status: str = "active"
    spec_json: dict


class StrategyOut(BaseModel):
    id: str
    name: str
    description: Optional[str]
    type: str
    risk_profile: str
    timeframe: str
    status: str
    spec_json: dict
    is_active: bool
    created_at: datetime
    updated_at: datetime

    class Config:
        orm_mode = True


# ---------- Market & Prediction ----------

class MarketTicker(BaseModel):
    symbol: str
    exchange: str
    last: float
    bid: float | None = None
    ask: float | None = None
    high24h: float | None = None
    low24h: float | None = None
    change24h: float | None = None
    volume24h: float | None = None


class PredictionSnapshot(BaseModel):
    symbol: str
    exchange: str
    trend: str
    momentum_score: float
    volatility: str
    change_1h: float | None = None
    change_4h: float | None = None
    change_24h: float | None = None
    ai_summary: Optional[str] = None
    raw_ticker: dict[str, Any] | None = None
