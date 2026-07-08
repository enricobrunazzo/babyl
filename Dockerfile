# Signaling server Babyl (il frontend è statico: si deploya da web/dist)
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/
RUN npm ci --workspace=server --omit=dev

COPY shared/ shared/
COPY server/ server/

ENV NODE_ENV=production
EXPOSE 8787

CMD ["npm", "run", "start", "--workspace=server"]
