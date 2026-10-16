import { HubError } from "../hub-error.ts";

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolTextResult {
  content: ToolContent[];
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
