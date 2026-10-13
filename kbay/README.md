# K-BAY — Opplox operations platform (Phase 1)

The back office and till for K-BAY: sales on tablets, the daily open/close, spends with
approvals, stock with recipes, partners' money, and reports. Multi-tenant (OPPLOX is the first
tenant) and built so modules can be split out later.

- `server/` — Node + Postgres API (`/api/v1`, docs at `/api/docs`)
- `web/` — the app (installable PWA for phones, tablets and desktop)
- `deploy/` — Docker Compose stack, Caddy site block, backups, and the VPS runbook
- `docs/ARCHITECTURE.md`, `docs/FORMULAS.md`

## Run locally
```bash
# Postgres 16 running locally with a superuser (see server/.env.example)
cd server && cp .env.example .env && npm ci
npm run migrate && npm run seed      # prints temporary passwords once
npm run dev                          # API on :8080
cd ../web && npm ci && npm run dev   # app on :5173 (proxies /api)
```

## Test
```bash
cd server && npm test     # maths, module boundaries, and a full trading day through the API
```

## Deploy
See `deploy/VPS_DEPLOY.md`.
