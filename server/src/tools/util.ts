import { HubError } from "../hub.ts";

export interface ToolTextResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

export function toolJson(payload: unknown, isError = false): ToolTextResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

export function toolError(err: unknown): ToolTextResult {
  const text = err instanceof HubError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text }], isError: true };
}
