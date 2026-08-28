FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
	CODEX_HOME=/data/codex
WORKDIR /app
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates bubblewrap \
	&& rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
# Pin global CLI versions so docker build is deterministic.
# Bump these versions deliberately when upstream packages ship features the spawner needs;
# otherwise a clean image rebuild won't silently inherit breaking changes.
RUN npm install -g @openai/codex@0.134.0 @anthropic-ai/claude-code@2.1.152 && npm cache clean --force
COPY --from=build /app/build ./build
COPY --from=build /app/static ./static
COPY --from=build /app/scripts/check-deploy-pair.mjs ./scripts/check-deploy-pair.mjs
COPY --from=build /app/scripts/deploy-doctor.mjs ./scripts/deploy-doctor.mjs
COPY --from=build /app/scripts/health-spark.mjs ./scripts/health-spark.mjs
RUN mkdir -p /data/codex /data/spawner /data/workspaces
EXPOSE 3000
CMD ["sh", "-c", "mkdir -p \"${CODEX_HOME:-/data/codex}\" /data/spawner /data/workspaces && npm start"]
