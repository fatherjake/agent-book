# Coding image for the claude-code backend: the frozen benchmark image plus the Claude Code CLI.
# Built by runner/claude-code-image.ts (tag frugal-bench-cc:<hash of base tag + this file + version>).
# Claude Code is installed globally under /usr/local (outside /workspace, so never in the app snapshot).
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG CLAUDE_CODE_VERSION

USER root
# The npm package ships the native binary through a per-platform optional dependency; the
# postinstall step links it as bin/claude.exe. No API key or login is baked in.
RUN npm install -g --no-audit --no-fund --loglevel=error "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && claude --version \
 && rm -rf /tmp/.npm /root/.npm /root/.cache \
 && mkdir -p /home/node/.claude \
 && chown -R node:node /home/node

ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

USER node
WORKDIR /workspace
CMD ["sleep", "infinity"]
