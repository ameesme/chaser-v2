ARG BUILD_FROM=ghcr.io/hassio-addons/base:15.0.1
FROM ${BUILD_FROM} as builder

# Install Node.js 20 and pnpm
RUN apk add --no-cache \
    nodejs=~20 \
    npm=~20 \
    && npm install -g pnpm@9

WORKDIR /build

# Copy package files first for better layer caching
COPY package.json pnpm-lock.yaml ./

# Install all dependencies (including dev dependencies for build)
RUN pnpm install --frozen-lockfile

# Copy source code and build
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY data ./data

# Build TypeScript
RUN pnpm run build

# Install production dependencies only in a clean directory
RUN pnpm install --frozen-lockfile --prod

# Stage 2: Runtime image
FROM ${BUILD_FROM}

# Install only Node.js runtime (no build tools)
RUN apk add --no-cache \
    nodejs=~20 \
    jq

WORKDIR /app

# Copy built application from builder
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/public ./public
COPY --from=builder /build/package.json ./

# Copy default data directory
COPY --from=builder /build/data ./data-default

# Copy startup script
COPY run.sh /
RUN chmod a+x /run.sh

CMD ["/run.sh"]
