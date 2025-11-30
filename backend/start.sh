#!/bin/sh
set -e

python -c "from app.db import Base, engine; import app.models as m; Base.metadata.create_all(bind=engine)"

uvicorn app.main:app --host 0.0.0.0 --port 8000
