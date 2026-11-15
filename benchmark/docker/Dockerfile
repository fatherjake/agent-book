# Benchmark image: the immutable starter snapshot plus its installed dependencies.
# Built by benchmark/docker/image.ts (tag frugal-bench:<starterHash>). The build context is a
# temporary directory containing exactly this Dockerfile and starter/ (no node_modules).
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

# sqlite3 CLI lets the evaluator inspect application databases via `docker exec`.
# better-sqlite3 ships prebuilt binaries, so no compiler toolchain is needed.
RUN apt-get update \
 && apt-get install -y --no-install-recommends sqlite3 \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /workspace \
 && chown node:node /workspace

# Containers run with a read-only root fs; keep npm's cache and logs on the /tmp tmpfs.
ENV npm_config_cache=/tmp/.npm \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false \
    PORT=3000

USER node
WORKDIR /workspace
COPY --chown=node:node starter/ /workspace/
# --ignore-scripts: better-sqlite3 bundles prebuilt binaries (prebuilds/linux-*.node), but npm ci
# would still try `node-gyp rebuild` because binding.gyp exists. No other dependency needs scripts.
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && node -e "new (require('better-sqlite3'))(':memory:').prepare('select 1').get()" \
 && rm -rf /tmp/.npm

EXPOSE 3000
CMD ["sleep", "infinity"]
