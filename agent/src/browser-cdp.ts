/**
 * CDP-based control of the user's LIVE browser (their real profile and tabs).
 *
 * Chrome 136+ does not open a remote-debugging port on the default profile
 * unless the user enables it at chrome://inspect/#remote-debugging ("Allow
 * remote debugging"), which makes Chrome write a DevToolsActivePort file into
 * the profile directory. Newer Chrome also REMOVES the HTTP /json/* endpoints
 * (they answer 404): the only way in is the browser WebSocket at
 *   ws://127.0.0.1:<port>/devtools/browser/<token>
 * with the token from the second line of DevToolsActivePort. Tabs are then
 * enumerated/created/attached through the Target domain (flatten sessions),
 * and page commands ride those sessions. First attach to a tab triggers
 * Chrome's per-tab "Allow debugging?" prompt; the response only resolves once
 * the user accepts, which is why attach has a generous timeout.
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
  canAccessOpener?: boolean;
}

let nextId = 1;

/** Minimal CDP connection: one WebSocket, id-matched responses, sessionId routing. */
class Cdp {
  private readonly ws: WebSocket;
  private readonly waiters = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
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
  }

  static async connect(endpoint: Endpoint, timeoutMs = 10_000): Promise<Cdp> {
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
// target helpers (browser-level Target domain)
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

/** Attach (flatten) to the picked tab; enables Page+Runtime. Closes cdp on throw. */
async function attach(p: BrowserParams, ep: Endpoint, mustExist = true): Promise<Attached> {
  const cdp = await Cdp.connect(ep);
  try {
    const pages = await pageTargets(cdp);
    const target = mustExist ? pickPage(pages, p.target_id) : pages[0]!;
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true }, undefined, 90_000);
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    return { cdp, sessionId, target };
  } catch (e) {
    cdp.close();
    throw e;
  }
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
  const a = await attach(p, ep);
  try {
    const snap = await evaluate(a, `JSON.stringify({url:location.href,page_title:document.title,ready:document.readyState,text_head:((document.body&&document.body.innerText)||'').slice(0,600)})`);
    return { browser: ep.browserName, target_id: a.target.targetId, ...JSON.parse(String(snap)) };
  } finally {
    a.cdp.close();
  }
}

async function opTabs(p: BrowserParams): Promise<Record<string, unknown>> {
  const ep = requireEndpoint(p);
  const cdp = await Cdp.connect(ep);
  try {
    const pages = await pageTargets(cdp);
    return {
      browser: ep.browserName,
      tab_count: pages.length,
      tabs: pages.map((t) => ({ target_id: t.targetId, title: t.title, url: t.url, attached: t.attached === true })),
    };
  } finally {
    cdp.close();
  }
}

async function opOpen(p: BrowserParams): Promise<Record<string, unknown>> {
  const ep = requireEndpoint(p);
  const cdp = await Cdp.connect(ep);
  try {
    const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: p.url! }, undefined, 30_000);
    // Attaching forces the first "Allow debugging?" prompt; if the user does
    // not answer within 20s report that the tab exists but is not driven yet.
    let firstAccess = true;
    try {
      await cdp.send("Target.attachToTarget", { targetId, flatten: true }, undefined, 20_000);
      firstAccess = false;
    } catch {
      // prompt still open
    }
    return {
      browser: ep.browserName,
      target_id: targetId,
      url: p.url,
      first_access_prompt: firstAccess,
      hint: firstAccess ? "Chrome is asking 'Allow debugging?' on the new tab; accept it, then call again" : undefined,
    };
  } finally {
    cdp.close();
  }
}

async function opNavigate(p: BrowserParams): Promise<Record<string, unknown>> {
  const ep = requireEndpoint(p);
  const a = await attach(p, ep);
  try {
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
  } finally {
    a.cdp.close();
  }
}

async function opText(p: BrowserParams): Promise<Record<string, unknown>> {
  const ep = requireEndpoint(p);
  const a = await attach(p, ep);
  try {
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
  } finally {
    a.cdp.close();
  }
}

async function opClick(p: BrowserParams): Promise<Record<string, unknown>> {
  const ep = requireEndpoint(p);
  const a = await attach(p, ep);
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
    const res = JSON.parse(String(await evaluate(a, expr))) as Record<string, unknown>;
    if (res.error) throw new Error(String(res.error));
    return { browser: ep.browserName, target_id: a.target.targetId, ...res };
  } finally {
    a.cdp.close();
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

/** Test seam: the pure discovery helper. */
export const __test = { discoverEndpoint };
