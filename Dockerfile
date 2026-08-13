FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY patches ./patches
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN npm ci
COPY tsconfig.json eslint.config.js ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    DATA_DIR=/app/data
COPY package*.json ./
COPY patches ./patches
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
VOLUME ["/app/data"]
CMD ["node", "dist/src/index.js"]

FROM node:24-bookworm-slim AS supermemory-runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
COPY patches ./patches
RUN npm ci --omit=dev
ENV NODE_ENV=production \
    PORT=6767 \
    SUPERMEMORY_DATA_DIR=/var/lib/supermemory/data \
    SUPERMEMORY_INSTALL_DIR=/var/lib/supermemory/install \
    SUPERMEMORY_BIN_DIR=/var/lib/supermemory/bin
VOLUME ["/var/lib/supermemory"]
CMD ["npx", "supermemory", "local", "start", "--port", "6767"]
