# Shared base for the brownfield Mastodon tasks (docs/TASKS.md §3): `frugal-task-mastodon-base:<hash>`.
# Built by benchmark/tasks/mastodon/image.ts; both task images (mastodon-bookmarks, mastodon-filters)
# are FROM this image, so these layers exist once on disk.
#
# Debian 11 (bullseye) because it is the newest Debian that still has everything 2018/2019 Mastodon
# needs from apt: OpenSSL 1.1 (Ruby 2.5/2.6 cannot build against OpenSSL 3), python2 (node-gyp 3.x for
# node-sass 4.7 on the filters checkpoint) and ICU/protobuf/libidn versions the old native gems accept,
# while still being supported by Playwright's Chromium (glibc 2.31).
#
# Contents: build toolchain + native-gem libraries, PostgreSQL 13 + Redis 6 (run as uid 1000 by
# /opt/frugal/task/services), user `node` (uid/gid 1000), and a PRIVATE modern Node at /opt/frugal/node
# (not on PATH) with Playwright + Chromium at /opt/frugal/pw for /opt/frugal/task/pw-node.
# No project Ruby/Node here: those are per task (task.Dockerfile).
FROM debian:bullseye-slim@sha256:e5b6442dd2e9684cf5e87d8338b5968f3b348636fc0be6d7850a381e3731a2bd

ARG TARGETARCH
ARG PRIVATE_NODE_VERSION=22.21.1
ARG PRIVATE_NODE_SHA256_ARM64=e660365729b434af422bcd2e8e14228637ecf24a1de2cd7c916ad48f2a0521e1
ARG PRIVATE_NODE_SHA256_AMD64=680d3f30b24a7ff24b98db5e96f294c0070f8f9078df658da1bce1b9c9873c88
ARG PLAYWRIGHT_VERSION=1.49.1

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=Etc/UTC

COPY scripts/apt-sources.sh /opt/frugal/build/apt-sources.sh

# Don't let the postgresql package create (and start) a system cluster: services runs its own
# cluster as uid 1000 under /data.
RUN mkdir -p /etc/postgresql-common \
 && echo 'create_main_cluster = false' > /etc/postgresql-common/createcluster.conf \
 && sh /opt/frugal/build/apt-sources.sh \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils git gnupg procps less file tzdata util-linux \
      build-essential autoconf bison pkg-config python2 \
      libssl-dev libreadline-dev zlib1g-dev libyaml-dev libffi-dev libgdbm-dev libncurses5-dev \
      libxml2-dev libxslt1-dev libicu-dev libidn11-dev libprotobuf-dev protobuf-compiler \
      libpq-dev libpam0g-dev shared-mime-info imagemagick ffmpeg \
      postgresql-13 postgresql-client-13 redis-server \
 && rm -rf /var/lib/apt/lists/* /var/lib/postgresql/* \
 && groupadd -g 1000 node \
 && useradd -u 1000 -g 1000 -m -d /home/node -s /bin/bash node \
 && git config --system safe.directory '*' \
 && git config --system url."https://github.com/".insteadOf "git://github.com/"

# Private modern Node (Claude Code and Playwright). Deliberately NOT on PATH: `node`/`yarn` on PATH
# are the project's old versions (installed by task.Dockerfile).
RUN case "$TARGETARCH" in \
      arm64) arch=arm64; sum=$PRIVATE_NODE_SHA256_ARM64 ;; \
      amd64) arch=x64;   sum=$PRIVATE_NODE_SHA256_AMD64 ;; \
      *) echo "unsupported arch $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && f=node-v$PRIVATE_NODE_VERSION-linux-$arch.tar.xz \
 && curl -fsSLo /tmp/$f https://nodejs.org/dist/v$PRIVATE_NODE_VERSION/$f \
 && echo "$sum  /tmp/$f" | sha256sum -c - \
 && mkdir -p /opt/frugal/node \
 && tar -xJf /tmp/$f -C /opt/frugal/node --strip-components=1 --no-same-owner \
 && rm -f /tmp/$f \
 && /opt/frugal/node/bin/node --version

# Playwright + Chromium (headless shell) for the coding agent's own UI checks. `--with-deps`
# installs Chromium's shared libraries with apt (needs the apt sources fixed above).
RUN export PATH=/opt/frugal/node/bin:$PATH npm_config_cache=/tmp/.npm PLAYWRIGHT_BROWSERS_PATH=/opt/frugal/pw/browsers \
 && mkdir -p /opt/frugal/pw \
 && cd /opt/frugal/pw \
 && echo '{"name":"frugal-pw","private":true}' > package.json \
 && npm install --no-audit --no-fund --loglevel=error "playwright@$PLAYWRIGHT_VERSION" \
 && sh /opt/frugal/build/apt-sources.sh >/dev/null \
 && (npx playwright install --with-deps --only-shell chromium || npx playwright install --with-deps chromium) \
 && rm -rf /var/lib/apt/lists/* /tmp/.npm /root/.npm /root/.cache \
 && chmod -R a+rX /opt/frugal/pw

COPY task-bin/pw-node task-bin/pw-preload.cjs task-bin/pw-screenshot.js /opt/frugal/task/
RUN chmod 755 /opt/frugal/task/pw-node && chmod 644 /opt/frugal/task/pw-preload.cjs /opt/frugal/task/pw-screenshot.js \
 && printf '%s\n' \
      "const { chromium } = require('playwright');" \
      "(async () => { const b = await chromium.launch(); const p = await b.newPage();" \
      "  await p.setContent('<button>ok</button>'); console.log('chromium', b.version(), await p.textContent('button'));" \
      "  await b.close(); })().catch((e) => { console.error(e); process.exit(1); });" > /tmp/pw-smoke.js \
 && HOME=/tmp /opt/frugal/task/pw-node /tmp/pw-smoke.js \
 && rm -f /tmp/pw-smoke.js

CMD ["sleep", "infinity"]
