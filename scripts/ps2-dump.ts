/**
 * Dumps the actual PowerShell that the Windows tools would send, with test
 * arguments, so each script can be executed against a real Windows 7 agent
 * (PowerShell 2.0) before deploying the hub.
 *
 * Run: bun run scripts/ps2-dump.ts <outdir>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  fsSearchScript,
  fsMkdirScript,
  fsTransferScript,
  fsDeleteScript,
} from "../server/src/tools/agent-fs.ts";
import { eventLogScript } from "../server/src/tools/agent-eventlog.ts";
import { servicesListScript } from "../server/src/tools/agent-services.ts";
import { softwareScript, timeScript, sessionsScript } from "../server/src/tools/agent-diagnostics.ts";
import { netPortsScript, netTestScript } from "../server/src/tools/agent-net.ts";

const out = process.argv[2] ?? "/tmp/ps2tests";
mkdirSync(out, { recursive: true });

const T = "C:\\Users\\AUTORIZACION\\AppData\\Local\\Temp\\mrctest";
const files: Record<string, string> = {
  "search.ps1": fsSearchScript({
    path: T, pattern: "*.txt", recursive: true, maxDepth: 2,
    minBytes: -1, maxBytes: -1, newerThanDays: -1, olderThanDays: -1, top: 50,
  }),
  "mkdir.ps1": fsMkdirScript({ path: `${T}\\sub`, parents: true }),
  "copy.ps1": fsTransferScript({ source: `${T}\\a.txt`, destination: `${T}\\b.txt`, overwrite: false, kind: "copy" }),
  "move.ps1": fsTransferScript({ source: `${T}\\b.txt`, destination: `${T}\\c.txt`, overwrite: false, kind: "move" }),
  "delete-file.ps1": fsDeleteScript({ path: `${T}\\c.txt`, recursive: false }),
  "delete-dir.ps1": fsDeleteScript({ path: `${T}\\sub`, recursive: true }),
  "eventlog.ps1": eventLogScript({ agent: "AUTORIZACION", log: "System", level: "error", hours: 48, max: 3, messageChars: 120 }),
  "services.ps1": servicesListScript({ agent: "AUTORIZACION", filter: "chrome", top: 5 }),
  "software.ps1": softwareScript({ agent: "AUTORIZACION", filter: "chrome", scope: "machine", top: 5 }),
  "time.ps1": timeScript(),
  "sessions.ps1": sessionsScript({ interactiveOnly: true }),
  "sessions-all.ps1": sessionsScript({ interactiveOnly: false }),
  "net-ports.ps1": netPortsScript({ agent: "AUTORIZACION", protocol: "tcp", state: "listen", top: 5 }),
  "net-test.ps1": netTestScript({ agent: "AUTORIZACION", host: "192.168.1.1", port: 80, count: 2, dns: true, ping: false }),
};

for (const [name, content] of Object.entries(files)) {
  writeFileSync(join(out, name), content, "utf8");
  console.log(`${name}\t${content.length}`);
}
console.log(`written to ${out}`);
