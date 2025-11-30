# No-Mistake Autotrader v1 – Core Backend & Portal (Advanced Modules + Scaffolds)

This v1 codebase is the **implementation repo** for the advanced
`No_Mistake_Autotrader_Product_Spec_Advanced_Updated_Guardian` design.

In this version:

- The **first 4 modules** are implemented in an **advanced, enterprise-ready way**:
  1. Identity & Access (Auth) – with roles, active flags, JWT, `/me` endpoint
  2. Strategy Management – rich metadata, typed strategies, filters
  3. Market Data Aggregator – live data via ccxt, normalized tickers
  4. Prediction & AI Snapshot – structured prediction object and summary

- All **other modules** have their **architecture folders and API routers scaffolded**:
  - Opportunities (realtime opportunity finder)
  - Alerts
  - Portfolio
  - Guardian / Risk Watcher
  - Execution / Exchange connectors
  - Journal / Analytics

The scaffolds are intentionally light: they expose clean endpoints and return
placeholder structures so the overall architecture is ready for future
expansion without breaking the API surface.

A simple **web portal** is also included for interacting with v1.

---

## 1. Prerequisites

- Docker
- Docker Compose
- Internet access (for market data via ccxt)

---

## 2. Folder Structure

- `backend/` – FastAPI backend (advanced auth, strategies, market, prediction, and scaffolds)
- `frontend/` – Static portal (HTML/JS/CSS)
- `.github/workflows/ci-cd.yml` – CI pipeline (GitHub Actions)
- `docker-compose.yml` – Multi-service stack (Postgres, backend, frontend)
- `README_DEPLOYMENT.md` – This manual
- `CI_CD_SETUP.md` – CI/CD setup guide

---

## 3. How to Deploy

1. Copy the whole folder `no_mistake_v1_core` to your server or local machine.

2. In a terminal, go into the folder:

   ```bash
   cd no_mistake_v1_core
   ```

3. (Optional) Edit environment variables:

   - Open `docker-compose.yml`
   - Change:
     - `POSTGRES_PASSWORD`
     - `SECRET_KEY`

4. Start the stack:

   ```bash
   docker compose up --build
   ```

   This will start:

   - Postgres database (port 5433 on host)
   - FastAPI backend (port 8000 on host)
   - Nginx frontend (port 8080 on host)

5. Open the portal in your browser:

   - Frontend: `http://localhost:8080`
   - Backend API docs: `http://localhost:8000/docs`

---

## 4. Using the System (User Flow)

### 4.1 Register & Login (Advanced Auth Module)

1. Open `http://localhost:8080`
2. In the **Auth** section:
   - Register with email + password (+ optional role, defaults to `trader`)
   - Then login with same credentials
3. After login:
   - The portal stores the token in memory for this browser tab.
4. You can call `/auth/me` (via swagger) to inspect current user and role.

You can also test via API:

- `POST /auth/register`
- `POST /auth/token` (form data: `username`, `password`)
- `GET /auth/me` (with Bearer token)

---

### 4.2 Strategy Management (Advanced)

1. Go to Strategies section in portal.
2. Enter:
   - Name (e.g. "No-Mistake AVAX Core")
   - Description (optional)
   - Spec JSON, for example:

   ```json
   {
     "symbol": "AVAXUSDT",
     "risk_per_trade": 1.0,
     "timeframe": "4h",
     "max_open_positions": 3
   }
   ```

3. Click **Create Strategy**.
4. Use **Load Strategies** to see all your saved strategies.
5. You can also filter via API:
   - `GET /strategies/?type=no_mistake`
   - `GET /strategies/?status=active`

The backend stores strategy metadata including `type`, `risk_profile`,
`timeframe`, `status`, and raw `spec_json`.

---

### 4.3 Market Data – Live Ticker

1. In the **Market Data** section:
   - Enter `symbol` (e.g. `AVAXUSDT`)
   - Optionally change `exchange` (default: `binance`)
2. Click **Fetch Ticker**.
3. The system calls:

   - `GET /market/ticker/{symbol}?exchange=binance`

and displays normalized fields like:

- Last price
- 24h high/low
- 24h change %
- 24h base volume

---

### 4.4 Prediction Snapshot (Advanced Structure)

1. In the **Prediction** section:
   - Enter `symbol` (e.g. `AVAXUSDT`)
   - Optionally the `exchange` (default: `binance`)
2. Click **Fetch Prediction**.
3. The system calls:

   - `GET /predict/{symbol}?exchange=binance`

4. You will see:

- `trend` (up/down/sideways)
- `momentum_score` (-1 to 1)
- `volatility` (low/normal/high)
- Estimated `change_1h`, `change_4h`, `change_24h`
- A short `ai_summary` (string)
- `raw_ticker` containing the original ticker data

The module is **AI-ready** – you can later plug in a real LLM or ML
model to generate more advanced summaries or signals.

---

### 4.5 Scaffolded Modules (Architecture Ready)

The following endpoints currently return placeholder JSON but define the
**API surface & folder structure** for more advanced features:

- `GET /opportunities/` – Realtime opportunity finder scaffold
- `GET /alerts/` – Alerts module scaffold
- `GET /portfolio/summary` – Portfolio aggregator scaffold
- `GET /guardian/status` – Guardian / Risk Watcher scaffold
- `GET /execution/status` – Exchange connectors scaffold
- `GET /journal/` – Trade journal scaffold

These are deliberately simple so you can integrate them step by step
without restructuring the project.

---

## 5. Stopping the System

To stop:

```bash
cd no_mistake_v1_core
docker compose down
```

This stops all containers but keeps database data in the Docker volume `db_data`.

To wipe everything including DB data:

```bash
docker compose down -v
```

---

## 6. CI/CD

See `CI_CD_SETUP.md` for a detailed explanation of the GitHub Actions
pipeline that:

- Installs backend dependencies
- Compiles the backend to catch syntax errors
- Builds backend and frontend Docker images

You can extend it with:

- Docker registry push
- SSH-based deployment to your VPS

---

This v1 is now a **solid enterprise-grade base**:

- Advanced implementations for the first 4 critical modules
- Clean architecture and endpoint scaffolds for all remaining modules
- Ready to be extended module-by-module according to the full No-Mistake spec.
