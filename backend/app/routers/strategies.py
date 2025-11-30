import json
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from .. import models, schemas
from ..db import get_db
from ..security import get_current_user

router = APIRouter()


@router.post("/", response_model=schemas.StrategyOut)
def create_strategy(
    strategy_in: schemas.StrategyCreate,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    strategy = models.Strategy(
        user_id=user.id,
        name=strategy_in.name,
        description=strategy_in.description,
        type=strategy_in.type,
        risk_profile=strategy_in.risk_profile,
        timeframe=strategy_in.timeframe,
        status=strategy_in.status,
        spec_json=json.dumps(strategy_in.spec_json),
    )
    db.add(strategy)
    db.commit()
    db.refresh(strategy)
    return _to_out(strategy)


@router.get("/", response_model=list[schemas.StrategyOut])
def list_strategies(
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
    type: Optional[str] = Query(None, description="Filter by strategy type"),
    status: Optional[str] = Query(None, description="Filter by status"),
):
    q = db.query(models.Strategy).filter(models.Strategy.user_id == user.id)
    if type:
        q = q.filter(models.Strategy.type == type)
    if status:
        q = q.filter(models.Strategy.status == status)
    items = q.order_by(models.Strategy.created_at.desc()).all()
    return [_to_out(s) for s in items]


def _to_out(s: models.Strategy) -> schemas.StrategyOut:
    return schemas.StrategyOut(
        id=s.id,
        name=s.name,
        description=s.description,
        type=s.type,
        risk_profile=s.risk_profile,
        timeframe=s.timeframe,
        status=s.status,
        spec_json=json.loads(s.spec_json),
        is_active=s.is_active,
        created_at=s.created_at,
        updated_at=s.updated_at,
    )
