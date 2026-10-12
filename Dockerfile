# ffmpeg comes from Alpine instead of ffmpeg-static: the static build would add
# ~80 MB per layer and is downloaded by a postinstall script we skip here.
FROM node:22-alpine

RUN apk add --no-cache ffmpeg tini

ENV NODE_ENV=production \
    PORT=3080 \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe \
    FILES_DIR=/data/files \
    TMPDIR=/data/tmp

WORKDIR /app

# --ignore-scripts skips the ffmpeg-static download; the binary above is used
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY server.js ./

# Uploads and generated files live on a volume, not in the image layers
RUN mkdir -p /data/files /data/tmp && chown -R node:node /data
VOLUME /data
USER node

EXPOSE 3080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3080/health >/dev/null || exit 1

# tini reaps the ffmpeg child processes and forwards signals
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
