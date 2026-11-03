# The whole app in one image: the server hosts the built frontend. Railway builds this (railway.json).

FROM node:24.18.0-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:24.18.0-slim
ENV NODE_ENV=production HOST=0.0.0.0
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/src ./src
COPY server/drizzle ./drizzle
COPY --from=web /app/web/dist /app/web/dist
USER node
# `exec` so the server gets the host's stop signal and shuts down cleanly.
CMD ["sh", "-c", "node src/db/migrate.ts && exec node src/server/main.ts"]
