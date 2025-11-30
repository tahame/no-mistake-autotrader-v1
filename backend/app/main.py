from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from .routers import (
    auth,
    strategies,
    market,
    prediction,
    opportunities,
    alerts,
    portfolio,
    guardian,
    execution,
    journal,
)

app = FastAPI(
    title="No-Mistake Autotrader v1 – Backend",
    version="1.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def root():
    return {
        "message": "No-Mistake Autotrader v1 backend is running",
        "modules": [
            "auth",
            "strategies",
            "market",
            "prediction",
            "opportunities (scaffold)",
            "alerts (scaffold)",
            "portfolio (scaffold)",
            "guardian (scaffold)",
            "execution (scaffold)",
            "journal (scaffold)",
        ],
    }


app.include_router(auth.router, prefix="/auth", tags=["auth"])
app.include_router(strategies.router, prefix="/strategies", tags=["strategies"])
app.include_router(market.router, prefix="/market", tags=["market"])
app.include_router(prediction.router, prefix="/predict", tags=["prediction"])
app.include_router(opportunities.router, prefix="/opportunities", tags=["opportunities"])
app.include_router(alerts.router, prefix="/alerts", tags=["alerts"])
app.include_router(portfolio.router, prefix="/portfolio", tags=["portfolio"])
app.include_router(guardian.router, prefix="/guardian", tags=["guardian"])
app.include_router(execution.router, prefix="/execution", tags=["execution"])
app.include_router(journal.router, prefix="/journal", tags=["journal"])
