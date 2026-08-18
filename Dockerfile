# syntax=docker/dockerfile:1

ARG OPENCLAW_BUILD_MODE=image

# TEMPORARY OPENCLAW COMPATIBILITY 1/2 — Owner bootstrap support.
# The current `latest` image does not make
# `openclaw dashboard --json` return the `browserUrl` required for automatic
# Owner pairing. Once a stable image includes that contract, change this default
# to `latest`; compatibility block 2/2 must be evaluated separately.
ARG OPENCLAW_IMAGE_TAG=2026.8.1-beta.2
FROM ghcr.io/openclaw/openclaw:${OPENCLAW_IMAGE_TAG} AS openclaw-image

# TEMPORARY OPENCLAW COMPATIBILITY 2/2 — missing Telegram dependency.
# 2026.8.1-beta.2's production prune leaves whatwg-url@5 without its declared
# tr46 dependency, so the bundled Telegram plugin cannot register. Extract the
# exact compatible package without running install against OpenClaw's workspace.
# Delete this USER/RUN block after the selected official image can register the
# Telegram plugin without `Cannot find module 'tr46'`.
USER root

RUN cd /tmp \
 && npm pack --ignore-scripts tr46@0.0.3 >/dev/null \
 && mkdir -p /app/node_modules/tr46 \
 && tar -xzf tr46-0.0.3.tgz --strip-components=1 -C /app/node_modules/tr46 \
 && chown -R node:node /app/node_modules/tr46 \
 && rm tr46-0.0.3.tgz

FROM node:26-bookworm AS openclaw-source

ARG OPENCLAW_GIT_REF=main

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl git hostname lsof openssl procps python3 tini \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && install -d -o node -g node /app

WORKDIR /app
USER node

# Fetch only the selected commit or ref. A full commit SHA is recommended so
# rebuilding the same Railway deployment always uses identical OpenClaw source.
RUN git init \
 && git remote add origin https://github.com/openclaw/openclaw.git \
 && git fetch --depth 1 origin "$OPENCLAW_GIT_REF" \
 && git checkout --detach FETCH_HEAD

RUN NODE_OPTIONS=--max-old-space-size=2048 pnpm install --frozen-lockfile \
 && NODE_OPTIONS=--max-old-space-size=8192 pnpm build \
 && NODE_OPTIONS=--max-old-space-size=8192 pnpm ui:build

ARG OPENCLAW_BUILD_MODE
FROM openclaw-${OPENCLAW_BUILD_MODE} AS openclaw

USER root

COPY --chmod=755 railway-entrypoint.mjs /usr/local/bin/openclaw-railway
# Railway Console sessions inherit this image's root user, which is required to
# initialize a newly mounted Volume. Route the public CLI through the entrypoint
# so it drops to UID/GID 1000 before OpenClaw rewrites 0600 files under /data.
RUN ln -sf /usr/local/bin/openclaw-railway /usr/local/bin/openclaw

ENV HOME=/home/node \
    NODE_ENV=production \
    OPENCLAW_GATEWAY_PORT=8080 \
    OPENCLAW_STATE_DIR=/data/.openclaw \
    OPENCLAW_WORKSPACE_DIR=/data/workspace \
    OPENCLAW_CONFIG_PATH=/data/.openclaw/openclaw.json \
    OPENCLAW_DISABLE_BONJOUR=1 \
    NODE_OPTIONS=--max-old-space-size=1536

EXPOSE 8080

HEALTHCHECK --interval=3m --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.OPENCLAW_GATEWAY_PORT||'8080')+'/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["tini", "-s", "--", "/usr/local/bin/openclaw-railway"]
CMD ["start"]
