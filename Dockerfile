# syntax=docker/dockerfile:1

# -----------------------------
# Build Stage
# -----------------------------
FROM node:22-alpine3.20 AS builder

# Install dependencies for node-gyp
RUN apk add --no-cache make gcc g++ python3

# Install pnpm
RUN npm install -g pnpm

WORKDIR /build

# Copy scripts and make start.sh executable
COPY --link scripts scripts
RUN chmod +x ./scripts/start.sh

# Copy package files and install production dependencies
COPY package.json pnpm-lock.yaml ./
RUN CI=true pnpm install --prod --frozen-lockfile

# Copy the rest of the app
COPY --link . .

# -----------------------------
# Runner Stage
# -----------------------------
FROM node:22-alpine3.20 AS runner

LABEL org.opencontainers.image.source=https://github.com/discord-tickets/bot \
      org.opencontainers.image.description="The most popular open-source ticket bot for Discord." \
      org.opencontainers.image.licenses="GPL-3.0-or-later"

RUN apk --no-cache add curl

# Create a non-root user
RUN adduser --disabled-password --home /home/container container \
    && mkdir -p /app /home/container/user /home/container/logs \
    && chown -R container:container /app /home/container \
    && chmod -R 777 /app /home/container

USER container

ENV USER=container \
    HOME=/home/container \
    NODE_ENV=production \
    HTTP_HOST=0.0.0.0 \
    PORT=80 \
    HTTP_PORT=80 \
    DOCKER=true

WORKDIR /home/container

# Copy app from builder
COPY --from=builder --chown=container:container --chmod=777 /build /app

# Entry point
ENTRYPOINT ["/app/scripts/start.sh"]

# Healthcheck using the /status endpoint
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s \
    CMD curl -f http://localhost:80/status || exit 1
