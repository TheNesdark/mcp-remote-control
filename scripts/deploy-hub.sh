#!/usr/bin/env bash
# deploy-hub.sh — despliega el hub (Docker ahora compila el agente .NET 8
# win-x64 y lo sirve por HTTP en /agent/latest.exe) y publica las builds
# para Windows 7 en la share.
#
# Los dos lados de la actualización tienen que hablar la misma versión:
#
#   1) el hub se redespliega desde el repo y anuncia la versión de
#      shared/version.ts; el contenedor compila el agente .NET 8 win-x64
#      durante el build y lo sirve en /agent/latest.exe;
#   2) las builds para Windows 7 (net6, x64/x86) se publican a mano en la
#      share, porque el Dockerfile no las compila (solo Win10/11 auto-actualiza
#      desde el hub; Win7 se instala con INSTALAR-AGENTE-WIN7.bat).
#
# Uso:
#   DOKPLOY_URL=http://192.168.1.192:3000 DOKPLOY_API_KEY=... scripts/deploy-hub.sh
#
# Variables de entorno:
#   SHARE          share donde viven las builds Win7  (por defecto //192.168.1.191/Hermes)
#   APP_ID         id de la app de Dokploy          (por defecto vrF20-AfsekB2AZOba-yw)
#   SKIP_AGENT     poner a 1 para no publicar las builds Win7
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
# El agente .NET 8 (win-x64) lo compila ahora el Dockerfile y el hub lo sirve
# por HTTP en /agent/latest.exe. Aqui solo se publican las builds para Windows 7
# (net6, x64/x86), que no se auto-actualizan y se instalan a mano.
if [ "${SKIP_AGENT:-0}" != "1" ]; then
  echo "==> publicando las builds para Windows 7 en la share"
  command -v dotnet >/dev/null || { echo "Falta dotnet SDK." >&2; exit 1; }
  command -v smbclient >/dev/null || { echo "Falta smbclient." >&2; exit 1; }
  for spec in "win-x64 rc-agent-win7-x64.exe" "win-x86 rc-agent-win7-x86.exe"; do
    set -- $spec
    rid="$1"; dst="$2"
    OUT="$(mktemp -d)"
    dotnet publish "$ROOT/agent-dotnet" -c Release -r "$rid" --self-contained true \
      -p:EnableWindowsTargeting=true -p:Win7=true -p:IncludeNativeLibrariesForSelfExtract=true \
      -o "$OUT" -v q --nologo
    smbclient "$SHARE" -N -c "del $dst" >/dev/null 2>&1 || true
    sleep 1
    smbclient "$SHARE" -N -c "put $OUT/rc-agent.exe $dst" >/dev/null
    rm -rf "$OUT"
    echo "    share actualizada: $dst ($VERSION)"
  done
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
