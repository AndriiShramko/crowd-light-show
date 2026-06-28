# --- stage 1: fetch a static ffmpeg binary (keeps the runtime image small) ---
FROM node:20-bookworm-slim AS ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends curl xz-utils ca-certificates \
 && curl -fsSL https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz -o /tmp/ff.tar.xz \
 && mkdir -p /opt/ff && tar -xJf /tmp/ff.tar.xz -C /opt/ff --strip-components=1 \
 && /opt/ff/ffmpeg -version | head -1

# --- stage 2: install production deps (better-sqlite3 uses a prebuilt binary) ---
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

# --- stage 3: lean runtime, non-root ---
FROM node:20-bookworm-slim
ENV NODE_ENV=production FFMPEG_PATH=/usr/local/bin/ffmpeg DATA_DIR=/data PORT=3000
COPY --from=ffmpeg /opt/ff/ffmpeg /usr/local/bin/ffmpeg
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
