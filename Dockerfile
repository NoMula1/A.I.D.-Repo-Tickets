# syntax=docker/dockerfile:1

FROM node:22-alpine3.20 AS builder

# Install required dependencies for node-gyp
RUN apk add --no-cache make gcc g++ python3

# Install pnpm
RUN npm install -g pnpm

WORKDIR /build

# Copy scripts and make start.sh executable
COPY --link scripts scripts
RUN chmod +x ./scripts/start.sh

# Copy package files and install dependencies
COPY package.json pnpm-lock.yaml ./
RUN CI=true pnpm install --prod --frozen-lockfile

# Copy the rest of the source code
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

# Create non-root user
RUN adduser --disabled-password --home /home/container container \
    && mkdir -p /home/container/user /home/container/logs \
    && chown -R container:container /home/container

# Set working environment
USER container
ENV USER=container \
    HOME=/home/container \
    NODE_ENV=production \
    HTTP_HOST=0.0.0.0 \
    DOCKER=true

WORKDIR /home/container

# Copy built files from builder
COPY --from=builder --chown=container:container --chmod=777 /build /app

# Expose default port
EXPOSE 3000

# ENTRYPOINT
ENTRYPOINT [ "/app/scripts/start.sh" ]

# Railway-compatible healthcheck using PORT environment variable
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s \
    CMD curl -f http://localhost:${PORT}/status || exit 1
