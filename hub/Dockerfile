# syntax=docker/dockerfile:1
# Hub image (design.md D17): web build + hub build → runtime node:22-slim. Build context: repository root.
#   docker compose -f deploy/compose.yml build hub

ARG NODE_IMAGE=node:22-slim

# ---------- build: shared, hub, web, agent (the build the hub serves, change multi-user M5) ----------
FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY hub/package.json hub/
COPY web/package.json web/
COPY agent/package.json agent/
COPY e2e/package.json e2e/
COPY desktop/package.json desktop/
RUN npm ci --no-audit --no-fund --workspace shared --workspace hub --workspace web --workspace agent --include-workspace-root
COPY shared shared
COPY hub hub
COPY web web
COPY agent agent
# client-versions D6: the build the web bundle and dist/version.json name. The context is a git archive without .git,
# so deploy/deploy.sh passes the commit and the time; declared after the COPY layers to keep the npm ci layer cached.
ARG BUILD_COMMIT=dev
ARG BUILD_TIME=
ENV BUILD_COMMIT=${BUILD_COMMIT} \
    BUILD_TIME=${BUILD_TIME}
RUN npm run build -w shared && npm run build -w hub && npm run build -w web && npm run build -w agent
# /agent/agent-<version>.tgz: the contents of agent/dist at the archive root, no node_modules (the installer runs
# npm install --omit=dev: the SDK has a native binary per platform). The version is agent/package.json's.
RUN mkdir -p /src/agent-release \
 && V=$(node -p "require('./agent/package.json').version") \
 && tar -czf "/src/agent-release/agent-$V.tgz" -C agent/dist .

# ---------- production dependencies of hub only ----------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY hub/package.json hub/
COPY web/package.json web/
COPY agent/package.json agent/
COPY e2e/package.json e2e/
COPY desktop/package.json desktop/
RUN npm ci --no-audit --no-fund --omit=dev --workspace hub --workspace shared --include-workspace-root

# ---------- runtime ----------
FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    PORT=8080 \
    WEB_DIST_DIR=/app/web/dist \
    AGENT_DIST_DIR=/app/agent-release \
    INSTALLERS_DIR=/app/installers
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=build /src/package.json ./
COPY --from=build /src/shared/package.json shared/
COPY --from=build /src/shared/dist shared/dist
COPY --from=build /src/hub/package.json hub/
COPY --from=build /src/hub/dist hub/dist
COPY --from=build /src/hub/migrations hub/migrations
COPY --from=build /src/web/dist web/dist
COPY --from=build /src/agent-release agent-release
# install.sh / install.ps1 templates (__HUB_URL__ is substituted when served)
COPY deploy/agent installers
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "hub/dist/server.js"]
