/**
 * Delivers stored screenshots over the MCP HTTP face so a client on another
 * machine can pull the file onto its own disk:
 *
 *   curl -H "Authorization: Bearer <MRC_TOKEN>" \
 *        http://<server>:8788/screenshots/<file> -o shot.png
 *
 * Auth accepts the bearer header or `?token=` (convenient from a browser /
 * one-off curl). Only files sitting directly inside the screenshot directory
 * are served; separators and `..` are rejected.
 */
import { extname, join, resolve, sep } from "node:path";
import { sameSecret } from "@mrc/shared/secret";

export const SCREENSHOT_HTTP_PREFIX = "/screenshots/";

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function authorized(req: Request, url: URL, token: string): boolean {
  const header = req.headers.get("authorization") ?? "";
  if (header.startsWith("Bearer ") && sameSecret(header.slice("Bearer ".length), token)) return true;
  const query = url.searchParams.get("token");
  return query !== null && sameSecret(query, token);
}

export async function handleScreenshotRequest(req: Request, dir: string, token: string): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const url = new URL(req.url);
  if (!authorized(req, url, token)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let name: string;
  try {
    name = decodeURIComponent(url.pathname.slice(SCREENSHOT_HTTP_PREFIX.length));
  } catch {
    return new Response("bad request", { status: 400 });
  }
  if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) {
    return new Response("bad request", { status: 400 });
  }

  const root = resolve(dir);
  const full = resolve(join(root, name));
  if (!full.startsWith(root + sep)) {
    return new Response("bad request", { status: 400 });
  }

  const file = Bun.file(full);
  if (!(await file.exists())) return new Response("not found", { status: 404 });

  const contentType = CONTENT_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";
  return new Response(req.method === "HEAD" ? null : file, {
    headers: {
      "content-type": contentType,
      "content-length": String(file.size),
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "no-store",
    },
  });
}
