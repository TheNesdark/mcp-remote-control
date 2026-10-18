/**
 * agent_fs: consolidated remote-file tools.
 *
 * agent_fs     — operation: list | read | write | hash | search | mkdir |
 *                move | copy | delete (one hub job each: fs.* or PowerShell).
 * agent_fs_transfer — operation: upload | download (chunked copy THROUGH this
 *                server with end-to-end sha256, 1 GiB cap; hand-written
 *                handlers, not hub jobs).
 *
 * Auditing keeps the former per-operation names (agent_fs_list,
 * agent_fs_delete, agent_fs_upload, ...) so existing audit consumers are
 * unaffected.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { FS_MAX_CHUNK_BYTES } from "@mrc/shared";
import { auditToolCall, type AuditLog } from "../audit.ts";
import type { Hub } from "../hub.ts";
import { registerJobTool } from "./job-tool.ts";
import {
  buildPsScript,
  PS_DEFAULT_TIMEOUT_MS,
  psBool,
  psEnvelopeData,
  psExecParams,
  psFailure,
  psQuote,
  windowsOnly,
} from "./powershell.ts";
import { downloadFile, uploadFile } from "../transfers.ts";
import { toolError, toolJson } from "./util.ts";

/** A bare drive root or a bare separator is never a valid target for these tools. */
export function guardMachineRoot(path: string): string | null {
  const trimmed = path.trim();
  if (/^[a-zA-Z]:[\\/]?$/.test(trimmed)) return `refusing to operate on a drive root ('${path}')`;
  if (/^[\\/]+$/.test(trimmed)) return `refusing to operate on '${path}'`;
  return null;
}

export interface FsEntry {
  fullName: string;
  name: string;
  size: number;
  mtime: string;
}

export const FS_OPERATIONS = ["list", "read", "write", "hash", "search", "mkdir", "move", "copy", "delete"] as const;

type FsOperation = (typeof FS_OPERATIONS)[number];

interface FsArgs {
  agent: string;
  operation: FsOperation;
  path?: string;
  limit?: number;
  encoding?: "utf8" | "base64";
  maxBytes?: number;
  content?: string;
  mkdirs?: boolean;
  pattern?: string;
  recursive?: boolean;
  maxDepth?: number;
  minBytes?: number;
  newerThanDays?: number;
  olderThanDays?: number;
  top?: number;
  confirm?: boolean;
  source?: string;
  destination?: string;
  overwrite?: boolean;
}

interface ReadMeta {
  bytes?: number;
  eof?: boolean;
  size?: number;
  sha256?: string | null;
}

interface WriteMeta {
  bytesWritten?: number;
  sizeAfter?: number;
}

interface ListMeta {
  count?: number;
  truncated?: boolean;
}

interface FsSearchData {
  path: string;
  pattern: string;
  matched: number;
  returned: number;
  truncated: boolean;
  entries: FsEntry[];
}

// ---------------------------------------------------------------------------
// PowerShell builders (run via jobType 'exec')
// ---------------------------------------------------------------------------

/** PowerShell that lists files under a directory with size/date filters. */
export function fsSearchScript(args: {
  path: string;
  pattern: string;
  recursive: boolean;
  maxDepth: number;
  minBytes: number;
  maxBytes: number;
  newerThanDays: number;
  olderThanDays: number;
  top: number;
}): string {
  return buildPsScript([
    `$__path = ${psQuote(args.path)}`,
    `$__pattern = ${psQuote(args.pattern)}`,
    `$__recursive = ${psBool(args.recursive)}`,
    `$__depth = ${args.maxDepth}`,
    `$__min = ${args.minBytes}`,
    `$__max = ${args.maxBytes}`,
    `$__newer = ${args.newerThanDays}`,
    `$__older = ${args.olderThanDays}`,
    `$__top = ${args.top}`,
    'if (-not (Test-Path -LiteralPath $__path -PathType Container)) { throw "directory not found: $__path" }',
    "if ($__recursive) {",
    "  $__items = @(Get-ChildItem -LiteralPath $__path -Filter $__pattern -File -Force -Recurse -Depth $__depth -ErrorAction SilentlyContinue)",
    "} else {",
    "  $__items = @(Get-ChildItem -LiteralPath $__path -Filter $__pattern -File -Force -ErrorAction SilentlyContinue)",
    "}",
    "if ($__min -ge 0) { $__items = @($__items | Where-Object { $_.Length -ge $__min }) }",
    "if ($__max -ge 0) { $__items = @($__items | Where-Object { $_.Length -le $__max }) }",
    "if ($__newer -gt 0) { $__cut = (Get-Date).AddDays(-1 * $__newer); $__items = @($__items | Where-Object { $_.LastWriteTime -ge $__cut }) }",
    "if ($__older -gt 0) { $__cut = (Get-Date).AddDays(-1 * $__older); $__items = @($__items | Where-Object { $_.LastWriteTime -le $__cut }) }",
    "$__sorted = @($__items | Sort-Object LastWriteTime -Descending)",
    "$__entries = foreach ($__i in @($__sorted | Select-Object -First $__top)) {",
    "  [pscustomobject]@{ fullName = $__i.FullName; name = $__i.Name; size = $__i.Length; mtime = $__i.LastWriteTime.ToString('o') }",
    "}",
    "$__r = @{ path = (Get-Item -LiteralPath $__path).FullName; pattern = $__pattern; matched = $__sorted.Count; returned = @($__entries).Count; truncated = ($__sorted.Count -gt $__top); entries = @($__entries) }",
  ]);
}

/** PowerShell that creates one directory and reports whether it was new. */
export function fsMkdirScript(args: { path: string; parents: boolean }): string {
  return buildPsScript([
    `$__path = ${psQuote(args.path)}`,
    `$__parents = ${psBool(args.parents)}`,
    "$__existed = Test-Path -LiteralPath $__path -PathType Container",
    "if ($__parents) { New-Item -ItemType Directory -Path $__path -Force -ErrorAction Stop | Out-Null }",
    "else { New-Item -ItemType Directory -Path $__path -ErrorAction Stop | Out-Null }",
    "$__r = @{ path = (Get-Item -LiteralPath $__path).FullName; created = (-not $__existed) }",
  ]);
}

/** PowerShell that copies or moves a file/directory, refusing silent overwrites. */
export function fsTransferScript(args: {
  source: string;
  destination: string;
  overwrite: boolean;
  kind: "move" | "copy";
}): string {
  const verb = args.kind === "move" ? "Move-Item" : "Copy-Item";
  const recurse = args.kind === "copy" ? " -Recurse" : "";
  return buildPsScript([
    `$__source = ${psQuote(args.source)}`,
    `$__destination = ${psQuote(args.destination)}`,
    `$__overwrite = ${psBool(args.overwrite)}`,
    'if (-not (Test-Path -LiteralPath $__source)) { throw "source not found: $__source" }',
    "$__existed = Test-Path -LiteralPath $__destination",
    'if ($__existed -and -not $__overwrite) { throw "destination already exists: $__destination (pass overwrite=true to replace it)" }',
    `if ($__overwrite) { ${verb} -LiteralPath $__source -Destination $__destination${recurse} -Force -ErrorAction Stop }`,
    `else { ${verb} -LiteralPath $__source -Destination $__destination${recurse} -ErrorAction Stop }`,
    "$__item = Get-Item -LiteralPath $__destination",
    "$__type = 'file'",
    "if ($__item.PSIsContainer) { $__type = 'dir' }",
    "$__r = @{ source = $__source; destination = $__item.FullName; type = $__type; overwritten = $__existed }",
  ]);
}

/** PowerShell that deletes one path (directory only when empty or recursive). */
export function fsDeleteScript(args: { path: string; recursive: boolean }): string {
  return buildPsScript([
    `$__path = ${psQuote(args.path)}`,
    `$__recursive = ${psBool(args.recursive)}`,
    'if (-not (Test-Path -LiteralPath $__path)) { throw "path not found: $__path" }',
    "$__item = Get-Item -LiteralPath $__path -Force",
    "$__type = 'file'",
    "if ($__item.PSIsContainer) {",
    "  $__type = 'dir'",
    "  $__children = @(Get-ChildItem -LiteralPath $__path -Force -ErrorAction SilentlyContinue).Count",
    '  if ($__children -gt 0 -and -not $__recursive) { throw "directory is not empty ($__children entries); pass recursive=true to delete it" }',
    "  if ($__recursive) { Remove-Item -LiteralPath $__path -Recurse -Force -ErrorAction Stop }",
    "  else { Remove-Item -LiteralPath $__path -Force -ErrorAction Stop }",
    "} else {",
    "  Remove-Item -LiteralPath $__path -Force -ErrorAction Stop",
    "}",
    "$__r = @{ path = $__item.FullName; type = $__type; deleted = $true }",
  ]);
}

/** Operations that run PowerShell on the agent (and are therefore Windows-only). */
const PS_OPERATIONS: readonly FsOperation[] = ["search", "mkdir", "move", "copy", "delete"];

function requireString(value: string | undefined, field: string, op: string): string | null {
  return value === undefined || value.length === 0 ? `'${field}' is required for operation '${op}'` : null;
}

export function registerAgentFs(server: McpServer, hub: Hub, audit: AuditLog | null = null): void {
  registerJobTool<FsArgs>(server, hub, audit, {
    name: "agent_fs",
    title: "Work with files on a remote agent",
    description:
      "One remote-file tool, selected by 'operation'. " +
      "list: contents of a directory (or info on one file): name, type (file|dir|symlink|other), size, mtime. " +
      "read: up to maxBytes from the start of a file, utf8 (default) or base64; when truncated, fetch the whole " +
      "file with agent_fs_transfer. " +
      "write: create/overwrite a file with content up to 64 KiB (returns the sha256 of the written bytes). " +
      "hash: SHA-256 (and size) of a remote file without transferring it — compare installers/logs/backups across " +
      "machines. " +
      "search: files under a directory, newest first, with pattern/depth/size/age filters — the cheap way to find " +
      "a log or a stale backup; deep recursion over a whole drive can exceed the timeout, so narrow 'path' or " +
      "maxDepth (Windows only). " +
      "mkdir: create a directory (missing parents are created). " +
      "move/copy: move (rename) or copy (recursively, for directories) a path ON the remote machine — no bytes " +
      "travel through this server, and an existing destination is refused unless overwrite=true; when the " +
      "destination is an existing directory the source lands inside it, standard Windows semantics (Windows only). " +
      "delete: permanent removal (no recycle bin): needs confirm=true, refuses drive roots, and a non-empty " +
      "directory needs recursive=true (Windows only).",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      operation: z.enum(FS_OPERATIONS).describe("Which file operation to run."),
      path: z.string().min(1).optional().describe("(list/read/write/hash/search/mkdir/delete) Target file or directory."),
      limit: z.number().int().positive().max(5_000).optional().describe("(list) Maximum entries to return (default 1000)."),
      encoding: z
        .enum(["utf8", "base64"])
        .optional()
        .describe("(read/write) How to return or interpret content (default utf8)."),
      maxBytes: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(`(read) Maximum bytes to read (default 65536, max ${FS_MAX_CHUNK_BYTES}); (search) only files at most this large.`),
      content: z.string().optional().describe("(write) File content (see `encoding`)."),
      mkdirs: z.boolean().optional().describe("(write) Create parent directories when missing (default false)."),
      pattern: z.string().optional().describe("(search) File-name pattern for -Filter (default '*'): '*.log'."),
      recursive: z
        .boolean()
        .optional()
        .describe("(search) Descend into subdirectories (default false); (delete) delete directories with contents (default false)."),
      maxDepth: z.number().int().min(0).max(64).optional().describe("(search) Recursion depth when recursive (default 3)."),
      minBytes: z.number().int().nonnegative().optional().describe("(search) Only files at least this large."),
      newerThanDays: z.number().int().positive().optional().describe("(search) Only files modified in the last N days."),
      olderThanDays: z.number().int().positive().optional().describe("(search) Only files last modified at least N days ago."),
      top: z
        .number()
        .int()
        .positive()
        .max(5_000)
        .optional()
        .describe("(search) Return at most this many files (default 200)."),
      confirm: z.boolean().optional().describe("(delete) Must be true: deletion is permanent."),
      source: z.string().min(1).optional().describe("(move/copy) Path to move or copy."),
      destination: z.string().min(1).optional().describe("(move/copy) Target path."),
      overwrite: z.boolean().optional().describe("(move/copy) Replace the destination when it exists (default false)."),
    },
    options: {
      op: (args) => `agent_fs_${args.operation}`,
      jobType: (args) =>
        args.operation === "list"
          ? "fs.list"
          : args.operation === "read"
            ? "fs.read"
            : args.operation === "write"
              ? "fs.write"
              : args.operation === "hash"
                ? "fs.hash"
                : "exec",
      validate: (args) => {
        switch (args.operation) {
          case "list":
            return requireString(args.path, "path", args.operation);
          case "read": {
            const pathError = requireString(args.path, "path", args.operation);
            if (pathError) return pathError;
            return args.maxBytes !== undefined && args.maxBytes > FS_MAX_CHUNK_BYTES
              ? `maxBytes ${args.maxBytes} exceeds the per-call limit of ${FS_MAX_CHUNK_BYTES}; use agent_fs_transfer`
              : null;
          }
          case "hash":
          case "search":
          case "mkdir":
            return requireString(args.path, "path", args.operation);
          case "write": {
            const pathError = requireString(args.path, "path", args.operation);
            if (pathError) return pathError;
            const content = args.content ?? "";
            const length =
              (args.encoding ?? "utf8") === "base64" ? Buffer.from(content, "base64").length : Buffer.byteLength(content, "utf8");
            return length > FS_MAX_CHUNK_BYTES
              ? `content too large (${length} bytes, max ${FS_MAX_CHUNK_BYTES}); use agent_fs_transfer instead`
              : null;
          }
          case "move":
          case "copy":
            return (
              requireString(args.source, "source", args.operation) ??
              requireString(args.destination, "destination", args.operation) ??
              windowsOnly(hub)(args) ??
              guardMachineRoot(args.source!) ??
              guardMachineRoot(args.destination!)
            );
          case "delete":
            if (args.confirm !== true) return `refusing to delete '${args.path}' without confirm=true`;
            return requireString(args.path, "path", args.operation) ?? windowsOnly(hub)(args) ?? guardMachineRoot(args.path!);
        }
      },
      timeoutMs: (args) => (PS_OPERATIONS.includes(args.operation) ? PS_DEFAULT_TIMEOUT_MS : undefined),
      buildParams: (args) => {
        switch (args.operation) {
          case "list":
            return { path: args.path, limit: args.limit ?? 1000 };
          case "read":
            return { path: args.path, offset: 0, length: args.maxBytes ?? 65_536 };
          case "write": {
            const bytes =
              (args.encoding ?? "utf8") === "base64"
                ? Buffer.from(args.content ?? "", "base64")
                : Buffer.from(args.content ?? "", "utf8");
            return { path: args.path, data: bytes.toString("base64"), mode: "overwrite", mkdirs: args.mkdirs ?? false };
          }
          case "hash":
            return { path: args.path };
          case "search":
            return psExecParams(
              fsSearchScript({
                path: args.path!,
                pattern: args.pattern ?? "*",
                recursive: args.recursive ?? false,
                maxDepth: args.maxDepth ?? 3,
                minBytes: args.minBytes ?? -1,
                maxBytes: args.maxBytes ?? -1,
                newerThanDays: args.newerThanDays ?? -1,
                olderThanDays: args.olderThanDays ?? -1,
                top: args.top ?? 200,
              }),
            );
          case "mkdir":
            return psExecParams(fsMkdirScript({ path: args.path!, parents: true }));
          case "move":
          case "copy":
            return psExecParams(
              fsTransferScript({
                source: args.source!,
                destination: args.destination!,
                overwrite: args.overwrite ?? false,
                kind: args.operation,
              }),
            );
          case "delete":
            return psExecParams(fsDeleteScript({ path: args.path!, recursive: args.recursive ?? false }));
        }
      },
      buildFailure: (outcome, args) => (PS_OPERATIONS.includes(args.operation) ? psFailure(outcome) : undefined),
      buildResult: (outcome, args) => {
        switch (args.operation) {
          case "list": {
            const payload = JSON.parse(outcome.stdout || "{}") as { path?: string; entries?: unknown[] };
            const meta = (outcome.meta ?? {}) as ListMeta;
            return {
              path: payload.path ?? args.path,
              count: meta.count ?? payload.entries?.length ?? 0,
              truncated: meta.truncated ?? false,
              entries: payload.entries ?? [],
            };
          }
          case "read": {
            const encoding = args.encoding ?? "utf8";
            const meta = (outcome.meta ?? {}) as ReadMeta;
            const buffer = Buffer.from(outcome.stdout, "base64");
            return {
              path: args.path,
              encoding,
              size: meta.size ?? null,
              bytesRead: meta.bytes ?? 0,
              eof: meta.eof ?? true,
              truncated: !(meta.eof ?? true),
              sha256: meta.sha256 ?? null,
              content: encoding === "utf8" ? buffer.toString("utf8") : outcome.stdout,
            };
          }
          case "write": {
            const bytes =
              (args.encoding ?? "utf8") === "base64"
                ? Buffer.from(args.content ?? "", "base64")
                : Buffer.from(args.content ?? "", "utf8");
            const meta = (outcome.meta ?? {}) as WriteMeta;
            return {
              ok: true,
              path: args.path,
              bytes: meta.bytesWritten ?? bytes.length,
              size: meta.sizeAfter ?? null,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            };
          }
          case "hash": {
            const meta = (outcome.meta ?? {}) as { sha256?: string; size?: number };
            return { ok: true, path: args.path, sha256: meta.sha256 ?? null, size: meta.size ?? null };
          }
          case "search":
            return psEnvelopeData<FsSearchData>(outcome.stdout);
          case "mkdir":
            return psEnvelopeData<{ path: string; created: boolean }>(outcome.stdout);
          case "move":
          case "copy":
            return psEnvelopeData<{ source: string; destination: string; type: string; overwritten: boolean }>(outcome.stdout);
          case "delete":
            return psEnvelopeData<{ path: string; type: string; deleted: boolean }>(outcome.stdout);
        }
      },
    },
  });

  // upload/download: chunked transfers through this server, not hub jobs.
  server.registerTool(
    "agent_fs_transfer",
    {
      title: "Upload or download a file with a remote agent",
      description:
        "Chunked copy between this (central server) machine and a remote machine, verifying sha256 end to end " +
        "(1 GiB cap). operation='upload' copies localPath on the server to remotePath on the agent (mkdirs creates " +
        "remote parents); operation='download' copies remotePath on the agent to localPath on the server. Big " +
        "files can take a while.",
      inputSchema: {
        agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
        operation: z.enum(["upload", "download"]).describe("upload: server -> agent; download: agent -> server."),
        localPath: z.string().min(1).describe("(upload) Source on the server; (download) destination on it."),
        remotePath: z.string().min(1).describe("(upload) Destination on the agent; (download) source on it."),
        mkdirs: z.boolean().optional().describe("(upload) Create parent directories on the remote side (default false)."),
        timeoutMs: z.number().int().positive().optional().describe("Per-chunk timeout in milliseconds."),
      },
    },
    async (args) => {
      const startedAt = Date.now();
      const op = `agent_fs_${args.operation}`;
      try {
        const result =
          args.operation === "upload"
            ? await uploadFile(hub, args.agent, args.localPath, args.remotePath, {
                mkdirs: args.mkdirs ?? false,
                timeoutMs: args.timeoutMs,
              })
            : await downloadFile(hub, args.agent, args.remotePath, args.localPath, { timeoutMs: args.timeoutMs });
        if (audit) auditToolCall(audit, { op, agent: args.agent, params: args, startedAt, ok: true, bytes: result.bytes });
        return toolJson({
          ok: true,
          [args.operation === "upload" ? "remotePath" : "localPath"]: result.path,
          bytes: result.bytes,
          sha256: result.sha256,
        });
      } catch (err) {
        if (audit) {
          auditToolCall(audit, {
            op,
            agent: args.agent,
            params: args,
            startedAt,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return toolError(err);
      }
    },
  );
}
