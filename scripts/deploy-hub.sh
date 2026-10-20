#!/usr/bin/env bash
# deploy-hub.sh — publica el agente en la share y despliega el hub.
#
# Los dos lados de la actualización tienen que hablar la misma versión:
#
#   1) el agente (rc-agent.exe) se publica en la share como
#      rc-agent-update.exe, que es el archivo que el hub anuncia
#      (MRC_AGENT_BINARY_UNC) y del que se copia el instalador;
#   2) el hub se redespliega desde el repo, y anuncia la versión de
#      shared/version.ts.
#
# El agente solo se actualiza si la versión del binario de la share es
# EXACTAMENTE la que anuncia el hub, así que el orden importa: primero el
# binario, después el hub.
#
# Uso:
#   DOKPLOY_URL=http://192.168.1.192:3000 DOKPLOY_API_KEY=... scripts/deploy-hub.sh
#
# Variables de entorno:
#   SHARE          share donde vive el agente  (por defecto //192.168.1.191/Hermes)
#   APP_ID         id de la app de Dokploy    (por defecto vrF20-AfsekB2AZOba-yw)
#   SKIP_AGENT     poner a 1 para no publicar el agente
#   SKIP_HUB       poner a 1 para no desplegar el hub

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHARE="${SHARE:-//192.168.1.191/Hermes}"
APP_ID="${APP_ID:-vrF20-AfsekB2AZOba-yw}"
DOKPLOY_URL="${DOKPLOY_URL:-http://192.168.1.192:3000}"
DOKPLOY_API_KEY="${DOKPLOY_API_KEY:-}"

if [ -z "$DOKPLOY_API_KEY" ]; then
  echo "Falta DOKPLOY_API_KEY (cabecera x-api-key)." >&2
  exit 1
fi

VERSION="$(grep -oE 'VERSION\s*=\s*"[0-9]+\.[0-9]+\.[0-9]+"' "$ROOT/shared/version.ts" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"
echo "==> version del repo: $VERSION"

# ---------------------------------------------------------------- agente ----
if [ "${SKIP_AGENT:-0}" != "1" ]; then
  echo "==> publicando el agente en la share"
  command -v dotnet >/dev/null || { echo "Falta dotnet SDK." >&2; exit 1; }
  OUT="$(mktemp -d)"
  dotnet publish "$ROOT/agent-dotnet" -c Release -r win-x64 --self-contained true \
    -p:EnableWindowsTargeting=true -o "$OUT" -v q --nologo
  command -v smbclient >/dev/null || { echo "Falta smbclient." >&2; exit 1; }
  # La share no admite sobrescribir un archivo abierto: se borra antes.
  smbclient "$SHARE" -N -c "del rc-agent-update.exe" >/dev/null 2>&1 || true
  smbclient "$SHARE" -N -c "put $OUT/rc-agent.exe rc-agent-update.exe" >/dev/null
  rm -rf "$OUT"
  echo "    share actualizada: rc-agent-update.exe ($VERSION)"
fi

# ------------------------------------------------------------------- hub ----
if [ "${SKIP_HUB:-0}" != "1" ]; then
  echo "==> desplegando el hub (application-deploy)"
  # application-deploy vuelve a clonar el repo; application-redeploy reutiliza
  # el checkout anterior y puede desplegar una version vieja.
  curl -sS -X POST "$DOKPLOY_URL/api/application.deploy" \
    -H "x-api-key: $DOKPLOY_API_KEY" -H 'content-type: application/json' \
    -d "{\"applicationId\":\"$APP_ID\",\"title\":\"hub $VERSION\"}" >/dev/null
  echo "    despliegue lanzado; espera a que el contenedor arranque"
fi

echo
echo "Listo. Comprueba la version que anuncia el hub:"
echo "  curl -sS -H 'x-api-key: \$DOKPLOY_API_KEY' \\"
echo "    '$DOKPLOY_URL/api/application.one?applicationId=$APP_ID' | grep -o '\"applicationStatus\":\"[^\"]*\"'"
