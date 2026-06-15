FROM oven/bun:1 AS bun-source

FROM mcr.microsoft.com/playwright:v1.55.1-jammy

ENV DEBIAN_FRONTEND=noninteractive
# Skip browser binary downloads — Chrome is already in the base image and we connect via CDP
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

RUN set -eux; \
    for i in 1 2 3 4 5; do \
      apt-get update && apt-get install -y --no-install-recommends \
        xvfb x11vnc novnc websockify \
      && break \
      || { echo "apt attempt $i/5 failed, sleeping 15s" >&2; apt-get clean; sleep 15; }; \
    done; \
    rm -rf /var/lib/apt/lists/*

# Copy Bun from official image — avoids curl|bash installer
COPY --from=bun-source /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

COPY package.json ./
RUN bun install --production

COPY capture-server.ts .

EXPOSE 3001 6080

COPY start.sh /start.sh
RUN chmod +x /start.sh

ENTRYPOINT ["/start.sh"]
