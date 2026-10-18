# mcp-remote-control — servidor central (hub de agentes + MCP sobre HTTP).
#
# Build:
#   docker build -t mrc-server .
# Run:
#   docker run -d --name mrc \
#     -p 8787:8787 -p 8788:8788 \
#     -v mrc-data:/app/server/data \
#     --env-file .env \
#     mrc-server
#
# Dos puertos: 8787 = WebSocket de los agentes (rc-agent.exe), 8788 = MCP HTTP
# para opencode. Los datos (SQLite de tokens, auditoría, screenshots) viven en
# /app/server/data -> monta un volumen o se pierden al recrear el contenedor.

# ---------------------------------------------------------------------------
# 1) dependencias (capa cacheable: solo se invalida si cambian los manifests)
# ---------------------------------------------------------------------------
FROM oven/bun:1.4.3 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY agent/package.json ./agent/
RUN bun install --frozen-lockfile --production

# ---------------------------------------------------------------------------
# 1b) agente Windows: cross-compile a .exe en la misma build (version unica)
# ---------------------------------------------------------------------------
FROM oven/bun:1.4.3 AS agent-build
WORKDIR /app
COPY package.json bun.lock ./
COPY shared/package.json ./shared/
COPY agent/package.json ./agent/
RUN bun install --frozen-lockfile --production
COPY shared ./shared
COPY agent/src ./agent/src
COPY agent/tray ./agent/tray
COPY agent/cua ./agent/cua
COPY agent/assets ./agent/assets
COPY agent/build.ts ./agent/build.ts
RUN bun run build:exe --out /app/agent/rc-agent.exe

# ---------------------------------------------------------------------------
# 2) runtime: solo lo necesario para servir (sin sources del agente ni tests)
# ---------------------------------------------------------------------------
FROM oven/bun:1.4.3 AS runtime
WORKDIR /app

# tini recoge zombies y propaga SIGTERM (el hub cierra sockets al salir).
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    MRC_HOST=0.0.0.0 \
    MRC_PORT=8787 \
    MRC_MCP_HTTP_PORT=8788 \
    MRC_DATA_DIR=/app/server/data \
    MRC_LOG_LEVEL=info \
    MRC_AGENT_BINARY_PATH=/app/agent/rc-agent.exe

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY shared ./shared
COPY server ./server

# Binario del agente (compilado en agent-build) para auto-update OTA.
COPY --from=agent-build /app/agent/rc-agent.exe /app/agent/rc-agent.exe

# Usuario sin privilegios; el directorio de datos es el único escribible.
RUN useradd --system --uid 10001 --home /app mrc \
 && mkdir -p /app/server/data/screenshots /app/agent \
 && chown -R mrc:mrc /app/server/data /app/agent
USER mrc

VOLUME ["/app/server/data"]
EXPOSE 8787 8788

# El hub expone GET / con {ok:true}; es la comprobación más barata y honesta.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "const p=process.env.MRC_PORT||8787; const r=await fetch('http://127.0.0.1:'+p+'/'); if(!r.ok) process.exit(1); const j=await r.json(); if(!j.ok) process.exit(1);" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "run", "server/src/index.ts", "--no-mcp-stdio"]
