import uuid
from datetime import datetime
from sqlalchemy import Column, String, DateTime, Boolean, Text
from sqlalchemy.orm import relationship
from sqlalchemy.dialects.postgresql import JSONB

from .db import Base


def uuid_str():
    return str(uuid.uuid4())


class User(Base):
    __tablename__ = "users"

    id = Column(String, primary_key=True, default=uuid_str)
    email = Column(String, unique=True, index=True, nullable=False)
    password_hash = Column(String, nullable=False)
    role = Column(String, default="trader")  # e.g. admin, trader, viewer
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    strategies = relationship("Strategy", back_populates="user")


class Strategy(Base):
    __tablename__ = "strategies"

    id = Column(String, primary_key=True, default=uuid_str)
    user_id = Column(String, nullable=False, index=True)
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)

    # Strategy metadata for advanced use
    type = Column(String, default="no_mistake")  # e.g. no_mistake, grid, trend, custom
    risk_profile = Column(String, default="conservative")  # conservative, balanced, aggressive
    timeframe = Column(String, default="4h")
    status = Column(String, default="active")  # active, paused, archived

    spec_json = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    is_active = Column(Boolean, default=True)

    user = relationship("User", back_populates="strategies")
