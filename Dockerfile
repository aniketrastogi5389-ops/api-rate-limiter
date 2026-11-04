# ── Stage 1: Build ──────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production && \
    cp -R node_modules prod_modules && \
    npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ── Stage 2: Production ────────────────────────
FROM node:20-alpine AS production

WORKDIR /app

# Security: run as non-root
RUN addgroup -g 1001 -S nodejs && \
    adduser -S appuser -u 1001

COPY --from=builder /app/prod_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./

USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); })"

CMD ["node", "dist/index.js"]
