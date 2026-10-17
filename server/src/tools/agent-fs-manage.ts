import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuditLog } from "../audit.ts";
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

// ---------------------------------------------------------------------------
// agent_fs_search
// ---------------------------------------------------------------------------

export interface FsSearchArgs {
  agent: string;
  path: string;
  pattern: string;
  recursive: boolean;
  maxDepth: number;
  minBytes: number;
  maxBytes: number;
  newerThanDays: number;
  olderThanDays: number;
  top: number;
}

export interface FsSearchData {
  path: string;
  pattern: string;
  matched: number;
  returned: number;
  truncated: boolean;
  entries: FsEntry[];
}

/** PowerShell that lists files under a directory with size/date filters. */
export function fsSearchScript(args: FsSearchArgs): string {
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

export function registerAgentFsSearch(server: McpServer, hub: Hub, audit: AuditLog | null = null): void {
  registerJobTool<FsSearchArgs>(server, hub, audit, {
    name: "agent_fs_search",
    title: "Search files on a remote agent",
    description:
      "List files under a remote directory, newest first, with optional filters: name pattern (filesystem wildcards " +
      "like '*.log'), recursion depth, size range and age in days. Returns full paths, sizes and modification times. " +
      "This is the cheap way to find a log or a stale backup; use agent_fs_list for a single directory listing. " +
      "Deep recursion over a whole drive can exceed the timeout: narrow 'path' or use maxDepth.",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      path: z.string().min(1).describe("Directory to search (e.g. 'C:\\\\Logs')."),
      pattern: z.string().optional().describe("File-name pattern for -Filter (default '*'): '*.log', 'backup-*.zip'."),
      recursive: z.boolean().optional().describe("Descend into subdirectories (default false)."),
      maxDepth: z.number().int().min(0).max(64).optional().describe("Recursion depth when recursive (default 3)."),
      minBytes: z.number().int().nonnegative().optional().describe("Only files at least this large."),
      maxBytes: z.number().int().nonnegative().optional().describe("Only files at most this large."),
      newerThanDays: z.number().int().positive().optional().describe("Only files modified in the last N days."),
      olderThanDays: z.number().int().positive().optional().describe("Only files last modified at least N days ago."),
      top: z.number().int().positive().max(5_000).optional().describe("Return at most this many files (default 200)."),
    },
    options: {
      op: "agent_fs_search",
      jobType: "exec",
      validate: windowsOnly(hub),
      timeoutMs: () => PS_DEFAULT_TIMEOUT_MS,
      buildParams: (args) =>
        psExecParams(
          fsSearchScript({
            agent: args.agent,
            path: args.path,
            pattern: args.pattern ?? "*",
            recursive: args.recursive ?? false,
            maxDepth: args.maxDepth ?? 3,
            minBytes: args.minBytes ?? -1,
            maxBytes: args.maxBytes ?? -1,
            newerThanDays: args.newerThanDays ?? -1,
            olderThanDays: args.olderThanDays ?? -1,
            top: args.top ?? 200,
          }),
        ),
      buildFailure: (outcome) => psFailure(outcome),
      buildResult: (outcome) => psEnvelopeData<FsSearchData>(outcome.stdout),
    },
  });
}

// ---------------------------------------------------------------------------
// agent_fs_mkdir
// ---------------------------------------------------------------------------

export interface FsMkdirArgs {
  agent: string;
  path: string;
  parents: boolean;
}

/** PowerShell that creates one directory and reports whether it was new. */
export function fsMkdirScript(args: FsMkdirArgs): string {
  return buildPsScript([
    `$__path = ${psQuote(args.path)}`,
    `$__parents = ${psBool(args.parents)}`,
    "$__existed = Test-Path -LiteralPath $__path -PathType Container",
    "if ($__parents) { New-Item -ItemType Directory -Path $__path -Force -ErrorAction Stop | Out-Null }",
    "else { New-Item -ItemType Directory -Path $__path -ErrorAction Stop | Out-Null }",
    "$__r = @{ path = (Get-Item -LiteralPath $__path).FullName; created = (-not $__existed) }",
  ]);
}

export function registerAgentFsMkdir(server: McpServer, hub: Hub, audit: AuditLog | null = null): void {
  registerJobTool<FsMkdirArgs>(server, hub, audit, {
    name: "agent_fs_mkdir",
    title: "Create a directory on a remote agent",
    description:
      "Create a directory on a remote machine. parents=true (the default) creates missing intermediate directories " +
      "and succeeds when the directory already exists; parents=false fails unless the parent already exists. " +
      "Returns the resolved absolute path and whether it was created.",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      path: z.string().min(1).describe("Directory path to create."),
      parents: z.boolean().optional().describe("Create intermediate directories too (default true)."),
    },
    options: {
      op: "agent_fs_mkdir",
      jobType: "exec",
      validate: windowsOnly(hub),
      timeoutMs: () => PS_DEFAULT_TIMEOUT_MS,
      buildParams: (args) =>
        psExecParams(
          fsMkdirScript({ agent: args.agent, path: args.path, parents: args.parents ?? true }),
        ),
      buildFailure: (outcome) => psFailure(outcome),
      buildResult: (outcome) => psEnvelopeData<{ path: string; created: boolean }>(outcome.stdout),
    },
  });
}

// ---------------------------------------------------------------------------
// agent_fs_move / agent_fs_copy
// ---------------------------------------------------------------------------

export type TransferKind = "move" | "copy";

export interface FsTransferArgs {
  agent: string;
  source: string;
  destination: string;
  overwrite: boolean;
  kind: TransferKind;
}

/** PowerShell that copies or moves a file/directory, refusing silent overwrites. */
export function fsTransferScript(args: FsTransferArgs): string {
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

function transferTool(server: McpServer, hub: Hub, audit: AuditLog | null, kind: TransferKind): void {
  registerJobTool<FsTransferArgs>(server, hub, audit, {
    name: kind === "move" ? "agent_fs_move" : "agent_fs_copy",
    title: kind === "move" ? "Move a file or directory on a remote agent" : "Copy a file or directory on a remote agent",
    description:
      `${
        kind === "move"
          ? "Move (rename) a file or directory on a remote machine"
          : "Copy a file or directory on a remote machine (recursively, for directories)"
      }. ` +
      "Refuses to replace an existing destination unless overwrite=true, and works on the remote machine, so no bytes " +
      "travel through this server. When the destination is an existing directory the source is placed inside it " +
      "(standard Windows semantics). Returns the resolved destination and whether it existed before.",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      source: z.string().min(1).describe("Path to move or copy."),
      destination: z.string().min(1).describe("Target path."),
      overwrite: z.boolean().optional().describe("Replace the destination when it exists (default false)."),
    },
    options: {
      op: kind === "move" ? "agent_fs_move" : "agent_fs_copy",
      jobType: "exec",
      validate: (args) => windowsOnly(hub)(args) ?? guardMachineRoot(args.source) ?? guardMachineRoot(args.destination),
      timeoutMs: () => PS_DEFAULT_TIMEOUT_MS,
      buildParams: (args) =>
        psExecParams(
          fsTransferScript({
            agent: args.agent,
            source: args.source,
            destination: args.destination,
            overwrite: args.overwrite ?? false,
            kind,
          }),
        ),
      buildFailure: (outcome) => psFailure(outcome),
      buildResult: (outcome) => psEnvelopeData<{ source: string; destination: string; type: string; overwritten: boolean }>(outcome.stdout),
    },
  });
}

export function registerAgentFsMove(server: McpServer, hub: Hub, audit: AuditLog | null = null): void {
  transferTool(server, hub, audit, "move");
}

export function registerAgentFsCopy(server: McpServer, hub: Hub, audit: AuditLog | null = null): void {
  transferTool(server, hub, audit, "copy");
}

// ---------------------------------------------------------------------------
// agent_fs_delete
// ---------------------------------------------------------------------------

export interface FsDeleteArgs {
  agent: string;
  path: string;
  recursive: boolean;
  /** Tool-level guard: never reaches the script (see registerAgentFsDelete.validate). */
  confirm?: boolean;
}

/** PowerShell that deletes one path (directory only when empty or recursive). */
export function fsDeleteScript(args: FsDeleteArgs): string {
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

export function registerAgentFsDelete(server: McpServer, hub: Hub, audit: AuditLog | null = null): void {
  registerJobTool<FsDeleteArgs>(server, hub, audit, {
    name: "agent_fs_delete",
    title: "Delete a file or directory on a remote agent",
    description:
      "Delete a file, or a directory with recursive=true (an empty directory is removed either way; a non-empty one " +
      "is refused without recursive). There is no recycle bin: the deletion is permanent, so it needs confirm=true, " +
      "and drive roots are rejected. The path is used literally (no wildcards). Returns what was deleted.",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      path: z.string().min(1).describe("File or directory to delete (literal path, no wildcards)."),
      recursive: z.boolean().optional().describe("Delete directories with their contents (default false)."),
      confirm: z.boolean().optional().describe("Must be true: deletion is permanent."),
    },
    options: {
      op: "agent_fs_delete",
      jobType: "exec",
      validate: (args) => {
        if (args.confirm !== true) return `refusing to delete '${args.path}' without confirm=true`;
        return windowsOnly(hub)(args) ?? guardMachineRoot(args.path);
      },
      timeoutMs: () => PS_DEFAULT_TIMEOUT_MS,
      buildParams: (args) =>
        psExecParams(
          fsDeleteScript({ agent: args.agent, path: args.path, recursive: args.recursive ?? false }),
        ),
      buildFailure: (outcome) => psFailure(outcome),
      buildResult: (outcome) => psEnvelopeData<{ path: string; type: string; deleted: boolean }>(outcome.stdout),
    },
  });
}
