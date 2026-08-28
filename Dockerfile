FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
# Copy only what the SvelteKit build needs. The repo-level .dockerignore
# additionally filters the build context. Avoids shipping repo-root planning
# docs, one-off migration scripts, secrets, and editor metadata into the
# intermediate image layers.
COPY src ./src
COPY static ./static
COPY scripts ./scripts
COPY svelte.config.js vite.config.ts tsconfig.json postcss.config.js tailwind.config.js ./
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
RUN npm install -g @openai/codex @anthropic-ai/claude-code && npm cache clean --force
COPY --from=build /app/build ./build
COPY --from=build /app/static ./static
COPY --from=build /app/scripts/check-deploy-pair.mjs ./scripts/check-deploy-pair.mjs
COPY --from=build /app/scripts/deploy-doctor.mjs ./scripts/deploy-doctor.mjs
COPY --from=build /app/scripts/health-spark.mjs ./scripts/health-spark.mjs
RUN mkdir -p /data/codex /data/spawner /data/workspaces
EXPOSE 3000
CMD ["sh", "-c", "mkdir -p \"${CODEX_HOME:-/data/codex}\" /data/spawner /data/workspaces && npm start"]
