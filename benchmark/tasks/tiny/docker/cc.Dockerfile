# Claude Code layer for the tiny tasks: `frugal-task-tiny-cc:<hash>` = the task image (unchanged) +
# Claude Code at CLAUDE_CODE_VERSION (runner/claude-code.ts). Built by benchmark/tasks/tiny/image.ts.
# The project's Node 22 is new enough, so Claude Code shares it (installed under /opt/claude, linked
# into /usr/local/bin). No API key, token or login is baked in.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG CLAUDE_CODE_VERSION

USER root
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN mkdir -p /opt/claude \
 && cd /opt/claude \
 && echo '{"name":"frugal-claude","private":true}' > package.json \
 && npm_config_offline=false npm_config_cache=/tmp/.npm-cc \
      npm install --no-audit --no-fund --loglevel=error "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && bin=$(readlink -f /opt/claude/node_modules/@anthropic-ai/claude-code/bin/claude.exe 2>/dev/null || readlink -f /opt/claude/node_modules/.bin/claude) \
 && if head -c 4 "$bin" | grep -q ELF; then \
      ln -sf "$bin" /usr/local/bin/claude; \
    else \
      printf '#!/bin/sh\nexec /usr/local/bin/node %s "$@"\n' "$bin" > /usr/local/bin/claude && chmod 755 /usr/local/bin/claude; \
    fi \
 && chmod -R a+rX /opt/claude \
 && rm -rf /tmp/.npm-cc /root/.npm /root/.cache \
 && mkdir -p /home/node/.claude && chown -R node:node /home/node \
 && HOME=/tmp claude --version

ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

USER node
WORKDIR /workspace
CMD ["sleep", "infinity"]
