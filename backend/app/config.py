import os
from pydantic import BaseSettings


class Settings(BaseSettings):
    PROJECT_NAME: str = "No-Mistake Autotrader v1 – Core Services"
    DATABASE_URL: str = os.getenv(
        "DATABASE_URL",
        "postgresql://postgres:postgres@db:5432/no_mistake_v1",
    )
    SECRET_KEY: str = os.getenv("SECRET_KEY", "CHANGE_ME_SUPER_SECRET_KEY")
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24
    OPENAI_API_KEY: str | None = os.getenv("OPENAI_API_KEY")

    class Config:
        env_file = ".env"


settings = Settings()
