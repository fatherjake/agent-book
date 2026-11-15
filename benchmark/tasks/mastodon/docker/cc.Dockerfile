# Claude Code layer for a brownfield Mastodon task: `frugal-task-<taskId>-cc:<hash>` = the task image
# (unchanged) + Claude Code at CLAUDE_CODE_VERSION (runner/claude-code.ts). Built by
# benchmark/tasks/mastodon/image.ts.
#
# Claude Code needs Node >= 22 to install, but `node`/`yarn` on PATH must stay the checkpoint's
# Node 8/12. So it is installed under /opt/claude with the private runtime /opt/frugal/node (never on
# PATH), and /usr/local/bin/claude points at its native binary (the npm package ships one per
# platform and links it as bin/claude.exe). If a future version ships a JS entry point instead, the
# wrapper runs it with the private node explicitly, still without touching PATH.
# No API key, token or login is baked in.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG CLAUDE_CODE_VERSION

USER root
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN mkdir -p /opt/claude \
 && cd /opt/claude \
 && echo '{"name":"frugal-claude","private":true}' > package.json \
 && PATH=/opt/frugal/node/bin:$PATH npm_config_cache=/tmp/.npm-cc \
      npm install --no-audit --no-fund --loglevel=error "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && bin=$(readlink -f /opt/claude/node_modules/@anthropic-ai/claude-code/bin/claude.exe) \
 && if head -c 4 "$bin" | grep -q ELF; then \
      ln -sf "$bin" /usr/local/bin/claude; \
    else \
      printf '#!/bin/sh\nexec /opt/frugal/node/bin/node %s "$@"\n' "$bin" > /usr/local/bin/claude && chmod 755 /usr/local/bin/claude; \
    fi \
 && chmod -R a+rX /opt/claude \
 && rm -rf /tmp/.npm-cc /root/.npm /root/.cache \
 && mkdir -p /home/node/.claude && chown -R node:node /home/node \
 && HOME=/tmp claude --version \
 && node -e 'const m = +process.versions.node.split(".")[0]; if (m >= 18) { console.error("project node on PATH is " + process.version); process.exit(1); } console.log("project node", process.version)'

ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

USER node
WORKDIR /workspace
CMD ["sleep", "infinity"]
