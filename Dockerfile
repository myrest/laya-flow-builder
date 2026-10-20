FROM node:22-bookworm-slim AS laya-build

WORKDIR /workspace/laya
COPY laya/package.json laya/package-lock.json laya/tsconfig.json ./
COPY laya/src ./src
RUN npm ci && npm run build

FROM node:22-bookworm-slim AS build

WORKDIR /workspace/laya-flow-builder
COPY laya-flow-builder/package.json laya-flow-builder/package-lock.json ./
COPY --from=laya-build /workspace/laya/package.json /workspace/laya/package.json
COPY --from=laya-build /workspace/laya/dist /workspace/laya/dist
RUN npm ci

COPY laya-flow-builder/web/package.json laya-flow-builder/web/package-lock.json ./web/
RUN npm --prefix web ci

COPY laya-flow-builder/mcp/package.json laya-flow-builder/mcp/package-lock.json ./mcp/
RUN npm --prefix mcp ci

COPY laya-flow-builder/. .
RUN npm run typecheck && npm test && npm run build

FROM node:22-bookworm-slim AS production-dependencies

WORKDIR /workspace/laya
COPY laya/package.json laya/package-lock.json ./
RUN npm ci --omit=dev

WORKDIR /workspace/laya-flow-builder
COPY laya-flow-builder/package.json laya-flow-builder/package-lock.json ./
COPY --from=laya-build /workspace/laya/package.json /workspace/laya/package.json
COPY --from=laya-build /workspace/laya/dist /workspace/laya/dist
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS runtime

WORKDIR /workspace/laya-flow-builder
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    LAYA_DATA_DIR=/data \
    LAYA_CACHE=/models

COPY --from=production-dependencies --chown=node:node /workspace/laya-flow-builder/node_modules ./node_modules
COPY --from=production-dependencies --chown=node:node /workspace/laya/node_modules /workspace/laya/node_modules
COPY --from=production-dependencies --chown=node:node /workspace/laya/package.json /workspace/laya/package.json
COPY --from=production-dependencies --chown=node:node /workspace/laya/dist /workspace/laya/dist
COPY --chown=node:node laya-flow-builder/package.json ./
COPY --from=build --chown=node:node /workspace/laya-flow-builder/*.ts ./
COPY --from=build --chown=node:node /workspace/laya-flow-builder/web/dist ./web/dist

RUN mkdir -p /data /models && chown node:node /data /models
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15m --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["./node_modules/.bin/tsx", "server.ts"]
