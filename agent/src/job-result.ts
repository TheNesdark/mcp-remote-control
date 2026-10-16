/**
 * Shared shape for "short" job handlers (fs.*, info, ps.*, screenshot):
 * they produce zero or more output chunks plus structured metadata.
 */
export interface JobOutputChunk {
  stream: "stdout" | "stderr";
  data: string;
  encoding: "utf8" | "base64";
}

export interface ShortJobResult {
  outputs?: JobOutputChunk[];
  meta: Record<string, unknown>;
}
