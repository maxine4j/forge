FROM node:24.22.0-trixie-slim AS manifests
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/backend-infrastructure/package.json packages/backend-infrastructure/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/frontend/package.json packages/frontend/package.json
COPY ollama-relay/package.json ollama-relay/package.json

FROM manifests AS build
RUN --mount=type=cache,id=forge-pnpm,target=/pnpm/store pnpm install --frozen-lockfile --ignore-scripts --store-dir /pnpm/store
COPY tsconfig.json ./
COPY packages/backend-infrastructure packages/backend-infrastructure
COPY ollama-relay ollama-relay
RUN pnpm --filter @forge/ollama-relay... build
RUN --mount=type=cache,id=forge-pnpm,target=/pnpm/store pnpm --config.inject-workspace-packages=true --filter @forge/ollama-relay deploy --prod --offline --store-dir /pnpm/store /relay

FROM node:24.22.0-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /relay/package.json ./package.json
COPY --from=build /relay/node_modules ./node_modules
COPY --from=build /relay/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
