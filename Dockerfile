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
#
# El agente Windows (.NET 8, agent-dotnet/) NO se compila aquí: su publish es
# self-contained para win-x64 y se hace en Windows (o con EnableWindowsTargeting)
# antes de copiar rc-agent.exe al share. Para OTA, monta el exe y apunta
# MRC_AGENT_BINARY_PATH a él (ver docs/OPERATIONS.md).

# ---------------------------------------------------------------------------
# 1) dependencias (capa cacheable: solo se invalida si cambian los manifests)
# ---------------------------------------------------------------------------
FROM oven/bun:1.4.3 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
RUN bun install --frozen-lockfile --production

# ---------------------------------------------------------------------------
# 2) runtime: solo lo necesario para servir (sin tests)
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
    MRC_LOG_LEVEL=info

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY shared ./shared
COPY server ./server

# Usuario sin privilegios; el directorio de datos es el único escribible.
# /app/agent queda para el binario OTA si se monta o copia (opcional).
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
