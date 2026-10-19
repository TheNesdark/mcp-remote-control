using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace Mrc.Agent;

/// <summary>
/// browser: drives the user's LIVE Chrome/Edge over CDP.
///
/// Chrome 136+ only opens a remote-debugging port on the default profile after
/// the user enables chrome://inspect/#remote-debugging, which writes
/// DevToolsActivePort (line 0 port, line 1 token). The HTTP /json/* endpoints
/// are gone in newer builds, so everything goes through the browser WebSocket
/// ws://127.0.0.1:port/devtools/browser/token using the Target domain.
///
/// The consent ("Allow debugging?") belongs to the debug session, not the tab,
/// so one pooled connection with flattened tab sessions is kept: the user
/// accepts once per tab and later commands are silent. The pool rebuilds when
/// the token changes (browser restart), on a dead socket, after idling or when
/// a session goes stale.
/// </summary>
public static class BrowserCdp
{
    private const int IdleDisposeMs = 30 * 60_000;
    private static readonly object Gate = new();
    private static Pool? _pool;

    private sealed class Pool
    {
        public required Endpoint Endpoint { get; init; }
        public required CdpClient Client { get; init; }
        public Dictionary<string, string> Sessions { get; } = new(StringComparer.Ordinal);
        public long LastUsed { get; set; }
    }

    private sealed record Endpoint(string BrowserName, string UserDataDir, int Port, string Token);

    // ---------------------------------------------------------------- endpoint

    private static Endpoint? DiscoverEndpoint(string? preferred)
    {
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrEmpty(local)) return null;
        var order = preferred is not null
            ? new[] { preferred }
            : new[] { "chrome", "msedge" };
        foreach (var browser in order)
        {
            var userDataDir = Path.Combine(local, browser == "chrome"
                ? Path.Combine("Google", "Chrome", "User Data")
                : Path.Combine("Microsoft", "Edge", "User Data"));
            var file = Path.Combine(userDataDir, "DevToolsActivePort");
            if (!File.Exists(file)) continue;
            try
            {
                var lines = File.ReadAllLines(file);
                if (lines.Length < 2) continue;
                if (!int.TryParse(lines[0].Trim(), out var port) || port <= 0 || port > 65535) continue;
                var token = lines[1].Trim();
                if (token.Length == 0) continue;
                return new Endpoint(browser, userDataDir, port, token);
            }
            catch (IOException)
            {
                // unreadable => not usable
            }
        }
        return null;
    }

    private static Endpoint Require(string? preferred) =>
        DiscoverEndpoint(preferred) ?? throw new InvalidOperationException(
            "remote debugging is not enabled on the default profile: open chrome://inspect/#remote-debugging in the browser, turn 'Allow remote debugging' on, then retry");

    // ------------------------------------------------------------------- pool

    private static async Task<Pool> GetPoolAsync(Endpoint endpoint, CancellationToken ct)
    {
        Pool? reusable;
        lock (Gate)
        {
            reusable = _pool;
            if (reusable is not null)
            {
                var same = reusable.Endpoint.Token == endpoint.Token
                           && reusable.Endpoint.Port == endpoint.Port
                           && reusable.Endpoint.BrowserName == endpoint.BrowserName;
                if (!same || reusable.Client.Closed || Environment.TickCount64 - reusable.LastUsed >= IdleDisposeMs)
                {
                    reusable.Client.Dispose();
                    _pool = null;
                    reusable = null;
                }
            }
        }
        if (reusable is not null)
        {
            reusable.LastUsed = Environment.TickCount64;
            return reusable;
        }

        var client = await CdpClient.ConnectAsync(new BrowserCdpEndpointLike { Port = endpoint.Port, Token = endpoint.Token }, ct).ConfigureAwait(false);
        var pool = new Pool { Endpoint = endpoint, Client = client, LastUsed = Environment.TickCount64 };
        lock (Gate) _pool = pool;
        return pool;
    }

    private static void DropPool(Pool pool)
    {
        lock (Gate)
        {
            if (!ReferenceEquals(_pool, pool)) return;
            pool.Client.Dispose();
            _pool = null;
        }
    }

    // -------------------------------------------------------------------- job

    public static async Task<JobOutcome> JobCall(JsonElement p, JobContext ctx, CancellationToken ct)
    {
        var operation = Fs.ReadString(p, "operation");
        var preferred = Fs.ReadString(p, "browser");
        if (operation is null) return JobOutcome.Failure("invalid browser params: operation: Required");
        try
        {
            var meta = operation switch
            {
                "state" => await StateAsync(p, preferred, ct).ConfigureAwait(false),
                "tabs" => await TabsAsync(preferred, ct).ConfigureAwait(false),
                "open" => await OpenAsync(p, preferred, ct).ConfigureAwait(false),
                "navigate" => await NavigateAsync(p, preferred, ct).ConfigureAwait(false),
                "text" => await TextAsync(p, preferred, ct).ConfigureAwait(false),
                "click" => await ClickAsync(p, preferred, ct).ConfigureAwait(false),
                _ => throw new InvalidOperationException($"unknown browser operation: {operation}"),
            };
            return JobOutcome.Success(meta);
        }
        catch (InvalidOperationException ex)
        {
            return JobOutcome.Failure(ex.Message);
        }
    }

    /// <summary>Attaches to the picked tab, healing stale sessions and dead pools (3 tries).</summary>
    private static async Task<T> WithTabAsync<T>(JsonElement p, string? preferred, Func<Attached, Task<T>> fn, CancellationToken ct)
    {
        var endpoint = Require(preferred);
        Exception? last = null;
        for (var attempt = 0; attempt < 3; attempt++)
        {
            Pool pool;
            try
            {
                pool = await GetPoolAsync(endpoint, ct).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                last = ex;
                continue;
            }
            try
            {
                var attached = await AttachAsync(pool, p, ct).ConfigureAwait(false);
                return await fn(attached).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                last = ex;
                if (IsConnectionDead(ex.Message) || pool.Client.Closed)
                {
                    DropPool(pool);
                    continue;
                }
                if (IsSessionStale(ex.Message))
                {
                    pool.Sessions.Clear();
                    continue;
                }
                throw;
            }
        }
        throw last ?? new InvalidOperationException("browser operation failed");
    }

    private static bool IsConnectionDead(string message) =>
        message.Contains("connection closed", StringComparison.OrdinalIgnoreCase) ||
        message.Contains("closed unexpectedly", StringComparison.OrdinalIgnoreCase) ||
        message.Contains("ready state", StringComparison.OrdinalIgnoreCase);

    private static bool IsSessionStale(string message) =>
        message.Contains("no session", StringComparison.OrdinalIgnoreCase) ||
        message.Contains("session with given id", StringComparison.OrdinalIgnoreCase) ||
        message.Contains("cannot find context", StringComparison.OrdinalIgnoreCase) ||
        message.Contains("target closed", StringComparison.OrdinalIgnoreCase) ||
        message.Contains("detached", StringComparison.OrdinalIgnoreCase) ||
        message.Contains("no target with id", StringComparison.OrdinalIgnoreCase);

    private sealed record Attached(Pool Pool, string SessionId, string TargetId);

    private static async Task<Attached> AttachAsync(Pool pool, JsonElement p, CancellationToken ct)
    {
        var targetId = await PickTargetAsync(pool, Fs.ReadString(p, "target_id"), ct).ConfigureAwait(false);
        if (!pool.Sessions.TryGetValue(targetId, out var sessionId))
        {
            // First attach to this tab: Chrome shows "Allow debugging?" and the
            // response only lands once the user accepts (hence the long budget).
            var attached = await pool.Client.SendAsync("Target.attachToTarget",
                new { targetId, flatten = true }, sessionId: null, 120_000, ct).ConfigureAwait(false);
            sessionId = attached.GetProperty("sessionId").GetString() ?? throw new InvalidOperationException("attach returned no sessionId");
            await pool.Client.SendAsync("Page.enable", null, sessionId, 30_000, ct).ConfigureAwait(false);
            await pool.Client.SendAsync("Runtime.enable", null, sessionId, 30_000, ct).ConfigureAwait(false);
            pool.Sessions[targetId] = sessionId;
        }
        return new Attached(pool, sessionId, targetId);
    }

    private static async Task<string> PickTargetAsync(Pool pool, string? prefix, CancellationToken ct)
    {
        var pages = await PageTargetsAsync(pool.Client, ct).ConfigureAwait(false);
        if (prefix is not null)
        {
            var match = pages.FirstOrDefault(t => t.Id.StartsWith(prefix, StringComparison.Ordinal));
            if (match is null) throw new InvalidOperationException($"no page tab with target id {prefix} (see the tabs op)");
            return match.Id;
        }
        var usable = pages.FirstOrDefault(t => System.Text.RegularExpressions.Regex.IsMatch(t.Url ?? "", "^(https?|file|about|chrome|edge|devtools):"));
        var picked = usable ?? pages.FirstOrDefault();
        if (picked is null) throw new InvalidOperationException("the browser has no open tabs");
        return picked.Id;
    }

    private sealed record PageInfo(string Id, string? Title, string? Url, bool Attached);

    private static async Task<List<PageInfo>> PageTargetsAsync(CdpClient client, CancellationToken ct)
    {
        var result = await client.SendAsync("Target.getTargets", null, null, 30_000, ct).ConfigureAwait(false);
        var list = new List<PageInfo>();
        if (!result.TryGetProperty("targetInfos", out var infos) || infos.ValueKind != JsonValueKind.Array) return list;
        foreach (var info in infos.EnumerateArray())
        {
            if (info.TryGetProperty("type", out var type) && type.GetString() == "page")
            {
                list.Add(new PageInfo(
                    info.GetProperty("targetId").GetString() ?? "",
                    info.TryGetProperty("title", out var title) ? title.GetString() : null,
                    info.TryGetProperty("url", out var url) ? url.GetString() : null,
                    info.TryGetProperty("attached", out var attached) && attached.ValueKind == JsonValueKind.True));
            }
        }
        return list;
    }

    private static async Task<JsonElement> EvaluateAsync(Attached attached, string expression, CancellationToken ct)
    {
        var result = await attached.Pool.Client.SendAsync("Runtime.evaluate",
            new { expression, returnByValue = true, awaitPromise = true }, attached.SessionId, 30_000, ct).ConfigureAwait(false);
        if (result.TryGetProperty("exceptionDetails", out var exception))
        {
            var description = exception.TryGetProperty("exception", out var inner) && inner.TryGetProperty("description", out var desc)
                ? desc.GetString()
                : exception.TryGetProperty("text", out var text) ? text.GetString() : "page eval failed";
            throw new InvalidOperationException($"page eval failed: {description}");
        }
        return result.TryGetProperty("result", out var value) ? value : default;
    }

    private static async Task<string> EvalStringAsync(Attached attached, string expression, CancellationToken ct)
    {
        var value = await EvaluateAsync(attached, expression, ct).ConfigureAwait(false);
        return value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : value.ToString();
    }

    // -------------------------------------------------------------- operations

    private static async Task<Dictionary<string, object?>> StateAsync(JsonElement p, string? preferred, CancellationToken ct)
    {
        var endpoint = Require(preferred);
        return await WithTabAsync(p, preferred, async attached =>
        {
            const string expr = "JSON.stringify({url:location.href,page_title:document.title,ready:document.readyState,text_head:((document.body&&document.body.innerText)||'').slice(0,600)})";
            using var doc = JsonDocument.Parse(await EvalStringAsync(attached, expr, ct).ConfigureAwait(false));
            var root = doc.RootElement;
            return new Dictionary<string, object?>
            {
                ["browser"] = endpoint.BrowserName,
                ["target_id"] = attached.TargetId,
                ["url"] = root.GetProperty("url").GetString(),
                ["page_title"] = root.GetProperty("page_title").GetString(),
                ["ready"] = root.GetProperty("ready").GetString(),
                ["text_head"] = root.GetProperty("text_head").GetString(),
            };
        }, ct).ConfigureAwait(false);
    }

    private static async Task<Dictionary<string, object?>> TabsAsync(string? preferred, CancellationToken ct)
    {
        var endpoint = Require(preferred);
        var pool = await GetPoolAsync(endpoint, ct).ConfigureAwait(false);
        try
        {
            var pages = await PageTargetsAsync(pool.Client, ct).ConfigureAwait(false);
            var tabs = pages.Select(t => new Dictionary<string, object?>
            {
                ["target_id"] = t.Id,
                ["title"] = t.Title,
                ["url"] = t.Url,
                ["attached"] = t.Attached,
            }).ToList();
            return new Dictionary<string, object?>
            {
                ["browser"] = endpoint.BrowserName,
                ["tab_count"] = tabs.Count,
                ["tabs"] = tabs,
            };
        }
        catch (Exception)
        {
            if (pool.Client.Closed) DropPool(pool);
            throw;
        }
    }

    private static async Task<Dictionary<string, object?>> OpenAsync(JsonElement p, string? preferred, CancellationToken ct)
    {
        var url = Fs.ReadString(p, "url") ?? throw new InvalidOperationException("open requires 'url'");
        var endpoint = Require(preferred);
        var pool = await GetPoolAsync(endpoint, ct).ConfigureAwait(false);
        var created = await pool.Client.SendAsync("Target.createTarget", new { url }, null, 30_000, ct).ConfigureAwait(false);
        var targetId = created.GetProperty("targetId").GetString() ?? throw new InvalidOperationException("createTarget returned no targetId");

        var firstAccess = true;
        try
        {
            var attached = await pool.Client.SendAsync("Target.attachToTarget", new { targetId, flatten = true }, null, 20_000, ct).ConfigureAwait(false);
            var sessionId = attached.GetProperty("sessionId").GetString()!;
            await pool.Client.SendAsync("Page.enable", null, sessionId, 30_000, ct).ConfigureAwait(false);
            await pool.Client.SendAsync("Runtime.enable", null, sessionId, 30_000, ct).ConfigureAwait(false);
            pool.Sessions[targetId] = sessionId;
            firstAccess = false;
        }
        catch (Exception)
        {
            // The consent prompt is probably still open: the tab exists, the
            // next call completes the attach.
        }
        return new Dictionary<string, object?>
        {
            ["browser"] = endpoint.BrowserName,
            ["target_id"] = targetId,
            ["url"] = url,
            ["first_access_prompt"] = firstAccess,
            ["hint"] = firstAccess ? "Chrome is asking 'Allow debugging?' on the new tab; accept it, then call again" : null,
        };
    }

    private static async Task<Dictionary<string, object?>> NavigateAsync(JsonElement p, string? preferred, CancellationToken ct)
    {
        var url = Fs.ReadString(p, "url") ?? throw new InvalidOperationException("navigate requires 'url'");
        var endpoint = Require(preferred);
        return await WithTabAsync(p, preferred, async attached =>
        {
            var result = await attached.Pool.Client.SendAsync("Page.navigate", new { url }, attached.SessionId, 30_000, ct).ConfigureAwait(false);
            if (result.TryGetProperty("errorText", out var error) && error.ValueKind == JsonValueKind.String)
                throw new InvalidOperationException($"navigate failed: {error.GetString()}");

            var current = url;
            for (var i = 0; i < 24; i++)
            {
                await Task.Delay(500, ct).ConfigureAwait(false);
                var href = await EvalStringAsync(attached, "location.href", ct).ConfigureAwait(false);
                if (string.IsNullOrEmpty(href) || href == "about:blank") continue;
                current = href;
                if (System.Text.RegularExpressions.Regex.IsMatch(href, "^https?:", System.Text.RegularExpressions.RegexOptions.IgnoreCase) && i > 1) break;
            }
            return new Dictionary<string, object?>
            {
                ["browser"] = endpoint.BrowserName,
                ["target_id"] = attached.TargetId,
                ["navigated"] = true,
                ["url"] = current,
            };
        }, ct).ConfigureAwait(false);
    }

    private static async Task<Dictionary<string, object?>> TextAsync(JsonElement p, string? preferred, CancellationToken ct)
    {
        var endpoint = Require(preferred);
        var max = Fs.ReadInt(p, "max_chars") ?? 8000;
        return await WithTabAsync(p, preferred, async attached =>
        {
            const string expr = "JSON.stringify({url:location.href,title:document.title,text:((document.body&&document.body.innerText)||'')})";
            using var doc = JsonDocument.Parse(await EvalStringAsync(attached, expr, ct).ConfigureAwait(false));
            var root = doc.RootElement;
            var text = root.GetProperty("text").GetString() ?? "";
            return new Dictionary<string, object?>
            {
                ["browser"] = endpoint.BrowserName,
                ["target_id"] = attached.TargetId,
                ["url"] = root.GetProperty("url").GetString(),
                ["title"] = root.GetProperty("title").GetString(),
                ["text"] = text.Length > max ? text[..max] : text,
                ["truncated"] = text.Length > max,
            };
        }, ct).ConfigureAwait(false);
    }

    private static async Task<Dictionary<string, object?>> ClickAsync(JsonElement p, string? preferred, CancellationToken ct)
    {
        var match = Fs.ReadString(p, "match") ?? throw new InvalidOperationException("click requires 'match'");
        var nth = Fs.ReadInt(p, "nth") ?? 0;
        var endpoint = Require(preferred);
        return await WithTabAsync(p, preferred, async attached =>
        {
            var expression = BuildClickExpression(match, nth);
            using var doc = JsonDocument.Parse(await EvalStringAsync(attached, expression, ct).ConfigureAwait(false));
            var root = doc.RootElement;
            if (root.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.String)
                throw new InvalidOperationException(error.GetString());

            var clicked = root.GetProperty("clicked");
            return new Dictionary<string, object?>
            {
                ["browser"] = endpoint.BrowserName,
                ["target_id"] = attached.TargetId,
                ["clicked"] = new Dictionary<string, object?>
                {
                    ["x"] = clicked.GetProperty("x").GetInt32(),
                    ["y"] = clicked.GetProperty("y").GetInt32(),
                    ["w"] = clicked.GetProperty("w").GetInt32(),
                    ["h"] = clicked.GetProperty("h").GetInt32(),
                },
                ["tag"] = root.GetProperty("tag").GetString(),
                ["text"] = root.GetProperty("text").GetString(),
                ["matches"] = root.GetProperty("matches").GetInt32(),
                ["via"] = "dom",
            };
        }, ct).ConfigureAwait(false);
    }

    private static string BuildClickExpression(string match, int nth)
    {
        var matchLiteral = JsonSerializer.Serialize(match);
        return $$"""
        (() => {
          const match = {{matchLiteral}}.toLowerCase();
          const els = Array.from(document.querySelectorAll("a,button,[role=button],[onclick],input[type=button],input[type=submit],summary,label"));
          const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
          const hits = els.filter(e => !e.disabled && (norm(e.innerText || e.textContent).toLowerCase().includes(match) || norm(e.getAttribute("aria-label")).toLowerCase().includes(match) || norm(e.getAttribute("title")).toLowerCase().includes(match)));
          if (hits.length === 0) return JSON.stringify({ error: "no enabled link or button contains " + JSON.stringify(match), total: els.length });
          const el = hits[{{nth}}];
          if (!el) return JSON.stringify({ error: "nth {{nth}} out of range (" + hits.length + " matches)" });
          el.scrollIntoView({ block: "center" });
          const r = el.getBoundingClientRect();
          el.click();
          return JSON.stringify({ clicked: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) }, tag: el.tagName.toLowerCase(), text: norm(el.innerText || el.textContent).slice(0, 100), matches: hits.length });
        })()
        """;
    }
}
