# Task image shared by every tiny-* task: `frugal-task-tiny:<hash>` (docs/TASKS.md §3).
# Built by benchmark/tasks/tiny/image.ts with the inputs in benchmark/tasks/tiny/build.json.
#
#   /workspace            tiny at the checkpoint, single-commit git history, uid 1000, clean tree
#                         .venv (uv sync --frozen) and ui/node_modules (npm ci) preinstalled (both git-ignored)
#   /usr/local            Python 3.12 (base image) + Node 22 + uv
#   /opt/frugal/pw        Playwright + Chromium for the coding agent's own UI checks (pw-node)
#   /opt/frugal/task/     services, app, pw-node (see the scripts)
#
# Offline at run time: UV_OFFLINE/UV_FROZEN make `uv run` use the baked .venv, npm never fetches.
FROM python:3.12-slim-bookworm

ARG TARGETARCH
ARG TINY_REPO
ARG TINY_COMMIT
ARG TINY_STRIP
ARG UV_VERSION
ARG NODE_VERSION
ARG NODE_SHA256_ARM64
ARG NODE_SHA256_AMD64
ARG PLAYWRIGHT_VERSION

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=Etc/UTC

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils git procps less file build-essential \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 1000 node \
 && useradd -u 1000 -g 1000 -m -d /home/node -s /bin/bash node \
 && git config --system safe.directory '*'

# Node (the UI toolchain and Claude Code share it).
RUN case "$TARGETARCH" in \
      arm64) arch=arm64; sum=$NODE_SHA256_ARM64 ;; \
      amd64) arch=x64;   sum=$NODE_SHA256_AMD64 ;; \
      *) echo "unsupported arch $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && f=node-v$NODE_VERSION-linux-$arch.tar.xz \
 && curl -fsSLo /tmp/$f https://nodejs.org/dist/v$NODE_VERSION/$f \
 && echo "$sum  /tmp/$f" | sha256sum -c - \
 && tar -xJf /tmp/$f -C /usr/local --strip-components=1 --no-same-owner --exclude='*.md' --exclude=LICENSE \
 && rm -f /tmp/$f \
 && node --version && npm --version \
 && pip install --no-cache-dir "uv==$UV_VERSION" \
 && uv --version

# Playwright + Chromium (headless shell) for the coding agent's own UI checks.
RUN export npm_config_cache=/tmp/.npm PLAYWRIGHT_BROWSERS_PATH=/opt/frugal/pw/browsers \
 && mkdir -p /opt/frugal/pw && cd /opt/frugal/pw \
 && echo '{"name":"frugal-pw","private":true}' > package.json \
 && npm install --no-audit --no-fund --loglevel=error "playwright@$PLAYWRIGHT_VERSION" \
 && apt-get update \
 && (npx playwright install --with-deps --only-shell chromium || npx playwright install --with-deps chromium) \
 && rm -rf /var/lib/apt/lists/* /tmp/.npm /root/.npm /root/.cache \
 && chmod -R a+rX /opt/frugal/pw

ENV PATH=/opt/frugal/task:/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin \
    UV_OFFLINE=1 \
    UV_FROZEN=1 \
    UV_PYTHON_DOWNLOADS=never \
    UV_CACHE_DIR=/tmp/.uv-cache \
    UV_LINK_MODE=copy \
    UV_NO_PROGRESS=1 \
    npm_config_cache=/tmp/.npm \
    npm_config_update_notifier=false \
    npm_config_audit=false \
    npm_config_fund=false \
    npm_config_offline=true

COPY scripts/make-checkpoint.sh /opt/frugal/build/
COPY task-bin/services task-bin/app task-bin/pw-node task-bin/pw-preload.cjs /opt/frugal/task/
RUN chmod 755 /opt/frugal/build/make-checkpoint.sh /opt/frugal/task/services /opt/frugal/task/app /opt/frugal/task/pw-node \
 && chmod 644 /opt/frugal/task/pw-preload.cjs \
 && mkdir -p /workspace && chown node:node /workspace

USER node
WORKDIR /workspace

# ---- checkpoint -----------------------------------------------------------------------------------
RUN /opt/frugal/build/make-checkpoint.sh /workspace "$TINY_REPO" "$TINY_COMMIT" $TINY_STRIP

# ---- dependencies (network only here, at build time) -----------------------------------------------
RUN UV_OFFLINE=0 UV_CACHE_DIR=/tmp/.uv-build uv sync --frozen --python /usr/local/bin/python3.12 \
 && rm -rf /tmp/.uv-build \
 && .venv/bin/python -c 'import core.api, sim; print("python deps OK")' \
 && cd ui && npm_config_offline=false npm ci --no-audit --no-fund --loglevel=error \
 && npm run build >/dev/null && rm -rf dist \
 && (rm -rf /tmp/.npm /tmp/* 2>/dev/null || true) \
 && echo "ui deps OK"

# ---- final checks: single-commit history, clean tree -----------------------------------------------
RUN test "$(git rev-list --count HEAD)" = 1 \
 && test -z "$(git status --porcelain)" || { git status --porcelain; exit 1; } \
 && printf '%s\n' \
      "const { chromium } = require('playwright');" \
      "(async () => { const b = await chromium.launch(); const p = await b.newPage();" \
      "  await p.setContent('<button>ok</button>'); console.log('chromium', b.version(), await p.textContent('button'));" \
      "  await b.close(); })().catch((e) => { console.error(e); process.exit(1); });" > /tmp/pw-smoke.js \
 && HOME=/tmp /opt/frugal/task/pw-node /tmp/pw-smoke.js \
 && rm -f /tmp/pw-smoke.js

CMD ["sleep", "infinity"]
