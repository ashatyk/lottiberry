# Dockerfile
# syntax=docker/dockerfile:1.7

#### Build
FROM node:22-bullseye AS build
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
  build-essential python3 pkg-config \
  libcairo2-dev libpango1.0-dev libjpeg-dev libpng-dev libgif-dev librsvg2-dev \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Копируем весь исходный код
COPY src ./src

# Пересобираем canvas под Linux
RUN npm rebuild canvas || true

#### Runtime
FROM node:22-slim AS runner
ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
  libcairo2 libpango-1.0-0 libjpeg62-turbo libpng16-16 libgif7 ffmpeg \
  && rm -rf /var/lib/apt/lists/*
ENV FFMPEG_PATH=/usr/bin/ffmpeg

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY package*.json ./

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>r.ok?0:1).then(process.exit)"
CMD ["node", "src/server.js"]
