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

    private sealed record Endpoint(string BrowserName, string UserDataDir, int Port, string WsPath);

    private const int DefaultDebugPort = 9222;

    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMilliseconds(2_000) };

    // ---------------------------------------------------------------- endpoint

    /// <summary>
    /// Finds the DevTools endpoint of the user's browser.
    ///
    /// Modern Chrome (136+) only opens the port after the user turns on
    /// chrome://inspect/#remote-debugging, which writes DevToolsActivePort:
    /// line 0 is the port, line 1 the browser WebSocket token.
    ///
    /// Legacy Chrome (109, the last build for Windows 7) has no such toggle:
    /// when it was launched with --remote-debugging-port (see operation
    /// `enable`) the file carries the port and the browser path, and even
    /// without a file the legacy /json/version HTTP endpoint answers with the
    /// canonical webSocketDebuggerUrl.
    /// </summary>
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
            if (!Directory.Exists(userDataDir)) continue;
            var file = Path.Combine(userDataDir, "DevToolsActivePort");
            if (TryReadActivePort(file, out var port, out var wsPath))
            {
                return new Endpoint(browser, userDataDir, port, wsPath);
            }
        }
        // No usable DevToolsActivePort: an old browser (or one launched with an
        // explicit port) still answers the legacy HTTP probe.
        var probe = ProbePort(DefaultDebugPort);
        if (probe is not null)
        {
            var name = order.Contains(probe.BrowserName) ? probe.BrowserName : order[0];
            return new Endpoint(name, local, DefaultDebugPort, probe.WsPath);
        }
        return null;
    }

    private static bool TryReadActivePort(string file, out int port, out string wsPath)
    {
        port = 0;
        wsPath = "devtools/browser";
        if (!File.Exists(file)) return false;
        try
        {
            var lines = File.ReadAllLines(file);
            if (lines.Length == 0) return false;
            if (!int.TryParse(lines[0].Trim(), out port) || port <= 0 || port > 65535) return false;
            wsPath = WsPathFromActivePort(lines.Length > 1 ? lines[1] : null);
            return true;
        }
        catch (IOException)
        {
            // unreadable => not usable
            return false;
        }
    }

    /// <summary>
    /// Chrome 136+ writes the bare token (used as /devtools/browser/&lt;token&gt;);
    /// older builds write the full browser path. Accept both, plus a file with
    /// no second line at all.
    /// </summary>
    private static string WsPathFromActivePort(string? secondLine)
    {
        var raw = secondLine?.Trim() ?? "";
        if (raw.Length == 0) return "devtools/browser";
        if (raw.StartsWith("devtools/", StringComparison.OrdinalIgnoreCase)) return raw;
        if (raw.StartsWith("/")) return raw.TrimStart('/');
        return $"devtools/browser/{raw}";
    }

    private sealed record ProbeResult(string WsPath, string BrowserName);

    /// <summary>The legacy /json/version endpoint (gone in Chrome 136+).</summary>
    private static ProbeResult? ProbePort(int port)
    {
        try
        {
            var text = Http.GetStringAsync($"http://127.0.0.1:{port}/json/version").GetAwaiter().GetResult();
            using var doc = JsonDocument.Parse(text);
            if (!doc.RootElement.TryGetProperty("webSocketDebuggerUrl", out var ws) || ws.ValueKind != JsonValueKind.String)
                return null;
            var url = ws.GetString() ?? "";
            if (url.Length == 0) return null;
            var path = new Uri(url).AbsolutePath.TrimStart('/');
            if (path.Length == 0) return null;
            var browser = doc.RootElement.TryGetProperty("Browser", out var b) ? b.GetString() ?? "" : "";
            var name = browser.StartsWith("Edg", StringComparison.OrdinalIgnoreCase) ? "msedge" : "chrome";
            return new ProbeResult(path, name);
        }
        catch (Exception)
        {
            // nothing listening, or a modern build that no longer serves /json
            return null;
        }
    }

    private static Endpoint Require(string? preferred) =>
        DiscoverEndpoint(preferred) ?? throw new InvalidOperationException(NotEnabledMessage(preferred));

    /// <summary>Version-aware "nothing to attach to" message.</summary>
    private static string NotEnabledMessage(string? preferred)
    {
        var exe = FindBrowserExe(preferred);
        if (exe is null)
            return "no Chrome/Edge installation found (looked in Program Files and LocalAppData)";
        var version = FileVersionOf(exe.Value.Path);
        var major = ParseMajor(version);
        if (major is not null && major >= 136)
        {
            return "remote debugging is not enabled on the default profile: open chrome://inspect/#remote-debugging " +
                   "in the browser, turn 'Allow remote debugging' on, then retry";
        }
        var label = exe.Value.Name == "chrome" ? "Chrome" : "Edge";
        return "remote debugging is not enabled on the default profile: run this tool with operation=enable " +
               $"(relaunches {label}{(version is null ? "" : $" {version}")} with --remote-debugging-port={DefaultDebugPort}); " +
               "on Chrome 136+ enable it from chrome://inspect/#remote-debugging instead";
    }

    private static (string Name, string Path)? FindBrowserExe(string? preferred)
    {
        var order = preferred is not null ? new[] { preferred } : new[] { "chrome", "msedge" };
        foreach (var browser in order)
        {
            foreach (var candidate in ExeCandidates(browser))
            {
                if (File.Exists(candidate)) return (browser, candidate);
            }
        }
        return null;
    }

    private static IEnumerable<string> ExeCandidates(string browser)
    {
        var roots = new[]
        {
            Environment.GetEnvironmentVariable("ProgramFiles") ?? "",
            Environment.GetEnvironmentVariable("ProgramFiles(x86)") ?? "",
            Environment.GetEnvironmentVariable("LOCALAPPDATA") ?? "",
        };
        var relative = browser == "chrome"
            ? Path.Combine("Google", "Chrome", "Application", "chrome.exe")
            : Path.Combine("Microsoft", "Edge", "Application", "msedge.exe");
        foreach (var root in roots)
        {
            if (root.Length > 0) yield return Path.Combine(root, relative);
        }
    }

    private static string? FileVersionOf(string path)
    {
        try
        {
            var raw = System.Diagnostics.FileVersionInfo.GetVersionInfo(path).FileVersion;
            return string.IsNullOrWhiteSpace(raw) ? null : raw;
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static int? ParseMajor(string? version) =>
        version is not null && Version.TryParse(version, out var parsed) ? parsed.Major : (int?)null;

    // ------------------------------------------------------------------- pool

    private static async Task<Pool> GetPoolAsync(Endpoint endpoint, CancellationToken ct)
    {
        Pool? reusable;
        lock (Gate)
        {
            reusable = _pool;
            if (reusable is not null)
            {
                var same = reusable.Endpoint.WsPath == endpoint.WsPath
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

        // Candidates: the path derived from DevToolsActivePort first; then
        // whatever the legacy /json/version endpoint reports for this port
        // (old Chrome writes a path-style second line, or no second line at
        // all, which the probe resolves canonically).
        var candidates = new List<string> { endpoint.WsPath };
        var probed = ProbePort(endpoint.Port);
        if (probed is not null && !candidates.Contains(probed.WsPath)) candidates.Add(probed.WsPath);

        Exception? last = null;
        foreach (var path in candidates)
        {
            try
            {
                var client = await CdpClient.ConnectAsync(new BrowserCdpEndpointLike { Port = endpoint.Port, WsPath = path }, ct).ConfigureAwait(false);
                var pool = new Pool { Endpoint = endpoint with { WsPath = path }, Client = client, LastUsed = Environment.TickCount64 };
                lock (Gate) _pool = pool;
                return pool;
            }
            catch (Exception ex)
            {
                last = ex;
            }
        }
        throw last ?? new InvalidOperationException("could not connect to the browser DevTools endpoint");
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
                "search" => await SearchAsync(p, preferred, ct).ConfigureAwait(false),
                "enable" => await EnableAsync(p, preferred, ct).ConfigureAwait(false),
                _ => throw new InvalidOperationException($"unknown browser operation: {operation}"),
            };
            return JobOutcome.Success(meta);
        }
        catch (InvalidOperationException ex)
        {
            return JobOutcome.Failure(ex.Message);
        }
    }

    // --------------------------------------------------------------- enable

    /// <summary>
    /// operation=enable: makes the user's browser debuggable. On Chrome &lt; 136
    /// (Windows 7 / Chrome 109, which has no chrome://inspect toggle) the only
    /// way is relaunching it with --remote-debugging-port; this closes the
    /// browser (graceful first, forced when it lingers) and starts it again. On
    /// Chrome 136+ the switch is ignored for the default profile, so it points
    /// the caller to chrome://inspect/#remote-debugging instead.
    /// </summary>
    private static async Task<Dictionary<string, object?>> EnableAsync(JsonElement p, string? preferred, CancellationToken ct)
    {
        if (!Fs.ReadBool(p, "confirm"))
            throw new InvalidOperationException("enable requires confirm=1 (it closes and relaunches the browser)");
        var port = Fs.ReadInt(p, "port") ?? DefaultDebugPort;
        if (port < 1024 || port > 65535) throw new InvalidOperationException("port must be between 1024 and 65535");

        var existing = DiscoverEndpoint(preferred);
        if (existing is not null)
        {
            return new Dictionary<string, object?>
            {
                ["browser"] = existing.BrowserName,
                ["status"] = "already-enabled",
                ["port"] = existing.Port,
                ["ws_path"] = existing.WsPath,
            };
        }

        var exe = FindBrowserExe(preferred)
                  ?? throw new InvalidOperationException("no Chrome/Edge installation found (looked in Program Files and LocalAppData)");
        var version = FileVersionOf(exe.Path);
        var major = ParseMajor(version);
        var label = exe.Name == "chrome" ? "Chrome" : "Edge";
        if (major is not null && major >= 136)
        {
            throw new InvalidOperationException(
                $"{label} {version} ignores --remote-debugging-port on the default profile: " +
                "open chrome://inspect/#remote-debugging in the browser, turn 'Allow remote debugging' on, then retry");
        }

        var image = Path.GetFileName(exe.Path);
        await KillImageAsync(image).ConfigureAwait(false);
        StartDetached(exe.Path, $"--remote-debugging-port={port}");

        var deadline = Environment.TickCount64 + 25_000;
        while (Environment.TickCount64 < deadline)
        {
            await Task.Delay(700, ct).ConfigureAwait(false);
            var endpoint = DiscoverEndpoint(preferred) ?? ProbeAsEndpoint(port, exe.Name);
            if (endpoint is not null)
            {
                return new Dictionary<string, object?>
                {
                    ["browser"] = endpoint.BrowserName,
                    ["status"] = "enabled",
                    ["port"] = endpoint.Port,
                    ["ws_path"] = endpoint.WsPath,
                    ["version"] = version,
                    ["note"] = "the browser was relaunched with the DevTools port; tabs return with the session restore",
                };
            }
        }
        throw new InvalidOperationException(
            "the browser was relaunched but the DevTools port did not open within 25s " +
            $"(check for a dialog or an error on the machine; {image} {version})");
    }

    private static Endpoint? ProbeAsEndpoint(int port, string browser)
    {
        var probe = ProbePort(port);
        if (probe is null) return null;
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var dir = browser == "chrome"
            ? Path.Combine(local, "Google", "Chrome", "User Data")
            : Path.Combine(local, "Microsoft", "Edge", "User Data");
        return new Endpoint(browser, dir, port, probe.WsPath);
    }

    /// <summary>taskkill: graceful first, forced when the browser lingers.</summary>
    private static async Task KillImageAsync(string image)
    {
        var procName = Path.GetFileNameWithoutExtension(image);
        foreach (var force in new[] { false, true })
        {
            try
            {
                using var kill = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(
                    "taskkill", $"/IM {image}{(force ? " /F" : "")} /T")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                });
                if (kill is not null)
                {
                    kill.StandardOutput.ReadToEnd();
                    kill.StandardError.ReadToEnd();
                    kill.WaitForExit(5_000);
                }
            }
            catch (Exception)
            {
                // taskkill unavailable: the close below just will not happen
            }
            await Task.Delay(force ? 1_200 : 3_000).ConfigureAwait(false);
            if (System.Diagnostics.Process.GetProcessesByName(procName).Length == 0) return;
        }
    }

    private static void StartDetached(string exe, string args)
    {
        try
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(exe, args) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException($"could not relaunch {Path.GetFileName(exe)}: {ex.Message}");
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

    /// <summary>
    /// Runs an expression and returns the RemoteObject's `value` (the JSON
    /// payload of the evaluated expression, not the CDP envelope).
    /// </summary>
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
        // Runtime.evaluate answers {result: {type, value}}; the useful part is
        // the inner RemoteObject's `value` field.
        if (!result.TryGetProperty("result", out var remote)) return default;
        if (remote.TryGetProperty("value", out var value)) return value;
        // No `value` (e.g. undefined or an unserializable object): hand back the
        // RemoteObject so callers can still stringify type/description.
        return remote;
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

    /// <summary>
    /// search: type a query into the page's search box and submit it. The
    /// keystrokes are dispatched one by one so the page's own autocomplete runs
    /// and a screen recording shows the query being typed.
    /// </summary>
    private static async Task<Dictionary<string, object?>> SearchAsync(JsonElement p, string? preferred, CancellationToken ct)
    {
        var query = Fs.ReadString(p, "match") ?? Fs.ReadString(p, "query")
            ?? throw new InvalidOperationException("search requires 'match'");
        var endpoint = Require(preferred);
        return await WithTabAsync(p, preferred, async attached =>
        {
            // Find the search input, focus it, and clear whatever is there.
            var find = """
            (() => {
              const cands = Array.from(document.querySelectorAll("input[type=search],input[name=q],input[name=search_query],input[type=text],input:not([type])"));
              const vis = cands.filter(e => e.offsetParent !== null && !e.disabled && !e.readOnly);
              const el = vis[0];
              if (!el) return JSON.stringify({ error: "no visible search input on this page" });
              el.scrollIntoView({ block: "center" });
              el.focus();
              if (el.select) el.select();
              const r = el.getBoundingClientRect();
              return JSON.stringify({ ok: true, name: el.name || "", x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) });
            })()
            """;
            using var found = JsonDocument.Parse(await EvalStringAsync(attached, find, ct).ConfigureAwait(false));
            var info = found.RootElement;
            if (info.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.String)
                throw new InvalidOperationException(error.GetString());

            // Type character by character so autocomplete fires and the query
            // is visible in a recording.
            foreach (var ch in query)
            {
                var chLiteral = JsonSerializer.Serialize(ch.ToString());
                await EvalStringAsync(attached, $"(() => {{ const el = document.activeElement; if (!el) return 'no-focus'; el.value += {chLiteral}; el.dispatchEvent(new Event('input', {{bubbles:true}})); return el.value; }})()", ct).ConfigureAwait(false);
                await Task.Delay(120, ct).ConfigureAwait(false);
            }

            // Submit with a real Enter keydown (some pages ignore form.submit()).
            var submit = """
            (() => {
              const el = document.activeElement;
              if (!el) return "no-focus";
              for (const type of ["keydown","keypress","keyup"]) el.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
              return "keydown";
            })()
            """;
            var via = await EvalStringAsync(attached, submit, ct).ConfigureAwait(false);

            var url = "";
            for (var i = 0; i < 24; i++)
            {
                await Task.Delay(500, ct).ConfigureAwait(false);
                url = await EvalStringAsync(attached, "location.href", ct).ConfigureAwait(false);
                if (!string.IsNullOrEmpty(url) && url.Contains("search", StringComparison.OrdinalIgnoreCase)) break;
            }

            return new Dictionary<string, object?>
            {
                ["browser"] = endpoint.BrowserName,
                ["target_id"] = attached.TargetId,
                ["query"] = query,
                ["typed"] = query.Length,
                ["submitted"] = via,
                ["input_name"] = info.TryGetProperty("name", out var nameProp) ? nameProp.GetString() : "",
                ["url"] = url,
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
