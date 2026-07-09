# --- Stage 1: build della SPA -----------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci

COPY shared/ shared/
COPY server/ server/
COPY web/ web/

# Config incorporata nel bundle al build (es. TURN):
# VITE_ICE_SERVERS=[{"urls":"turn:...","username":"u","credential":"c"}]
ARG VITE_ICE_SERVERS=
ENV VITE_ICE_SERVERS=$VITE_ICE_SERVERS
RUN npm run build --workspace=web

# --- Stage 2: runtime — signaling server + SPA statica sulla stessa porta ---
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY server/package.json server/
RUN npm ci --workspace=server --omit=dev

COPY shared/ shared/
COPY server/ server/
COPY --from=build /app/web/dist web/dist

ENV STATIC_DIR=/app/web/dist
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1

CMD ["npm", "run", "start", "--workspace=server"]
