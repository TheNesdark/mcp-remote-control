/**
 * CDP-based control of the user's LIVE browser (their real profile and tabs).
 *
 * Chrome 136+ opens a remote-debugging port on the DEFAULT profile only after
 * the user enables chrome://inspect/#remote-debugging ("Allow remote
 * debugging"), which writes a DevToolsActivePort file into the profile
 * directory. Newer Chrome also REMOVES the HTTP /json/* endpoints (they
 * answer 404): the sole way in is the browser WebSocket at
 *   ws://127.0.0.1:<port>/devtools/browser/<token>
 * with the token from line 2 of DevToolsActivePort. Tabs are enumerated and
 * created through the Target domain; page commands ride attached sessions.
 *
 * CONSENT MODEL (why this file pools): the "Allow debugging?" consent belongs
 * to the live debug session, NOT to the tab. Reconnecting per command would
 * re-prompt the user on every call. So the agent keeps ONE browser
 * connection and leaves tab sessions attached; the user accepts once per tab
 * and later commands ride the existing session silently. The pool is rebuilt
 * when Chrome restarts (token changes) or after the idle timeout, and
 * discarded whenever the connection dies; a stale tab session is dropped and
 * re-attached once (the only case that can re-prompt).
 *
 * Bun has a native WebSocket: no puppeteer, no CDP library.
 *
 * Operations (job type "browser"): state | open | navigate | text | tabs |
 * click. `match`-based click resolves the substring against anchor/button
 * text with Runtime.evaluate and clicks the element in-page.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserParams } from "@mrc/shared";
import type { ShortJobResult } from "./job-result.ts";

interface Endpoint {
  browserName: "chrome" | "msedge";
  userDataDir: string;
  port: number;
  token: string;
}

interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached?: boolean;
}

let nextId = 1;

/** One CDP WebSocket: id-matched responses; rejects pending calls when it dies. */
class Cdp {
  readonly ws: WebSocket;
  closed = false;
  private readonly waiters = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    const die = () => {
      this.closed = true;
      for (const w of this.waiters.values()) w.reject(new Error("CDP connection closed"));
      this.waiters.clear();
    };
    ws.addEventListener("message", (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }
      if (typeof msg.id !== "number") return;
      const w = this.waiters.get(msg.id);
      if (!w) return;
      this.waiters.delete(msg.id);
      if (msg.error) w.reject(new Error(`${msg.error.message ?? JSON.stringify(msg.error)}`));
      else w.resolve(msg.result);
    });
    ws.addEventListener("close", die);
    ws.addEventListener("error", die);
  }

  static async connect(endpoint: Endpoint, timeoutMs = 15_000): Promise<Cdp> {
    const ws = new WebSocket(`ws://127.0.0.1:${endpoint.port}/devtools/browser/${endpoint.token}`);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("CDP browser WebSocket handshake timed out")), timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(t);
        resolve();
      });
      ws.addEventListener("error", () => {
        clearTimeout(t);
        reject(new Error("CDP browser WebSocket connect failed (remote debugging turned off since?)"));
      });
    });
    return new Cdp(ws);
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string, ms = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error("CDP connection closed"));
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`CDP ${method} timed out after ${ms}ms${sessionId ? " (a pending 'Allow debugging?' prompt blocks this tab)" : ""}`));
      }, ms);
      this.waiters.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(new Error(`CDP ${method}: ${e.message}`));
        },
      });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close() {
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// endpoint discovery
// ---------------------------------------------------------------------------

/** Reads DevToolsActivePort from Chrome/Edge default user-data-dirs. */
function discoverEndpoint(preferred?: "chrome" | "msedge"): Endpoint | null {
  const local = process.env.LOCALAPPDATA;
  if (!local) return null;
  const order: Array<"chrome" | "msedge"> = preferred ? [preferred] : ["chrome", "msedge"];
  for (const b of order) {
    const userDataDir = join(local, b === "chrome" ? "Google\\Chrome\\User Data" : "Microsoft\\Edge\\User Data");
    const file = join(userDataDir, "DevToolsActivePort");
    if (!existsSync(file)) continue;
    try {
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      const port = Number(lines[0]?.trim());
      const token = (lines[1] ?? "").trim();
      if (Number.isInteger(port) && port > 0 && port < 65536 && token.length > 0) {
        return { browserName: b, userDataDir, port, token };
      }
    } catch {
      // unreadable => not usable
    }
  }
  return null;
}

function requireEndpoint(p: BrowserParams): Endpoint {
  const ep = discoverEndpoint(p.browser);
  if (!ep) {
    throw new Error(
      "remote debugging is not enabled on the default profile: open chrome://inspect/#remote-debugging in the browser, turn 'Allow remote debugging' on, then retry",
    );
  }
  return ep;
}

// ---------------------------------------------------------------------------
// pooled browser connection (keeps tab sessions => keeps consent)
// ---------------------------------------------------------------------------

const IDLE_DISPOSE_MS = 30 * 60_000;

interface Pool {
  ep: Endpoint;
  cdp: Cdp;
  /** targetId -> flattened session id */
  sessions: Map<string, string>;
  lastUsed: number;
}

let pool: Pool | null = null;

function disposePool(p: Pool | null) {
  if (!p) return;
  p.sessions.clear();
  p.cdp.close();
  if (pool === p) pool = null;
}

async function getPool(ep: Endpoint): Promise<Pool> {
  if (pool) {
    const sameToken = pool.ep.token === ep.token && pool.ep.port === ep.port && pool.ep.browserName === ep.browserName;
    if (sameToken && !pool.cdp.closed && Date.now() - pool.lastUsed < IDLE_DISPOSE_MS) {
      pool.lastUsed = Date.now();
      return pool;
    }
    disposePool(pool);
  }
  const cdp = await Cdp.connect(ep);
  pool = { ep, cdp, sessions: new Map(), lastUsed: Date.now() };
  return pool;
}

// ---------------------------------------------------------------------------
// session helpers
// ---------------------------------------------------------------------------

async function pageTargets(cdp: Cdp): Promise<TargetInfo[]> {
  const res = await cdp.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
  return res.targetInfos.filter((t) => t.type === "page");
}

function pickPage(pages: TargetInfo[], targetIdPrefix?: string): TargetInfo {
  if (targetIdPrefix) {
    const t = pages.find((p) => p.targetId.startsWith(targetIdPrefix));
    if (!t) throw new Error(`no page tab with target id ${targetIdPrefix} (see the tabs op)`);
    return t;
  }
  const usable = pages.filter((t) => /^(https?|file|about|chrome|edge|devtools):/.test(t.url || ""));
  const t = usable[0] ?? pages[0];
  if (!t) throw new Error("the browser has no open tabs");
  return t;
}

interface Attached {
  cdp: Cdp;
  sessionId: string;
  target: TargetInfo;
}

/** Attach to the picked tab, reusing the pooled session when alive. */
async function attachToTab(p: BrowserParams, ep: Endpoint): Promise<Attached> {
  const active = await getPool(ep);
  const pages = await pageTargets(active.cdp);
  const target = pickPage(pages, p.target_id);
  let sessionId = active.sessions.get(target.targetId);
  if (!sessionId) {
    // First attach to this tab: Chrome asks "Allow debugging?"; the response
    // only resolves once the user accepts, hence the long budget.
    const res = await active.cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true }, undefined, 120_000);
    sessionId = res.sessionId;
    await active.cdp.send("Page.enable", {}, sessionId);
    await active.cdp.send("Runtime.enable", {}, sessionId);
    active.sessions.set(target.targetId, sessionId);
  }
  return { cdp: active.cdp, sessionId, target };
}

const SESSION_STALE = /no session|session with given id|cannot find context|target closed|detached|no target with id/i;
const CONNECTION_DEAD = /connection closed|closed unexpectedly|ready state/i;

/** Run fn with the tab attached, healing stale sessions and dead connections. */
async function withTab<T>(p: BrowserParams, fn: (a: Attached) => Promise<T>): Promise<T> {
  const ep = requireEndpoint(p);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    let active: Pool;
    try {
      active = await getPool(ep);
    } catch (e) {
      lastErr = e;
      continue;
    }
    try {
      const a = await attachToTab(p, ep);
      return await fn(a);
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (CONNECTION_DEAD.test(msg) || active.cdp.closed) {
        disposePool(active);
        continue;
      }
      if (SESSION_STALE.test(msg)) {
        active.sessions.clear();
        continue;
      }
      throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function evaluate(a: Attached, expression: string, ms = 30_000): Promise<unknown> {
  const res = await a.cdp.send<any>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, a.sessionId, ms);
  if (res.exceptionDetails) {
    throw new Error(`page eval failed: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
  }
  return res.result?.value;
}

// ---------------------------------------------------------------------------
// operations
// ---------------------------------------------------------------------------

async function opState(p: BrowserParams): Promise<Record<string, unknown>> {
  const ep = requireEndpoint(p);
  return withTab(p, async (a) => {
    const snap = await evaluate(a, "JSON.stringify({url:location.href,page_title:document.title,ready:document.readyState,text_head:((document.body&&document.body.innerText)||'').slice(0,600)})");
    return { browser: ep.browserName, target_id: a.target.targetId, ...JSON.parse(String(snap)) };
  });
}

async function opTabs(p: BrowserParams): Promise<Record<string, unknown>> {
  const ep = requireEndpoint(p);
  const active = await getPool(ep);
  try {
    const pages = await pageTargets(active.cdp);
    return {
      browser: ep.browserName,
      tab_count: pages.length,
      tabs: pages.map((t) => ({ target_id: t.targetId, title: t.title, url: t.url, attached: t.attached === true })),
    };
  } catch (e) {
    if (active.cdp.closed) disposePool(active);
    throw e;
  }
}

async function opOpen(p: BrowserParams): Promise<Record<string, unknown>> {
  const ep = requireEndpoint(p);
  // No withTab: creating a tab must not attach to (or prompt on) the CURRENT
  // one; the attach below happens on the brand-new target instead.
  const run = async (): Promise<Record<string, unknown>> => {
    const active = await getPool(ep);
    const { targetId } = await active.cdp.send<{ targetId: string }>("Target.createTarget", { url: p.url! }, undefined, 30_000);
    // Attach now so the consent prompt fires while the user watches this call
    // (20 s budget); later ops ride the session without prompting.
    let firstAccess = true;
    try {
      const res = await active.cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }, undefined, 20_000);
      await active.cdp.send("Page.enable", {}, res.sessionId);
      await active.cdp.send("Runtime.enable", {}, res.sessionId);
      active.sessions.set(targetId, res.sessionId);
      firstAccess = false;
    } catch {
      // prompt still open: the tab exists, next call will complete the attach
    }
    return {
      browser: ep.browserName,
      target_id: targetId,
      url: p.url,
      first_access_prompt: firstAccess,
      hint: firstAccess ? "Chrome is asking 'Allow debugging?' on the new tab; accept it, then call again" : undefined,
    };
  };
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await run();
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (CONNECTION_DEAD.test(msg) || SESSION_STALE.test(msg)) disposePool(pool);
      else throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function opNavigate(p: BrowserParams): Promise<Record<string, unknown>> {
  const ep = requireEndpoint(p);
  return withTab(p, async (a) => {
    const res = await a.cdp.send<{ errorText?: string }>("Page.navigate", { url: p.url! }, a.sessionId, 30_000);
    if (res.errorText) throw new Error(`navigate failed: ${res.errorText}`);
    let url = p.url!;
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const cur = String((await evaluate(a, "location.href")) ?? "");
      if (cur && cur !== "about:blank") {
        url = cur;
        if (/^https?:/i.test(cur) && i > 1) break;
      }
    }
    return { browser: ep.browserName, target_id: a.target.targetId, navigated: true, url };
  });
}

async function opText(p: BrowserParams): Promise<Record<string, unknown>> {
  const ep = requireEndpoint(p);
  return withTab(p, async (a) => {
    const max = p.max_chars ?? 8_000;
    const parsed = JSON.parse(
      String(await evaluate(a, "JSON.stringify({url:location.href,title:document.title,text:((document.body&&document.body.innerText)||'')})")),
    ) as { url: string; title: string; text: string };
    return {
      browser: ep.browserName,
      target_id: a.target.targetId,
      url: parsed.url,
      title: parsed.title,
      text: parsed.text.slice(0, max),
      truncated: parsed.text.length > max,
    };
  });
}

async function opClick(p: BrowserParams): Promise<Record<string, unknown>> {
  const ep = requireEndpoint(p);
  return withTab(p, async (a) => {
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
    const res = JSON.parse(String(await evaluate(a, expr))) as Record<string, unknown>;
    if (res.error) throw new Error(String(res.error));
    return { browser: ep.browserName, target_id: a.target.targetId, ...res };
  });
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

/** Test seam: discovery + pool introspection. */
export const __test = { discoverEndpoint, poolInfo: () => (pool ? { token: pool.ep.token, sessions: pool.sessions.size } : null), disposePool };
