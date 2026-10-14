# Pin the Node 22 Debian image; update the digest deliberately for security updates.
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS base
WORKDIR /app

FROM base AS dependencies
COPY package.json package-lock.json ./
RUN --mount=type=cache,id=coolify-mcp-npm,target=/root/.npm npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM base AS build
COPY package.json package-lock.json ./
RUN --mount=type=cache,id=coolify-mcp-npm,target=/root/.npm npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production PORT=3000
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist/src
COPY package.json ./
# Keep both the probe and COPY-created parent directory readable/traversable.
COPY --chmod=0555 docker/healthcheck.mjs ./docker/healthcheck.mjs
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "docker/healthcheck.mjs"]
CMD ["node", "dist/src/host.js"]
