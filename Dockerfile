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
# El agente Windows (.NET 8, agent-dotnet/) SE compila aqui en una etapa
# separada (cross-compile para win-x64 con EnableWindowsTargeting) y se
# deja en /app/agent/rc-agent.exe. El hub lo sirve por HTTP en
# /agent/latest.exe (MRC_AGENT_BINARY_PATH) y los agentes lo descargan
# automaticamente al conectarse (OTA). Las builds para Windows 7 (net6,
# x64/x86) no se generan aqui: siguen publicandose en la share SMB y se
# instalan a mano en esos equipos (ver docs/OPERATIONS.md).

# ---------------------------------------------------------------------------
# 0) agente Windows (.NET 8, self-contained para win-x64)
# ---------------------------------------------------------------------------
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS agent-builder
WORKDIR /src
COPY agent-dotnet ./agent-dotnet
RUN dotnet publish agent-dotnet -c Release -r win-x64 --self-contained true \
      -p:EnableWindowsTargeting=true \
      -p:IncludeNativeLibrariesForSelfExtract=true \
      -o /out -v q --nologo

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
    MRC_LOG_LEVEL=info \
    MRC_AGENT_BINARY_PATH=/app/agent/rc-agent.exe

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY shared ./shared
COPY server ./server
# Binario del agente (build cross-compilado en la etapa agent-builder).
COPY --from=agent-builder /out/rc-agent.exe /app/agent/rc-agent.exe

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