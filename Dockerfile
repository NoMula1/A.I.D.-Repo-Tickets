# syntax=docker/dockerfile:1

# -----------------------------
# Builder stage
# -----------------------------
FROM node:22-alpine3.20 AS builder

# Install dependencies needed for node-gyp
RUN apk add --no-cache make gcc g++ python3

# Install pnpm
RUN npm install -g pnpm

WORKDIR /build

# Copy scripts first and set execute permissions
COPY --link scripts scripts
RUN chmod +x ./scripts/start.sh

# Copy package files and install production dependencies
COPY package.json pnpm-lock.yaml ./
RUN CI=true pnpm install --prod --frozen-lockfile

# Copy all remaining files
COPY --link . .

# -----------------------------
# Runner stage
# -----------------------------
FROM node:22-alpine3.20 AS runner

LABEL org.opencontainers.image.source="https://github.com/discord-tickets/bot" \
      org.opencontainers.image.description="The most popular open-source ticket bot for Discord." \
      org.opencontainers.image.licenses="GPL-3.0-or-later"

# Install curl for healthchecks
RUN apk --no-cache add curl

# Create a non-root user and directories
RUN adduser --disabled-password --home /home/container container
RUN mkdir -p /app /home/container/user /home/container/logs \
    && chown -R container:container /home/container /app \
    && chmod -R 777 /app /home/container

USER container
ENV USER=container \
    HOME=/home/container \
    NODE_ENV=production \
    HTTP_HOST=0.0.0.0 \
    DOCKER=true \
    PORT=3000

WORKDIR /home/container

# Copy built files from builder
COPY --from=builder --chown=container:container --chmod=777 /build /app

# Set entrypoint
ENTRYPOINT [ "/app/scripts/start.sh" ]

# Expose the port for Railway
EXPOSE $PORT

# Healthcheck for Railway
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s \
    CMD curl -f http://localhost:$PORT/status || exit 1
