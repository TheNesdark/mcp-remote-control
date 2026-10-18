# Plan — `mcp-remote-control`

Servidor MCP central que permite a un agente LLM (opencode) controlar varias máquinas
Windows, cada una ejecutando un agente `.exe` que se conecta al servidor y recibe órdenes.

> **Decisiones ya tomadas** (sesión de planificación):
>
> | Tema | Decisión |
> |---|---|
> | Stack | **Bun + TypeScript** en ambos lados (central y agente) |
> | Transporte | **WebSocket persistente** iniciado por el agente (outbound) |
> | Capacidades v1 | Ejecutar comandos, archivos (subir/bajar), inventario + procesos, screenshot (**solo monitor primario**) |
> | UI del agente | **App de bandeja (system tray)**: icono junto al reloj (como volumen/batería) con activar/desactivar; el primer arranque pide el nombre de la máquina |
> | Red | **Solo LAN local de confianza** (sin Tailscale/VPN desde F5), sin exposición pública a internet |
> | Idioma | **Logs y errores en inglés** (agente y servidor) |
> | Fuera de v1 | Reboot/shutdown, registro de Windows, UI automation (clicks), escritorio remoto, servicios Windows, screenshot multi-monitor |
>
> **Spike ya validado**: `bun build --compile --target=bun-windows-x64` desde este Linux
> produce un PE válido (`MZ`, ~92 MB) → no necesitamos Windows para compilar el agente.

---

## 1. Arquitectura

```
┌──────────────┐   stdio (MCP)    ┌───────────────────────────────────────────┐
│  Agente LLM  │◄────────────────►│         Servidor central (Bun)            │
│  (opencode)  │                  │  ┌─────────────────────────────────────┐  │
└──────────────┘                  │  │ Capa MCP: tools `agents_list`,      │  │
                                  │  │ `agent_exec`, `agent_fs_*`, ...     │  │
                                  │  ├─────────────────────────────────────┤  │
                                  │  │ Hub: routing agentId → socket,      │  │
                                  │  │ jobs, timeouts, heartbeats          │  │
                                  │  ├─────────────────────────────────────┤  │
                                  │  │ Registry: tokens, metadatos (SQLite)│  │
                                  │  ├─────────────────────────────────────┤  │
                                  │  │ WS server  :8787  (LAN local)       │  │
                                  │  └─────────────────────────────────────┘  │
                                  └───────────────▲───────────────────────────┘
                                                  │  ws:// en LAN local de confianza
                        ┌─────────────────────────┼─────────────────────────┐
                     ┌──┴───┐                 ┌──┴───┐                 ┌──┴───┐
                     │PC-01 │                 │PC-02 │                 │PC-03 │
                     │ .exe │                 │ .exe │                 │ .exe │
                     └──────┘                 └──────┘                 └──────┘
```

**Por qué conexión saliente (agente → servidor):** las Windows no abren ningún puerto,
funciona detrás de NAT/firewall corporativo, y el servidor mantiene un mapa
`agentId → socket` para enrutar cada orden. El servidor central es un único proceso Bun
que sirve a la vez el WebSocket hub y el protocolo MCP por stdio.

---

## 2. Componentes

### 2.1 Servidor central (`server/`)

- **Un solo proceso**: `bun run server/src/index.ts`
  - Abre el WS server (puerto configurable, por defecto `8787`).
  - Expone MCP por **stdio** (modo normal para opencode) y opcionalmente `--http` para pruebas.
- Módulos:
  - `hub.ts` — handshake `hello`/`welcome`, heartbeats, envío de jobs, correlación de
    respuestas, timeouts con cancelación, colas y límites por agente.
  - `registry.ts` + `store.ts` — tokens de enrolamiento (hash SHA-256 en **SQLite** vía
    `bun:sqlite`), metadatos por agente (nombre, tags, OS, primera conexión, `agentId` fijado
    al primer uso del token).
  - `tools/` — una tool MCP por archivo (`agents_list.ts`, `agent_exec.ts`, …).
  - `audit.ts` — log JSONL append-only: quién, agente, operación, parámetros, resultado,
    duración, bytes transferidos. Rotación por tamaño.
  - `cli.ts` — administración: `agent add --name PC-01 --tags oficina`, `agent list`,
    `agent revoke <id>`, `server status`.

### 2.2 Agente Windows (`agent/` → `rc-agent.exe`) — app de bandeja

Es una **aplicación de bandeja del sistema**, no un binario headless: vive junto al reloj
(como los iconos de volumen/batería), muestra el estado y permite **activar/desactivar**
el agente con clic derecho.

**Build (cross-compile desde Linux):**
`bun build --compile --target=bun-windows-x64` con:
- `--windows-hide-console` → sin ventana de consola.
- `--windows-icon=assets/icon.ico`, `--windows-title`, `--windows-publisher`, `--windows-version`.

**Primer arranque (setup guiado):**
- Si no existe `%APPDATA%\mcp-remote-control\agent.json`, al abrir el `.exe` se muestra un
  diálogo (WinForms vía helper de bandeja) que pide el **nombre de la máquina**
  (prefijado con `%COMPUTERNAME%`, validado `^[A-Za-z0-9._-]{1,32}$`).
- El instalador o los flags CLI (`--server`, `--token`, `--tags`) rellenan servidor/token;
  si faltan, el mismo diálogo los pide.
- El token se guarda **cifrado con DPAPI** (ámbito usuario) dentro de `agent.json`.

**Icono de bandeja** (estados y menú):
- 🟢 Connected · 🟡 Paused (desactivado localmente) · ⚪ Connecting · 🔴 Disconnected.
- Tooltip: `PC-01 — Connected · host:8787`.
- Menú contextual:
  - `PC-01 — Connected` (estado, no clicable)
  - `Enable agent` / `Disable agent` → pausa **sin desconectarse**: el agente lo anuncia al
    servidor (`presence {paused:true}`) y las tools responden `agent paused locally`.
  - `Reconnect now`
  - `Open logs`
  - `Start with Windows` (checkbox → clave `HKCU\…\CurrentVersion\Run`)
  - `Exit`
- Instancia única: si ya hay un agente corriendo, el segundo avisa y sale.

**Helper de bandeja:** Bun no tiene API Win32 nativa, así que el icono lo dibuja un helper
**PowerShell + WinForms (`NotifyIcon`)** embebido en el `.exe` (los Windows 10/11 traen
PowerShell 5.1). Comunicación Bun ↔ helper por JSON-lines sobre stdin/stdout:
el helper manda acciones (`toggle`, `reconnect`, `exit`), el agente manda estado
(`connecting|connected|paused|disconnected`, nombre, errores). Plan B si el EDR recela de
PowerShell: `tray.exe` en C# compilado con `csc.exe` (presente en Windows).

**Ciclo de vida de red:**
1. `hello` con token + capacidades → `welcome` con `agentId`.
2. `heartbeat` cada 10 s (con métricas ligeras: CPU/RAM opcional).
3. Atiende `job.request`; emite `job.output` en streaming y cierra con `job.result`.
4. Reconexión con backoff exponencial + jitter (1 s → 60 s), persistente entre cortes.
5. **Logs en inglés** en `%APPDATA%\mcp-remote-control\logs\` (rotación por tamaño;
   nivel configurable, por defecto `info`).

**Módulos de ejecución:**
- `exec.ts` — `cmd.exe /c` o `powershell -NoProfile -NonInteractive -Command`,
  `cwd`/`env`, timeout, kill del árbol de procesos (`taskkill /T /F`), stdout/stderr
  por chunks con número de secuencia.
- `fs.ts` — listar, leer (utf8/base64), escribir, y transferencias chunked con
  verificación **SHA-256** extremo a extremo.
- `ps.ts` — procesos: en Windows vía PowerShell (`Get-Process` a JSON, dos muestras
  separadas 500 ms para el % de CPU, `-IncludeUserName` cuando hay privilegios) y kill
  con `taskkill /PID <pid> /T /F`; en Linux/dev lee `/proc` directamente (sin procps) y
  en el resto de POSIX usa `ps`; el kill en árbol recorre el mapa de ppid.
- `screenshot.ts` — captura del **monitor primario** con `System.Windows.Forms` +
  `System.Drawing` vía PowerShell; PNG/JPEG; si no hay sesión interactiva (sesión 0,
  escritorio bloqueado) devuelve un error claro. La imagen **no se guarda en el equipo
  remoto**: el agente la envía dentro del propio job (base64 en `job.output`) y el
  servidor la verifica (tamaño + SHA-256) y guarda su copia local.

> ⚠️ **Sesión 0 vs sesión interactiva**: si el `.exe` corre como *servicio Windows* no hay
> escritorio → **screenshot no funciona**. Instalación recomendada v1: **Tarea Programada /
> autostart de usuario** ("run only when user is logged on" si se necesita screenshot; en
> caso contrario "whether logged on or not" es válido para el resto de capacidades).
> `docs/INSTALL-WINDOWS.md` documentará ambos modos.

### 2.3 Protocolo compartido (`shared/protocol.ts`)

Tipos TypeScript importados por ambos lados; un mensaje = un frame JSON.

**Agente → Servidor**

| Mensaje | Campos |
|---|---|
| `hello` | `proto`, `token`, `agentId?`, `name`, `host`, `os`, `version`, `tags`, `caps` |
| `heartbeat` | `ts`, `metrics?` |
| `presence` | `paused` (el usuario local activó/desactivó el agente desde la bandeja) |
| `job.output` | `jobId`, `stream`, `seq`, `data`, `encoding` (`utf8` por defecto, `base64` para binario) |
| `job.result` | `jobId`, `ok`, `exitCode?`, `durationMs`, `error?`, `meta?` (bytes, eof, sha256, tamaño…) |
| `event` | `type`, `payload` |

**Servidor → Agente**

| Mensaje | Campos |
|---|---|
| `welcome` | `agentId`, `serverTime`, `heartbeatIntervalMs` |
| `job.request` | `jobId`, `type` (`exec`/`fs.list`/…), `params`, `timeoutMs` |
| `job.cancel` | `jobId` |
| `ping` | — |

Reglas: límite de frame 1 MB, binarios siempre chunked, `jobId` UUID, el servidor impone
timeout y envía `job.cancel` (el agente mata el proceso). El servidor **rechaza jobs a
agentes pausados** (`agent paused locally`). Versión de protocolo `proto: 1`; el servidor
rechaza versiones incompatibles con mensaje explícito.

---

## 3. Superficie MCP (tools v1)

| Tool | Parámetros clave | Devuelve |
|---|---|---|
| `agents_list` | — | id, nombre, host, OS, online/**paused**, lastSeen, tags, caps |
| `agent_info` | `agent` | hostname, OS, usuario, uptime, CPU (modelo/núcleos/load), RAM total/libre, IPs, discos con espacio libre, versión/caps del agente |
| `agent_exec` | `agent`, `command`, `shell` (`cmd`\|`powershell`), `cwd?`, `env?`, `timeoutMs?`, `stdin?` | jobId, exitCode, stdout, stderr, truncado |
| `agent_fs_list` | `agent`, `path` | entradas con tipo, tamaño, fecha |
| `agent_fs_read` | `agent`, `path`, `encoding?`, `maxBytes?` | contenido utf8/base64 |
| `agent_fs_write` | `agent`, `path`, `content`, `encoding?` | ok, bytes, sha256 |
| `agent_fs_upload` | `agent`, `localPath` (host central), `remotePath` | ok, bytes, sha256 |
| `agent_fs_download` | `agent`, `remotePath`, `localPath` (host central) | ok, bytes, sha256 |
| `agent_ps_list` | `agent`, `filter?` (substring nombre/cmdline), `top?` (def 100, máx 5000), `sort?` (`cpu`\|`mem`\|`pid`\|`name`) | pid, ppid, nombre, cpuPercent, memBytes, usuario, command |
| `agent_ps_kill` | `agent`, `pid`\|`name` (exactamente uno), `force?` (def true), `tree?` (def true) | outcomes por pid, `killedCount`; nunca mata al propio agente ni a pid 1 |
| `agent_screenshot` | `agent`, `format` (`png`\|`jpeg`, def png), `quality?` (def 80, solo jpeg), `embed?` (def true) | imagen MCP (base64) + `localPath` en el host central, bytes, sha256, width/height · **solo monitor primario** |
| `agent_restart` | `agent`, `updatePath?` (binario nuevo ya subido), `args?` | reinicio detached del agente; con `updatePath` reemplaza el exe antes de relanzar (self-update OTA) |
| `agent_exec_async` | `agent`, `command`, `shell?`, `cwd?`, `env?`, `stdin?`, `timeoutMs?` (hasta 24 h) | `jobId`, `state: running` — no espera; el trabajo sigue en el agente |
| `agent_job_status` | `jobId` | estado (`running`\|`ok`\|`failed`), exitCode, duración, stdout/stderr, meta |
| `agent_job_list` | `agent?`, `state?`, `limit?` | jobs vivos (cualquier tipo) + historial retenido de los async |
| `agent_job_cancel` | `jobId` | `cancelRequested`, estado; mata el árbol de procesos remoto |
| `agent_fs_hash` | `agent`, `path` | sha256, size (sin transferir el archivo) |
| `agent_fs_search` | `agent`, `path`, `pattern?`, `recursive?`, `maxDepth?`, `minBytes?`, `maxBytes?`, `newerThanDays?`, `olderThanDays?`, `top?` | archivos con ruta completa, tamaño y mtime (más nuevos primero) |
| `agent_fs_mkdir` | `agent`, `path`, `parents?` | ruta absoluta resuelta, `created` |
| `agent_fs_move` / `agent_fs_copy` | `agent`, `source`, `destination`, `overwrite?` | ruta destino, tipo, `overwritten`; se ejecuta en la máquina remota |
| `agent_fs_delete` | `agent`, `path`, `recursive?`, **`confirm`** (obligatorio) | qué se borró; se rechazan raíces de unidad, sin papelera |
| `agent_services` | `agent`, `filter?`, `state?`, `top?` | servicios Windows (name, displayName, status, startType) |
| `agent_service_control` | `agent`, `name`, `action` (`start`\|`stop`\|`restart`\|`status`), `force?`, `waitSeconds?` | estado resultante del servicio |
| `agent_eventlog` | `agent`, `log?`, `level?`, `source?`, `hours?`, `max?`, `messageChars?` | eventos (time, level, id, provider, message truncado) |
| `agent_net_ports` | `agent`, `protocol?`, `state?`, `filter?`, `top?` | endpoints TCP/UDP con pid y nombre de proceso |
| `agent_net_test` | `agent`, `host`, `port?`, `count?`, `dns?`, `ping?` | direcciones resueltas, pings y resultado del connect TCP desde la máquina remota |
| `agent_power` | `agent`, `action` (`shutdown`\|`restart`\|`logoff`\|`lock`\|`sleep`\|`hibernate`\|`abort`), `delaySeconds?`, `message?`, `force?`, **`confirm`** (salvo lock/abort) | acción programada; la caída del agente tras reiniciar es el éxito |
| `agent_message` | `agent`, `text`, `title?`, `style?`, `buttons?` | muestra un message box en el escritorio remoto (detached, sin respuesta del usuario) |
| `agent_software` | `agent`, `filter?`, `scope` (`machine`\|`user`\|`all`, def machine), `top?` | inventario de programas instalados (registro Uninstall 64/32-bit, deduplicado): name, version, publisher, installDate, installLocation |
| `agent_time` | `agent` | hora local/UTC, zona, desfase contra el reloj del servidor (`offsetFromServerMs`) y estado NTP (servicio W32Time, fuente, última sincronización) |
| `agent_sessions` | `agent`, `interactiveOnly?` (def true) | sesiones de logon vía CIM (locale-proof): usuario, tipo (interactive/remote-interactive/…), `count`, hora de logon; con `interactiveOnly=false` incluye service/batch/network |

Los wrappers de Windows (`agent_services`, `agent_service_control`, `agent_eventlog`,
`agent_net_ports`, `agent_net_test`, `agent_power`, `agent_message`, `agent_fs_search`,
`agent_fs_mkdir`, `agent_fs_move`, `agent_fs_copy`, `agent_fs_delete`, `agent_software`,
`agent_time`, `agent_sessions`) **no requieren
recompilar el agente**: el servidor compone un script PowerShell fijo a partir de los
argumentos validados y el agente devuelve un único sobre JSON (`{ok, data}` /
`{ok, error}`), con salida no-ASCII en UTF-8 sin BOM. Fallan rápido con `needs Windows`
si el agente es POSIX. Las operaciones destructivas (`agent_fs_delete`, `agent_power`)
exigen `confirm=true` y se auditan igual que el resto.

Convenciones para el LLM: nombres estables `agent_*`, ids cortos legibles, errores
accionables (`agent offline`, `agent paused locally`, `token revoked`, `no interactive
session`), outputs grandes truncados a un límite configurable con indicación de cómo
descargarlos completos. **Todo el texto que ve el LLM (nombres de tools, parámetros,
descripciones y errores) va en inglés.**

---

## 4. Seguridad (solo LAN local, sin VPN)

> Decisión F5: despliegue exclusivamente en red local de confianza; sin
> Tailscale/WireGuard. `ws://` + `http://` en claro dentro de la LAN.

1. **Token de enrolamiento por agente**, generado por CLI, guardado hasheado (SHA-256) en
   SQLite, revocable. En el primer `hello` se *fija* el `agentId` al token (si otra máquina
   usa el mismo token, se rechaza y se audita). En el agente, el token se guarda
   **cifrado con DPAPI** (ámbito usuario) en `%APPDATA%\mcp-remote-control\agent.json`.
   El endpoint MCP-HTTP exige `Authorization: Bearer <MRC_TOKEN>` (401 sin él).
2. **Cifrado de transporte**: `ws://`/`http://` en claro, aceptable solo en LAN
   de confianza. Nunca exponer estos puertos a internet. Soporte de `wss://` con
   certificado propio y flag `--ca <pem>` en el agente queda en backlog (F6).
3. **Allowlist/denylist simple de comandos** por agente (patrones) para bloquear lo
   destructivo que quede fuera de v1.
4. **Auditoría** JSONL append-only de toda operación.
5. **Límites**: tamaño de frame, bytes por transferencia, jobs concurrentes por agente,
   rate limit de órdenes.
6. El MCP corre por **stdio local** en v1 — no se expone HTTP del MCP.

---

## 5. Estructura del repositorio

```
mcp-remote-control/
├─ package.json              # workspaces: shared, server, agent
├─ PLAN.md                   # este documento
├─ docs/PROTOCOL.md          # referencia detallada del protocolo
├─ docs/INSTALL-WINDOWS.md   # instalación: primer arranque, bandeja/autostart, firewall, AV
├─ shared/protocol.ts        # tipos y validación de mensajes
├─ server/
│  ├─ src/index.ts           # MCP stdio + WS hub en un proceso
│  ├─ src/hub.ts  registry.ts  store.ts  audit.ts  cli.ts
│  ├─ src/tools/*.ts
│  └─ data/                  # sqlite, audit.jsonl, certs (gitignored)
├─ agent/
│  ├─ src/index.ts  connection.ts  exec.ts  fs.ts  ps.ts  screenshot.ts  tray.ts
│  ├─ tray/tray.ps1          # helper WinForms NotifyIcon (embebido en el .exe)
│  ├─ assets/icon.ico        # icono de la app de bandeja / del .exe
│  └─ build.ts               # cross-compile windows-x64 con --windows-hide-console/--windows-icon
├─ scripts/dev-fake-agent.ts # agente falso (Linux) para desarrollo y CI sin Windows
└─ scripts/e2e.ts            # prueba end-to-end: server + 2 fake agents + cliente MCP
```

---

## 6. Roadmap por fases

| Fase | Contenido | Criterio de aceptación |
|---|---|---|
| **F0** Esqueleto | Repo + workspaces, `shared/protocol.ts`, WS `hello`/`heartbeat`, hub mínimo, `agents_list`, **spike de bandeja en VM Windows** (icono + primer arranque pidiendo nombre) | Un fake agent conecta y aparece en `agents_list` desde opencode; el spike de bandeja muestra el icono y toggla enable/disable |
| **F1** Exec | `agent_exec` con streaming, timeout, cancel, kill tree; probado en Linux y Windows | Comando largo con salida incremental y timeout que mata el proceso |
| **F2** Archivos | list/read/write + upload/download chunked con SHA-256 | Transferir un binario de 50 MB ida y vuelta con hash idéntico |
| **F3** Inventario, procesos, screenshot, bandeja | `agent_info`, `agent_ps_*`, `agent_screenshot` (monitor primario); app de bandeja completa (estados, enable/disable, autostart, open logs); doc de instalación | Screenshot correcto en Windows con sesión de usuario; error claro en sesión 0; el tray refleja connected/paused y el usuario puede desactivar |
| **F4** Operación | CLI admin, tokens revocables, auditoría, backoff, límites, E2E con 2+ agentes concurrentes | Matar/revivir el server: los agentes se reconectan solos ≤ 60 s; token revocado rechazado |
| **F5** Empaquetado + LAN | Build `.exe` (`bun run build:exe`, icono multi-tamaño generado en repo, metadatos Windows en builds desde Windows), `agent/install.ps1` (ámbito usuario, DPAPI, autostart, uninstall), MCP por HTTP con Bearer (`--mcp-http-port`, `--no-mcp-stdio`), unit systemd + `server/env.example`, checklist LAN (sin Tailscale/VPN: IP estática, firewall, `ws://`+`http://` en red local de confianza) | Instalación desde cero en una Windows limpia en < 10 min (instalador → icono en bandeja verificado); servidor persistente bajo systemd operable desde opencode remoto |
| **F6** Backlog | Modo servicio para el agente (sin UI), servicios Windows, registry, shutdown/reboot gateado, UI automation, multi-monitor, OTA del agente | — |

**Estado (2026-10-16):**
- ✅ **F0 completado en su parte Linux**: protocolo compartido, hub WS (hello/heartbeat/presence/jobs con timeout+cancel), tool `agents_list`, agente falso, 11 tests unitarios y e2e de caja negra en verde.
- ⏳ **F0 pendiente de VM**: validar `agent/tray/first-run.ps1` y `agent/tray/tray.ps1` en Windows real (ver `agent/tray/README.md`) — es el spike de la pieza más arriesgada del diseño.
- ✅ **F1 completado en su parte Linux**: agente real (`agent/src`) con reconexión/backoff, `agent_exec` con streaming de stdout/stderr, exit codes, stdin/env/cwd, timeout y cancel que matan el árbol de procesos (grupo POSIX / `taskkill /T /F` en Windows).
- ⏳ **F1 pendiente de VM**: validar en Windows los shells (`cmd.exe`, `powershell.exe`) y la ruta de kill con `taskkill /T /F`.
- ✅ **F2 completado en su parte Linux** (criterio de aceptación verificado): jobs `fs.list/fs.read/fs.write/fs.hash` en el agente; tools `agent_fs_list/read/write/upload/download`; transferencias chunked (256 KiB, tope de chunk 512 KiB) con verificación SHA-256 y tamaño en ambos sentidos; **transferencia de 50 MB ida y vuelta con hash idéntico en el test de integración**; 36 tests + e2e (19 checks) en verde.
- ⏳ **F2 pendiente de VM**: probar rutas Windows (`C:\...`), archivos con tamaño de chunk límite y nombres con acentos.
- ✅ **F3 completado en su parte Linux**: jobs `info`/`ps.list`/`ps.kill`/`screenshot` en el agente; tools `agent_info`, `agent_ps_list`, `agent_ps_kill`, `agent_screenshot`; screenshot capturado a temporal en el agente y descargado chunked al servidor (imagen embebida en el resultado MCP o solo path); bandeja completa (`agent/tray/tray.ps1` + `agent/src/tray.ts` por JSON-lines: iconos de color por estado, enable/disable sin desconectar, reconnect now, open logs, autostart, exit) con test de integración contra un helper falso; ajustes de agente (`agent.json` + DPAPI + diálogo de primer arranque + logs rotativos a archivo); procesos Windows vía `Get-Process` (dos muestras para CPU%) y Linux vía `/proc`; **64 tests + e2e (25 checks) en verde**, typecheck limpio.
- ⏳ **F3 pendiente de VM**: bandeja (iconos/estados/menú/instancia única), primer arranque + DPAPI, screenshot con sesión interactiva y error en sesión 0, `taskkill /T /F`, `Get-Process`/`Get-CimInstance`, `Stop-Process`.
- ✅ **F4 completado**: tokens de enrolamiento por agente en SQLite (`server/src/store.ts` + `registry.ts`): CLI `admin agent add/list/revoke/rotate`, id fijado al primer `hello`, solo hashes SHA-256 guardados, nombres activos únicos; revocación efectiva en conexiones nuevas y en sesiones vivas (caen en el siguiente heartbeat); modo estricto `MRC_REQUIRE_DB_TOKENS=1`; auditoría JSONL append-only (`server/data/audit.jsonl`, rotación 10 MB: tool calls con params sanitizados, eventos del hub, acciones admin; secretos redactados, blobs truncados); límites en el hub (`agent_busy` por concurrencia, `rate_limited` por ritmo, chunks internos exentos); identidad estable del agente ante reinicios (id persistido en `agent.json`); docs en `docs/OPERATIONS.md`; **81 tests + e2e (25 checks) en verde**, typecheck limpio.
- ⏳ **F4 pendiente de VM**: nada específico (todo validable en Linux); el cierre F1–F3 en VM sigue pendiente para cuando haya una Windows disponible.
- ✅ **F5 completado en su parte Linux**: `bun run build:exe` cross-compila `dist/rc-agent.exe` (PE válido verificado: MZ + firma PE, ~92 MB, `--windows-hide-console`; metadatos icono/versión solo al compilar en Windows, limitación de Bun); `agent/assets/icon.ico` multi-tamaño (16/32/48/256) generado en repo con test de determinismo; `agent/install.ps1` (sin admin, DPAPI, autostart HKCU, uninstall/purge, idempotente); MCP por Streamable HTTP en `/mcp` con Bearer (`MRC_MCP_HTTP_PORT`, `--no-mcp-stdio`) con tests (401 + handshake + tools); unit systemd + `server/env.example`; docs LAN en `docs/OPERATIONS.md` (IP estática, ufw, opencode remoto, agentes); **88 tests + e2e (25 checks) en verde**, typecheck limpio.
- ⏳ **F5 pendiente de VM/Windows real**: instalador de cero en Windows limpia (< 10 min), exe con icono + metadatos compilado en Windows, opencode remoto contra `:8788`, checklist `docs/INSTALL-WINDOWS.md`.
- **Actualización 2026-10-17 (primera máquina Windows real conectada — DESKTOP-S7PG32F)**: validado en vivo por túnel: `agent_exec` (cmd + powershell), `agent_info`, `agent_ps_list`, transferencias y screenshot (por fallback manual). Hallazgos corregidos ya: AMSI bloqueaba el script PowerShell del screenshot → **fallback `csc.exe`** (Plan B del plan) implementado y testeado; MCP-HTTP tenía sesión única (el 2º cliente/reconexión recibía 400) → **multi-sesión**; `cwd` UNC heredado del share rompía `cmd.exe` → default a `SystemRoot`. F6 adelantado: **TLS nativo** (`MRC_TLS_CERT/KEY` + `--tls-insecure` en el agente), **self-update OTA** (`agent_restart` + `updatePath`, swap de exe + relanzamiento detached) y **CI** (workflow con job `windows-latest`) + script de named tunnel para URLs estables. Pendiente en esa máquina: reiniciar el agente con el exe nuevo (v0.5.3 en el share) para screenshot automático.
- Siguiente: **F6** restante (modo servicio, firma de código, servicios Windows, UI automation, multi-monitor).
- ✅ **Actualización 2026-10-17 (F6 adelantado, 3 lotes de tools, solo servidor — sin recompilar el agente)**: (1) *Windows ops* `agent_services`, `agent_service_control`, `agent_eventlog`, `agent_net_ports`, `agent_net_test`, `agent_fs_hash`; (2) *energía y ficheros* `agent_power`, `agent_message`, `agent_fs_search/mkdir/move/copy/delete`; (3) *jobs asíncronos* `agent_exec_async`, `agent_job_status/list/cancel` con registro retenido en el hub (`MRC_JOB_HISTORY_MAX`, `MRC_JOB_HISTORY_TTL_MS`, salida acotada) y cancelación del árbol remoto. **179 tests + e2e en verde**, typecheck limpio. Todo el texto nuevo (descripciones, errores, docs) en inglés salvo esta bitácora.
- ✅ **Actualización 2026-10-18 (lote de diagnóstico, solo servidor)**: `GET /health` enriquecido (uptime, contadores de flota/jobs, `lastAgentSeenAt`) sobre `hub.stats()`; tools `agent_software` (inventario desde las claves Uninstall 64/32-bit + HKCU, deduplicado), `agent_time` (reloj/zona + desfase medido contra el servidor + estado W32Time/NTP best-effort) y `agent_sessions` (logones vía CIM `Win32_LogonSession` + asociación `Win32_LoggedOnUser`, locale-proof; por defecto solo interactive/RDP); retención de screenshots `MRC_SCREENSHOT_KEEP` (def 200; poda tras cada guardado y al arrancar, solo `.png/.jpg` regulares del directorio). **192 tests + e2e en verde**, typecheck limpio.

---

## 7. Pruebas

- **Fake agent** en Linux (`scripts/dev-fake-agent.ts`) → desarrollo y CI sin Windows.
- **Unitarios**: hub (conexión/desconexión/timeout/cancel), validación de protocolo,
  registry (tokens, fijado de agentId, revocación).
- **E2E**: server + 2 fake agents + cliente MCP dirigiendo llamadas a las tools.
- **Windows real**: 1 VM (Proxmox disponible en este host) para screenshot, procesos, bandeja
  (icono, enable/disable, autostart) y primer arranque pidiendo nombre; rutas con
  espacios/acentos; matriz cmd vs PowerShell, salidas > 1 MB, binarios.
- **Seguridad**: token inválido/revocado/fijado a otra máquina, frames sobredimensionados.

---

## 8. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Antivirus/EDR bloquea `.exe` no firmado | Exclusión documentada; firma de código como backlog; el agente no hace nada "raro" (conexión saliente + ejecución local) |
| EDR recela del helper de bandeja (PowerShell) | Helper mínimo (NotifyIcon WinForms) sin `-EncodedCommand`; plan B: `tray.exe` en C# compilado con `csc.exe` (presente en Windows 10/11) |
| El usuario cierra el agente desde la bandeja | Es intencional (`Exit`); `Disable` pausa sin desconectar; autostart opcional y logs dejan rastro |
| Screenshot requiere sesión interactiva | Detección + error claro; modo de instalación recomendado (tarea programada/autostart); modo servicio documentado para el resto de capacidades |
| `.exe` de ~92 MB (runtime de Bun) | Aceptable en LAN; backlog: UPX/compresión o evaluar Go solo para el agente si molesta |
| Salida gigante satura el WebSocket | Límites + truncado + recomendación de volcar a archivo y usar `agent_fs_download` |
| Certificados autofirmados en LAN | Postura v1: LAN de confianza sin cifrar; `wss://` + `--ca` en backlog (F6) |
| Bun cross-compile evoluciona | Spike ya validado en 1.4.3; el build queda fijado por versión en CI |

---

## 9. Decisiones

**Resueltas en esta sesión:**
- ~~Screenshot multi-monitor~~ → **solo monitor primario**.
- Primer arranque → **el `.exe` pide el nombre de la máquina** (diálogo, prellenado con `%COMPUTERNAME%`).
- UI → **app de bandeja** con icono junto al reloj, **activar/desactivar** sin desconectar, autostart opcional.
- ~~Idioma de logs/errores~~ → **inglés** (agente, servidor y superficie MCP).
- **Modo servicio**: descartado por ahora → queda en **F6 (backlog)**.

**Abiertas:**
1. Nombre definitivo del repo/marca (`mcp-remote-control` es provisional).
