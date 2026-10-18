/**
 * CDP-based control of the user's LIVE browser (their real profile and tabs).
 *
 * Chrome 136+ does not open a remote-debugging port on the default profile
 * unless the user enables it at chrome://inspect/#remote-debugging ("Allow
 * remote debugging"), which makes Chrome write a DevToolsActivePort file into
 * the profile directory. We connect to that WebSocket directly (Bun has a
 * native WebSocket; no puppeteer, no CDP library). First access to a tab
 * triggers Chrome's per-tab "Allow debugging?" prompt; the connection stays
 * open while the page session lives, so it fires once.
 *
 * Operations (job type "browser"): state | open | navigate | text | tabs |
 * click. `match`-based click resolves the substring against anchor/button
 * text with Runtime.evaluate and clicks the element in-page.
 *
 * Firefox (no DevToolsActivePort file) is not supported; use Edge/Chrome.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserParams } from "@mrc/shared";
import type { ShortJobResult } from "./job-result.ts";

const HTTP_TIMEOUT_MS = 8_000;

interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

interface PageSession {
  ws: WebSocket;
  /** true once Page/Runtime domains are enabled and the first evaluate works. */
  ready: boolean;
}

let nextId = 1;

function pending(ws: WebSocket, id: number, method: string, ms: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMsg);
      reject(new Error(`CDP ${method} timed out after ${ms}ms`));
    }, ms);
    function onMsg(ev: MessageEvent) {
      let msg: any;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMsg);
      if (msg.error) reject(new Error(`CDP ${method}: ${msg.error.message ?? JSON.stringify(msg.error)}`));
      else resolve(msg.result);
    }
    ws.addEventListener("message", onMsg);
  });
}

async function cdpSend(ws: WebSocket, method: string, params: Record<string, unknown> = {}, ms = 20_000): Promise<any> {
  const id = nextId++;
  const waiter = pending(ws, id, method, ms);
  ws.send(JSON.stringify({ id, method, params }));
  return waiter;
}

async function httpGetJson(url: string, ms = HTTP_TIMEOUT_MS): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// endpoint discovery
// ---------------------------------------------------------------------------

interface Endpoint {
  browserName: "chrome" | "msedge";
  userDataDir: string;
  port: number;
}

/** Scans installed browsers' default user-data-dirs for a DevToolsActivePort. */
function discoverEndpoint(preferred?: "chrome" | "msedge"): Endpoint | null {
  const order: Array<"chrome" | "msedge"> = preferred ? [preferred] : ["chrome", "msedge"];
  const local = process.env.LOCALAPPDATA;
  if (!local) return null;
  for (const b of order) {
    const profileRoot = join(local, b === "chrome" ? "Google\\Chrome\\User Data" : "Microsoft\\Edge\\User Data");
    const files = [
      join(profileRoot, "DevToolsActivePort"),
      join(profileRoot, "Default", "DevToolsActivePort"),
    ];
    for (const f of files) {
      if (!existsSync(f)) continue;
      try {
        const first = readFileSync(f, "utf8").split(/\r?\n/)[0]?.trim();
        const port = Number(first);
        if (Number.isInteger(port) && port > 0 && port < 65536) {
          return { browserName: b, userDataDir: profileRoot, port };
        }
      } catch {
        // unreadable => not usable
      }
    }
  }
  return null;
}

async function listTargets(port: number): Promise<CdpTarget[]> {
  return (await httpGetJson(`http://127.0.0.1:${port}/json/list`)).targets;
}

async function openSession(wsUrl: string): Promise<PageSession> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("CDP handshake timed out (is the 'Allow debugging?' prompt still open?)")), 15_000);
    ws.addEventListener("open", () => {
      clearTimeout(t);
      resolve();
    });
    ws.addEventListener("error", () => {
      clearTimeout(t);
      reject(new Error("CDP WebSocket connect failed (Chrome may be waiting for the 'Allow debugging?' prompt on that tab)"));
    });
  });
  try {
    await cdpSend(ws, "Page.enable", {}, 15_000);
    await cdpSend(ws, "Runtime.enable", {}, 15_000);
  } catch (e) {
    try {
      ws.close();
    } catch {
      // ignore
    }
    throw e;
  }
  return { ws, ready: true };
}

/** Picks the target: by explicit id, else the selected page, else last-focused. */
async function pickTarget(port: number, targetId?: string): Promise<CdpTarget> {
  const targets = await listTargets(port);
  const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (targetId) {
    const t = pages.find((p) => p.id === targetId || p.id.startsWith(targetId));
    if (!t) throw new Error(`no debuggable tab with id ${targetId} (see the tabs op)`);
    return t;
  }
  // /json/list has no "selected" flag; order matches MRU-ish. Prefer http(s)/file.
  const usable = pages.filter((t) => /^(https?|file|about|chrome|edge):/.test(t.url || ""));
  const t = usable[0] ?? pages[0];
  if (!t) throw new Error("the browser has no debuggable tabs open");
  return t;
}

async function attachSelected(port: number, targetId?: string): Promise<{ session: PageSession; target: CdpTarget }> {
  const target = await pickTarget(port, targetId);
  const session = await openSession(target.webSocketDebuggerUrl!);
  return { session, target };
}

// ---------------------------------------------------------------------------
// page helpers
// ---------------------------------------------------------------------------

async function evaluate(session: PageSession, expression: string, ms = 20_000): Promise<unknown> {
  const res = await cdpSend(session.ws, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, ms);
  if (res.exceptionDetails) {
    throw new Error(`page eval failed: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
  }
  return res.result?.value;
}

const PAGE_SNAPSHOT_JS = `(() => {
  const txt = (document.body && document.body.innerText) || "";
  return JSON.stringify({
    url: location.href,
    page_title: document.title,
    ready: document.readyState,
    text_head: txt.slice(0, 600),
    links: Array.from(document.querySelectorAll("a[href],button,[role=button]")).slice(0, 400).map(e => ({
      tag: e.tagName.toLowerCase(),
      text: (e.innerText || e.textContent || "").trim().slice(0, 80),
      href: e.tagName === "A" ? (e.getAttribute("href") || "") : "",
    })),
  });
})()`;

// ---------------------------------------------------------------------------
// operations
// ---------------------------------------------------------------------------

function requireEndpoint(p: BrowserParams): Endpoint {
  const ep = discoverEndpoint(p.browser);
  if (!ep) {
    throw new Error(
      "remote debugging is not enabled on the default profile: open chrome://inspect/#remote-debugging in the browser, turn 'Allow remote debugging' on, then retry",
    );
  }
  return ep;
}

function closeQuietly(ws: WebSocket) {
  try {
    ws.close();
  } catch {
    // ignore
  }
}

async function opState(p: BrowserParams): Promise<Record<string, unknown>> {
  const ep = requireEndpoint(p);
  const { session, target } = await attachSelected(ep.port, p.target_id);
  try {
    const snap = JSON.parse(String(await evaluate(session, PAGE_SNAPSHOT_JS))) as Record<string, unknown>;
    return { ...snap, browser: ep.browserName, target_id: target.id };
  } finally {
    closeQuietly(session.ws);
  }
}

async function opTabs(p: BrowserParams): Promise<Record<string, unknown>> {
  const ep = requireEndpoint(p);
  const targets = await listTargets(ep.port);
  const pages = targets.filter((t) => t.type === "page");
  return {
    browser: ep.browserName,
    tab_count: pages.length,
    tabs: pages.map((t) => ({ target_id: t.id, title: t.title, url: t.url })),
  };
}

async function openTab(ep: Endpoint, url: string): Promise<CdpTarget> {
  // Chrome's HTTP endpoint takes the URL raw after the "?". Newer Chrome
  // rejects GET with 405 and requires PUT.
  const endpoint = `http://127.0.0.1:${ep.port}/json/new?${url}`;
  let res = await fetch(endpoint, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) }).catch(() => undefined);
  if (!res || res.status === 405) {
    res = await fetch(endpoint, { method: "PUT", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  }
  if (!res.ok) throw new Error(`cannot open a new tab: HTTP ${res.status}`);
  return (await res.json()) as CdpTarget;
}

async function opOpen(p: BrowserParams): Promise<Record<string, unknown>> {
  const ep = requireEndpoint(p);
  const target = await openTab(ep, p.url!);
  const first = await new Promise<boolean>((resolve) => {
    // Poll until the first "Allow debugging?" is answered (or 25s), then try once.
    const t0 = Date.now();
    const tryConnect = async () => {
      try {
        const s = await openSession(target.webSocketDebuggerUrl!);
        closeQuietly(s.ws);
        resolve(true);
      } catch {
        if (Date.now() - t0 > 25_000) resolve(false);
        else setTimeout(tryConnect, 1_000);
      }
    };
    void tryConnect();
  });
  return {
    browser: ep.browserName,
    target_id: target.id,
    url: target.url,
    first_access_prompt: !first,
    hint: first ? undefined : "Chrome is asking 'Allow debugging?' on the new tab; accept it, then call again",
  };
}

async function opNavigate(p: BrowserParams): Promise<Record<string, unknown>> {
  const ep = requireEndpoint(p);
  const { session, target } = await attachSelected(ep.port, p.target_id);
  try {
    const res = await cdpSend(session.ws, "Page.navigate", { url: p.url! }, 30_000);
    if (res.errorText) throw new Error(`navigate failed: ${res.errorText}`);
    // Wait for the document to swap over.
    let url = p.url!;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const cur = (await evaluate(session, "location.href")) as string;
      if (cur && cur !== "about:blank" && (i > 2 || cur.startsWith("file://") || /^https?:\/\//i.test(cur))) {
        url = cur;
        break;
      }
    }
    return { browser: ep.browserName, target_id: target.id, navigated: true, url };
  } finally {
    closeQuietly(session.ws);
  }
}

async function opText(p: BrowserParams): Promise<Record<string, unknown>> {
  const ep = requireEndpoint(p);
  const { session, target } = await attachSelected(ep.port, p.target_id);
  try {
    const max = p.max_chars ?? 8_000;
    const full = String(await evaluate(session, `(() => { const t=(document.body&&document.body.innerText)||''; return JSON.stringify({url:location.href,title:document.title,text:t}); })()`));
    const parsed = JSON.parse(full) as { url: string; title: string; text: string };
    return {
      browser: ep.browserName,
      target_id: target.id,
      url: parsed.url,
      title: parsed.title,
      text: parsed.text.slice(0, max),
      truncated: parsed.text.length > max,
    };
  } finally {
    closeQuietly(session.ws);
  }
}

async function opClick(p: BrowserParams): Promise<Record<string, unknown>> {
  const ep = requireEndpoint(p);
  const { session, target } = await attachSelected(ep.port, p.target_id);
  try {
    const match = JSON.stringify(p.match!);
    const nth = p.nth ?? 0;
    const expr = `(() => {
      const match = ${match}.toLowerCase();
      const els = Array.from(document.querySelectorAll("a,button,[role=button],[onclick],input[type=button],input[type=submit],summary,label"));
      const norm = (s) => (s || "").replace(/\\s+/g, " ").trim();
      const hits = els.filter(e => !e.disabled && (norm(e.innerText || e.textContent).toLowerCase().includes(match) || norm(e.getAttribute("aria-label")).toLowerCase().includes(match) || norm(e.getAttribute("title")).toLowerCase().includes(match)));
      if (hits.length === 0) return JSON.stringify({ error: "no enabled link or button contains " + JSON.stringify(match), total: els.length });
      const el = hits[${nth}];
      if (!el) return JSON.stringify({ error: "nth ${nth} out of range (" + hits.length + " matches)" });
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      el.click();
      return JSON.stringify({ clicked: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) }, tag: el.tagName.toLowerCase(), text: norm(el.innerText || el.textContent).slice(0, 100), matches: hits.length, via: "dom" });
    })()`;
    const res = JSON.parse(String(await evaluate(session, expr))) as Record<string, unknown>;
    if (res.error) throw new Error(String(res.error));
    return { browser: ep.browserName, target_id: target.id, ...res };
  } finally {
    closeQuietly(session.ws);
  }
}

// ---------------------------------------------------------------------------
// job entry point
// ---------------------------------------------------------------------------

export async function runBrowserCall(params: BrowserParams): Promise<ShortJobResult> {
  const out = await (async () => {
    switch (params.operation) {
      case "state":
        return opState(params);
      case "tabs":
        return opTabs(params);
      case "open":
        if (!params.url) throw new Error("open requires 'url'");
        return opOpen(params);
      case "navigate":
        if (!params.url) throw new Error("navigate requires 'url'");
        return opNavigate(params);
      case "text":
        return opText(params);
      case "click":
        if (!params.match) throw new Error("click requires 'match'");
        return opClick(params);
      default:
        throw new Error(`unknown browser operation: ${String(params.operation)}`);
    }
  })();
  return { meta: { ok: true, ...out } };
}

/** Test seam: export the pure discovery + op map (used by unit tests). */
export const __test = { discoverEndpoint, operations: { state: opState, tabs: opTabs } };
