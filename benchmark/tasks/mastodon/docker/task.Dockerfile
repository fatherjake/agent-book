# Task image for a brownfield Mastodon task: `frugal-task-<taskId>:<hash>` (docs/TASKS.md §3).
# Built by benchmark/tasks/mastodon/image.ts from the shared base; the per-task versions come from
# benchmark/tasks/<taskId>/docker/build.json (passed as build args) and the per-task patches from
# benchmark/tasks/<taskId>/docker/patches/ (copied to task/patches in the build context).
#
#   /workspace                 Mastodon at the checkpoint, single-commit git history, uid 1000, clean
#   /usr/local                 project Ruby + Node + Yarn (the versions the checkpoint expects)
#   /opt/frugal/bundle         gems (BUNDLE_PATH; all groups incl. development/test)
#   /opt/frugal/data-template  Postgres/Redis data with dev+test DBs and the schema loaded
#   /data                      empty mount point (anonymous volume in the sandbox)
#   /opt/frugal/task/          services, app, pw-node (see the scripts)
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG TARGETARCH
ARG TASK_ID
ARG MASTODON_COMMIT
ARG RUBY_VERSION
ARG RUBY_SHA256
ARG BUNDLER_VERSION
ARG NODE_VERSION
ARG NODE_SHA256_ARM64
ARG NODE_SHA256_AMD64
ARG YARN_VERSION
ARG YARN_SHA256

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# ---- project Ruby (from source; -fcommon so 2018-era C extensions build with gcc 10) -------------
RUN curl -fsSLo /tmp/ruby.tar.gz "https://cache.ruby-lang.org/pub/ruby/${RUBY_VERSION%.*}/ruby-$RUBY_VERSION.tar.gz" \
 && echo "$RUBY_SHA256  /tmp/ruby.tar.gz" | sha256sum -c - \
 && mkdir -p /tmp/ruby && tar -xzf /tmp/ruby.tar.gz -C /tmp/ruby --strip-components=1 \
 && cd /tmp/ruby \
 && ./configure --prefix=/usr/local --enable-shared --disable-install-doc optflags='-O2 -fcommon' >/dev/null \
 && make -j"$(nproc)" >/dev/null \
 && make install >/dev/null \
 && cd / && rm -rf /tmp/ruby /tmp/ruby.tar.gz \
 && ruby -v && ruby -ropenssl -rpsych -rreadline -rzlib -e 'puts OpenSSL::OPENSSL_LIBRARY_VERSION' \
 && gem install bundler -v "$BUNDLER_VERSION" --no-document \
 && bundle -v

# ---- project Node + Yarn -------------------------------------------------------------------------
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
 && curl -fsSLo /tmp/yarn.tgz "https://github.com/yarnpkg/yarn/releases/download/v$YARN_VERSION/yarn-v$YARN_VERSION.tar.gz" \
 && echo "$YARN_SHA256  /tmp/yarn.tgz" | sha256sum -c - \
 && mkdir -p /opt/yarn && tar -xzf /tmp/yarn.tgz -C /opt/yarn --strip-components=1 --no-same-owner \
 && ln -sf /opt/yarn/bin/yarn /usr/local/bin/yarn && ln -sf /opt/yarn/bin/yarnpkg /usr/local/bin/yarnpkg \
 && rm -f /tmp/yarn.tgz \
 && node --version && yarn --version

# ---- runtime environment ---------------------------------------------------------------------------
# Deliberately NOT set (deviation from the letter of TASKS.md §3, same effect):
#  * RAILS_ENV: Rails defaults to development, and spec/rails_helper.rb does
#    `ENV['RAILS_ENV'] ||= 'test'`, so a baked RAILS_ENV=development would make `rspec` run against
#    the development database.
#  * LOCAL_DOMAIN / LOCAL_HTTPS / NODE_ENV: .env.test sets them for the test env, and dotenv never
#    overrides variables that are already set (upstream specs assert on cb6e6126.ngrok.io URLs).
#    Development falls back to localhost:$PORT.
# Dev/test secrets (secret_key_base) are committed upstream in config/secrets.yml; nothing secret here.
ENV FRUGAL_TASK_ID=${TASK_ID} \
    PATH=/opt/frugal/task:/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin \
    DB_HOST=127.0.0.1 \
    DB_PORT=5432 \
    DB_USER=mastodon \
    DB_PASS= \
    PGHOST=127.0.0.1 \
    PGPORT=5432 \
    PGUSER=mastodon \
    PGDATABASE=mastodon_development \
    REDIS_HOST=127.0.0.1 \
    REDIS_PORT=6379 \
    REDIS_URL=redis://127.0.0.1:6379/0 \
    BUNDLE_PATH=/opt/frugal/bundle \
    BUNDLE_APP_CONFIG=/opt/frugal/bundle-config \
    BUNDLE_WITH=pam_authentication \
    BUNDLE_FROZEN=true \
    BUNDLE_SILENCE_ROOT_WARNING=1 \
    DISABLE_SPRING=1 \
    YARN_CACHE_FOLDER=/tmp/.yarn-cache \
    npm_config_cache=/tmp/.npm \
    npm_config_update_notifier=false \
    npm_config_python=/usr/bin/python2

RUN mkdir -p /workspace /data /opt/frugal/bundle /opt/frugal/bundle-config /opt/frugal/data-template \
 && touch /data/.frugal-data-volume \
 && chown node:node /workspace /data /data/.frugal-data-volume /opt/frugal/bundle /opt/frugal/bundle-config /opt/frugal/data-template

COPY scripts/make-checkpoint.sh scripts/verify-checkpoint.sh scripts/build-db-template.sh /opt/frugal/build/
COPY task-bin/services task-bin/app /opt/frugal/task/
COPY task/patches/ /opt/frugal/build/patches/
RUN chmod 755 /opt/frugal/build/*.sh /opt/frugal/task/services /opt/frugal/task/app

USER node
WORKDIR /workspace

# ---- checkpoint: upstream tree at MASTODON_COMMIT + env patches, one fresh commit -----------------
RUN /opt/frugal/build/make-checkpoint.sh /workspace "$MASTODON_COMMIT" /opt/frugal/build/patches

# ---- gems ----------------------------------------------------------------------------------------
# System libxml2/libxslt for nokogiri (faster than its vendored build, works on arm64).
RUN NOKOGIRI_USE_SYSTEM_LIBRARIES=1 BUNDLE_BUILD__NOKOGIRI=--use-system-libraries \
    bundle install --jobs "$(nproc)" --retry 3 \
 && rm -f /opt/frugal/bundle/ruby/*/cache/*.gem && (rm -rf /tmp/* 2>/dev/null || true) \
 && bundle exec ruby -e 'require "nokogiri"; require "cld3"; require "charlock_holmes"; require "idn"; require "pg"; require "hiredis"; require "oj"; puts "native gems OK (nokogiri #{Nokogiri::VERSION})"'

# ---- node_modules --------------------------------------------------------------------------------
# --pure-lockfile: never rewrite yarn.lock. node-sass (filters checkpoint) has no prebuilt arm64
# binary and is compiled from source with python2 + g++ (a few minutes).
RUN yarn install --pure-lockfile --non-interactive --network-timeout 600000 \
 && (rm -rf /tmp/.yarn-cache /tmp/.npm /tmp/* 2>/dev/null || true) \
 && node -e 'try { require("node-sass"); console.log("node-sass OK"); } catch (e) { if (e.code !== "MODULE_NOT_FOUND") throw e; }'

# ---- databases -------------------------------------------------------------------------------------
# (tmp/cache/bootsnap* from these boots stays: git-ignored, and it speeds up the first boot.)
RUN /opt/frugal/build/build-db-template.sh \
 && (rm -rf /tmp/* 2>/dev/null || true)

# ---- final checks: single-commit history, clean tree ----------------------------------------------
RUN /opt/frugal/build/verify-checkpoint.sh /workspace

CMD ["sleep", "infinity"]
