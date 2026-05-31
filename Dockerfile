# ═══════════════════════════════════════════
# Khonshu — Discord DAVE E2EE Music Selfbot
# Optimized for Dokploy deployment
# ═══════════════════════════════════════════

FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies for native modules (sodium-native, better-sqlite3)
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    gcc \
    musl-dev \
    libtool \
    autoconf \
    automake

# Set ownership of /app to node user
RUN chown -R node:node /app

# Switch to the node user
USER node

# Copy dependency files first with correct ownership
COPY --chown=node:node package.json package-lock.json patch-stream.js ./

# Install node dependencies
RUN npm ci --omit=dev

# ─── Final stage ───
FROM node:20-alpine

WORKDIR /app

# Install runtime dependencies: ffmpeg, python3, yt-dlp
RUN apk add --no-cache \
    ffmpeg \
    python3 \
    py3-pip \
    && pip3 install --break-system-packages yt-dlp \
    && rm -rf /root/.cache

# Copy built node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application source
COPY . .

# ─── Environment Variables (set these in Dokploy) ───
# TOKEN    = Your Discord user token (REQUIRED)
# OWNER    = Your Discord user ID (REQUIRED)
# PREFIX   = Command prefix (default: $)
ENV NODE_ENV=production

# Start the bot
CMD ["node", "index.js"]
