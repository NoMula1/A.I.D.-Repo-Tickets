# syntax=docker/dockerfile:1

FROM node:22-alpine3.20 AS builder

# Install required dependencies for node-gyp
RUN apk add --no-cache make gcc g++ python3

# Install pnpm globally
RUN npm install -g pnpm

WORKDIR /build

# Copy scripts first and make start.sh executable
COPY --link scripts scripts
RUN chmod +x ./scripts/start.sh

# Copy package files and install production dependencies
COPY package.json pnpm-lock.yaml ./
RUN CI=true pnpm install --prod --frozen-lockfile

# Copy the rest of the source code
COPY --link . .

# -----------------------------
# Runner Stage
# -----------------------------
FROM node:22-alpine3.20 AS runner

LABEL org.opencontainers.image.source="https://github.com/discord-tickets/bot" \
      org.opencontainers.image.description="The most popular open-source ticket bot for Discord." \
      org.opencontainers.image.licenses="GPL-3.0-or-later"

# Install curl for healthchecks
RUN apk --no-cache add curl

# Create a non-root user
RUN adduser --disabled-password --home /home/container container

# Create working directories
RUN mkdir /app \
    && chown container:container /app \
    && chmod -R 777 /app \
    && mkdir -p /home/container/user /home/container/logs \
    && chown -R container:container /home/container

USER container

# Set environment variables
ENV USER=container \
    HOME=/home/container \
    NODE_ENV=production \
    HTTP_HOST=0.0.0.0 \
    DOCKER=true

WORKDIR /home/container

# Copy built app from builder
COPY --from=builder --chown=container:container --chmod=777 /build /app

# Expose the port Railway expects
EXPOSE 3000

# Entrypoint
ENTRYPOINT ["/app/scripts/start.sh"]

# Healthcheck for Railway
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s \
    CMD curl -f http://localhost:3000/status || exit 1
