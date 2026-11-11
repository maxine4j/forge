FROM node:24.22.0-trixie-slim AS base
WORKDIR /app
RUN corepack enable

FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/backend-infrastructure/package.json packages/backend-infrastructure/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/frontend/package.json packages/frontend/package.json
RUN apt-get update && apt-get install -y --no-install-recommends python3=3.13.5-1 make=4.4.1-2 g++=4:14.2.0-1 && rm -rf /var/lib/apt/lists/*
ENV npm_config_build_from_source=true

FROM manifests AS builder
RUN --mount=type=cache,id=forge-pnpm,target=/pnpm/store pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY tsconfig.json tsconfig.build.json ./
COPY packages packages
COPY src src
RUN pnpm build

FROM manifests AS installer
RUN --mount=type=cache,id=forge-pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile --filter @forge/app... --store-dir /pnpm/store

FROM docker/sandbox-templates:codex@sha256:a68b972a59148c6359ade441387159033f6d196d48aef9dda06d2d4bb26eb41e AS runner
USER root
WORKDIR /app
ARG BUILD_SHA=unknown
LABEL org.opencontainers.image.revision=$BUILD_SHA
# Preserve the template's development tools while using Forge's tested Node runtime.
COPY --from=base /usr/local/bin/node /usr/local/bin/node
COPY --from=base /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx && ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack && corepack enable
ENV NVM_DIR=/opt/nvm
ENV NPM_CONFIG_PREFIX=""
RUN git clone --depth 1 --branch v0.40.8 https://github.com/nvm-sh/nvm.git "$NVM_DIR" && rm -rf "$NVM_DIR/.git"
# Give nvm the same Node distribution as Forge's system runtime.
COPY --from=base /usr/local/bin/node /opt/nvm/versions/node/v24.22.0/bin/node
COPY --from=base /usr/local/lib/node_modules /opt/nvm/versions/node/v24.22.0/lib/node_modules
COPY --from=base /usr/local/include/node /opt/nvm/versions/node/v24.22.0/include/node
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js "$NVM_DIR/versions/node/v24.22.0/bin/npm" && \
    ln -s ../lib/node_modules/npm/bin/npx-cli.js "$NVM_DIR/versions/node/v24.22.0/bin/npx" && \
    ln -s ../lib/node_modules/corepack/dist/corepack.js "$NVM_DIR/versions/node/v24.22.0/bin/corepack" && \
    /bin/bash -c '. "$NVM_DIR/nvm.sh" && nvm use 24.22.0 && nvm alias default 24.22.0' && \
    chown -R agent:agent "$NVM_DIR"
COPY nvm-profile.sh /etc/profile.d/forge-nvm.sh
ENV NODE_ENV=production
COPY --from=installer /app/package.json ./
COPY --from=installer /app/node_modules ./node_modules
COPY --from=installer /app/packages/backend-infrastructure/package.json packages/backend-infrastructure/package.json
COPY --from=installer /app/packages/backend-infrastructure/node_modules packages/backend-infrastructure/node_modules
COPY --from=builder /app/packages/backend-infrastructure/dist packages/backend-infrastructure/dist
COPY --from=installer /app/packages/contracts/package.json packages/contracts/package.json
COPY --from=installer /app/packages/contracts/node_modules packages/contracts/node_modules
COPY --from=builder /app/packages/contracts/dist packages/contracts/dist
COPY --from=builder /app/packages/frontend/dist packages/frontend/dist
COPY --from=builder /app/dist dist
RUN mkdir -p /data && chown agent:agent /data && chmod 0700 /data && \
    install -d -m 0755 -o agent -g agent /run/forge && \
    git config --system --add include.path /run/forge/gitconfig
ENV PATH="/app/node_modules/.bin:/usr/local/bin:${PATH}"
USER agent
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js", "--container-git-config"]
