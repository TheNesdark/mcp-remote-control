#!/usr/bin/env bash
# hermes-tunnel.sh - persistent free Cloudflare tunnel for mcp-remote-control
#
# Quick tunnels (cloudflared tunnel --url) mint a RANDOM trycloudflare.com
# hostname on every start, which breaks every agent config when the server
# restarts. A NAMED tunnel keeps a stable hostname on a domain you manage in
# Cloudflare's free tier. One-time setup:
#
#   cloudflared tunnel login                        # opens the CF dashboard
#   cloudflared tunnel create mrc                   # writes ~/.cloudflared/mrc.json
#   ./scripts/hermes-tunnel.sh dns  mrc.example.com       # route the WS host
#   ./scripts/hermes-tunnel.sh dns  mrc-mcp.example.com   # route the MCP host (optional)
#
# Agents then connect to wss://mrc.example.com/agent forever, even after
# reboots; the connector itself starts with the systemd unit at the bottom.
#
# Usage:
#   hermes-tunnel.sh run              # run the connector (both hostnames)
#   hermes-tunnel.sh dns <hostname>   # CNAME a hostname to the tunnel
#   hermes-tunnel.sh config           # print the generated ingress config
#
# Environment (defaults shown):
#   MRC_TUNNEL_NAME=mrc               # tunnel name in Cloudflare
#   MRC_WS_HOSTNAME=                  # hostname for the agent WS hub
#   MRC_MCP_HOSTNAME=                 # hostname for MCP over HTTP (optional)
#   MRC_WS_URL=http://127.0.0.1:8787  # local origin of the hub
#   MRC_MCP_URL=http://127.0.0.1:8788 # local origin of MCP HTTP

set -euo pipefail

NAME="${MRC_TUNNEL_NAME:-mrc}"
WS_URL="${MRC_WS_URL:-http://127.0.0.1:8787}"
MCP_URL="${MRC_MCP_URL:-http://127.0.0.1:8788}"

write_config() {
    local file
    file="$(mktemp -t cloudflared-mrc.XXXXXX.yml)"
    {
        echo "tunnel: ${NAME}"
        echo "credentials-file: ${HOME}/.cloudflared/${NAME}.json"
        echo ""
        echo "ingress:"
        if [[ -n "${MRC_WS_HOSTNAME:-}" ]]; then
            echo "  - hostname: ${MRC_WS_HOSTNAME}"
            echo "    service: ${WS_URL}"
        fi
        if [[ -n "${MRC_MCP_HOSTNAME:-}" ]]; then
            echo "  - hostname: ${MRC_MCP_HOSTNAME}"
            echo "    service: ${MCP_URL}"
        fi
        echo "  - service: http_status:404"
    } >"$file"
    echo "$file"
}

usage() { sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

cmd="${1:-}"
case "$cmd" in
    run)
        if [[ -z "${MRC_WS_HOSTNAME:-}" && -z "${MRC_MCP_HOSTNAME:-}" ]]; then
            echo "set MRC_WS_HOSTNAME and/or MRC_MCP_HOSTNAME" >&2
            exit 1
        fi
        config="$(write_config)"
        echo "connector for tunnel '${NAME}' using ${config}" >&2
        exec cloudflared tunnel --config "$config" run
        ;;
    dns)
        host="${2:?usage: hermes-tunnel.sh dns <hostname>}"
        cloudflared tunnel route dns "$NAME" "$host"
        echo "routed ${host} -> tunnel '${NAME}'"
        ;;
    config)
        [[ -n "${MRC_WS_HOSTNAME:-}${MRC_MCP_HOSTNAME:-}" ]] || { echo "set MRC_WS_HOSTNAME and/or MRC_MCP_HOSTNAME" >&2; exit 1; }
        cat "$(write_config)"
        ;;
    *)
        usage
        ;;
esac

# systemd unit (place in /etc/systemd/system/mrc-tunnel.service):
#   [Unit]
#   Description=mcp-remote-control Cloudflare connector
#   After=network-online.target
#   [Service]
#   Environment=MRC_WS_HOSTNAME=mrc.example.com
#   Environment=MRC_MCP_HOSTNAME=mrc-mcp.example.com
#   ExecStart=/opt/mcp-remote-control/scripts/hermes-tunnel.sh run
#   Restart=always
#   RestartSec=5
#   User=mrc
#   [Install]
#   WantedBy=multi-user.target
