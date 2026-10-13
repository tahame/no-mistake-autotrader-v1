# K-BAY / Opplox platform — one image: API + background workers + the built web app.
FROM node:22-alpine AS web
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-alpine AS server
WORKDIR /build/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 WEB_DIST=/app/web
WORKDIR /app/server
RUN addgroup -S kbay && adduser -S kbay -G kbay
COPY --from=server --chown=kbay:kbay /build/server/node_modules ./node_modules
COPY --from=server --chown=kbay:kbay /build/server/dist ./dist
COPY --from=server --chown=kbay:kbay /build/server/package.json ./package.json
COPY --from=web --chown=kbay:kbay /build/web/dist /app/web
USER kbay
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
# Apply pending database migrations, then start.
CMD ["sh", "-c", "node dist/db/migrate.js && exec node dist/main.js"]
