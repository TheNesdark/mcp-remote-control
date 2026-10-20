using System.Net.WebSockets;

namespace Mrc.Agent;

public sealed class AgentConnectionOptions
{
    public required string ServerUrl { get; init; }
    public required string Token { get; init; }
    public required string Name { get; init; }
    public string[] Tags { get; init; } = Array.Empty<string>();
    public string? AgentId { get; init; }
    public bool Paused { get; init; }
    public string Version { get; init; } = Versions.Current;
}

/// <summary>
/// Owns the WebSocket, the hello/welcome handshake, the heartbeat and the
/// reconnect schedule (1 s doubling to 60 s, +/-20% jitter, mirroring
/// agent/src/connection.ts). Fatal closes (4001 auth, 4003 takeover) stop the
/// loop instead of retrying forever.
/// </summary>
public sealed class AgentConnection : IAsyncDisposable
{
    private const int BackoffBaseMs = 1_000;
    private const int BackoffCapMs = 60_000;

    private readonly AgentConnectionOptions _opts;
    private readonly JobManager _jobs;
    private readonly CancellationTokenSource _cts = new();
    private readonly SemaphoreSlim _reconnect = new(0);
    private readonly Random _random = new();

    private WsChannel? _channel;
    private CancellationTokenSource? _heartbeatCts;
    private string? _agentId;
    private bool _paused;
    private bool _hadWelcome;
    private volatile bool _stopped;

    public AgentConnection(AgentConnectionOptions opts, JobManager jobs)
    {
        _opts = opts;
        _jobs = jobs;
        _agentId = opts.AgentId;
        _paused = opts.Paused;
        _jobs.OnOutput += OnJobOutput;
        _jobs.OnResult += OnJobResult;
    }

    public string? AgentId => _agentId;
    public bool Connected => _channel?.IsOpen == true && _hadWelcome;

    public event Action<string>? OnWelcome;
    public event Action<string>? OnFatal;
    public event Action<bool>? OnPausedChanged;

    public async Task RunAsync()
    {
        var attempt = 0;
        while (!_stopped)
        {
            try
            {
                await ConnectOnceAsync().ConfigureAwait(false);
                // A clean session: reset the schedule and wait to be woken by a
                // close, a reconnect request or shutdown.
                attempt = 0;
                await WaitForWakeAsync().ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (_cts.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                if (_stopped) break;
                Log.Warn("connection failed", new { error = ex.Message, attempt });
            }

            if (_stopped) break;
            // A session that had a welcome gets one fast retry first.
            if (_hadWelcome) attempt = Math.Min(attempt, 1);
            var delay = BackoffDelay(attempt);
            attempt++;
            Log.Info("reconnecting", new { delayMs = delay });
            try
            {
                await Task.Delay(delay, _cts.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            await DrainReconnectAsync().ConfigureAwait(false);
        }
    }

    private int BackoffDelay(int attempt)
    {
        var steps = Math.Min(attempt, 16);
        var raw = Math.Min(BackoffBaseMs * (1 << steps), BackoffCapMs);
        var jitter = raw * 0.2 * (_random.NextDouble() * 2 - 1);
        return Math.Max(250, (int)Math.Round(raw + jitter));
    }

    private async Task ConnectOnceAsync()
    {
        var url = Protocol.NormalizeAgentUrl(_opts.ServerUrl);
        Log.Info("connecting", new { url, name = _opts.Name });
        using var ws = new ClientWebSocket();
        await ws.ConnectAsync(new Uri(url), _cts.Token).ConfigureAwait(false);

        var channel = new WsChannel(ws);
        _channel = channel;
        var closed = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
        channel.Closed += reason => closed.TrySetResult(reason);
        channel.Message += OnServerMessage;

        await channel.SendAsync(Json.Serialize(new HelloMsg
        {
            Token = _opts.Token,
            AgentId = _agentId,
            Name = _opts.Name,
            Host = Environment.MachineName,
            Os = $"Windows_NT {Environment.OSVersion.Version}",
            Version = _opts.Version,
            Tags = _opts.Tags,
            Caps = Protocol.Caps,
            Paused = _paused,
        }), _cts.Token).ConfigureAwait(false);

        var pump = channel.PumpAsync(_cts.Token);
        await Task.WhenAny(pump, closed.Task).ConfigureAwait(false);
        StopHeartbeat();
        // 4001/4003 are terminal (bad token / taken over); 4003 with a
        // heartbeat-timeout reason is just a stale socket and is retried.
        var closeReason = closed.Task.IsCompleted ? closed.Task.Result : null;
        var closeCode = ws.CloseStatus;
        if (closeCode == (WebSocketCloseStatus)4001)
        {
            _stopped = true;
            OnFatal?.Invoke("authentication failed: check the token (auth_failed)");
        }
        else if (closeCode == (WebSocketCloseStatus)4003 && closeReason != "heartbeat timeout")
        {
            _stopped = true;
            OnFatal?.Invoke($"server rejected this agent: {closeReason ?? "unknown reason"}");
        }
        _channel = null;
        _hadWelcome = false;
        _jobs.CancelAll();
        Log.Info("disconnected", new { reason = closed.Task.IsCompleted ? closed.Task.Result : null });
        try
        {
            // A half-open socket (the hub container was replaced) leaves the
            // pump waiting on a send that never completes. Waiting for it
            // forever would strand the agent: bound the wait and then force
            // the socket down so the reconnect loop can start.
            await pump.WaitAsync(TimeSpan.FromSeconds(5), CancellationToken.None).ConfigureAwait(false);
        }
        catch (TimeoutException)
        {
            Log.Warn("pump did not finish, aborting the socket");
        }
        catch (Exception)
        {
            // the pump failed: nothing left to do here
        }
        try { await channel.DisposeAsync().ConfigureAwait(false); } catch { /* already gone */ }
    }

    private void OnServerMessage(string raw)
    {
        var type = Json.TypeOf(raw);
        switch (type)
        {
            case "welcome":
            {
                var msg = Json.Deserialize<WelcomeMsg>(raw);
                if (msg is null) return;
                _hadWelcome = true;
                _agentId = msg.AgentId;
                Log.Info("welcomed", new { agentId = msg.AgentId });
                StartHeartbeat(msg.HeartbeatIntervalMs > 0 ? msg.HeartbeatIntervalMs : Protocol.HeartbeatIntervalMs);
                OnWelcome?.Invoke(msg.AgentId);
                if (msg.LatestAgentVersion is not null)
                    AutoUpdate.Schedule(this, msg);
                break;
            }
            case "job.request":
            {
                var msg = Json.Deserialize<JobRequestMsg>(raw);
                if (msg is null) return;
                _jobs.HandleRequest(msg);
                break;
            }
            case "job.cancel":
            {
                var msg = Json.Deserialize<JobCancelMsg>(raw);
                if (msg is not null) _jobs.HandleCancel(msg.JobId);
                break;
            }
            case "ping":
                _ = SendAsync(new HeartbeatMsg { Ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() });
                break;
            case "error":
                Log.Warn("server error", new { raw });
                break;
            default:
                Log.Warn("invalid server message", new { raw = raw.Length > 200 ? raw[..200] : raw });
                break;
        }
    }

    private void StartHeartbeat(int intervalMs)
    {
        StopHeartbeat();
        var cts = new CancellationTokenSource();
        _heartbeatCts = cts;
        _ = Task.Run(async () =>
        {
            try
            {
                while (!cts.IsCancellationRequested)
                {
                    await Task.Delay(intervalMs, cts.Token).ConfigureAwait(false);
                    await SendAsync(new HeartbeatMsg { Ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() }).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException)
            {
                // stopped with the connection
            }
            catch (Exception ex)
            {
                Log.Debug("heartbeat stopped", new { error = ex.Message });
            }
        });
    }

    private void StopHeartbeat()
    {
        try
        {
            _heartbeatCts?.Cancel();
        }
        catch (ObjectDisposedException)
        {
            // already gone
        }
        _heartbeatCts?.Dispose();
        _heartbeatCts = null;
    }

    public async Task SendAsync(object msg)
    {
        var channel = _channel;
        if (channel is null || !channel.IsOpen) return;
        try
        {
            await channel.SendAsync(Json.Serialize(msg), _cts.Token).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            Log.Debug("send failed", new { error = ex.Message });
        }
    }

    private void OnJobOutput(JobOutputMsg msg) => _ = SendAsync(msg);
    private void OnJobResult(JobResultMsg msg) => _ = SendAsync(msg);

    public void ReconnectNow()
    {
        var channel = _channel;
        if (channel is null || !channel.IsOpen) return;
        Log.Info("reconnect requested");
        try
        {
            channel.DisposeAsync().AsTask().Wait(TimeSpan.FromSeconds(2));
        }
        catch (Exception)
        {
            // already closing
        }
        _reconnect.Release();
    }

    private async Task WaitForWakeAsync()
    {
        var wake = _reconnect.WaitAsync(_cts.Token);
        var shutdown = Task.Delay(Timeout.Infinite, _cts.Token);
        await Task.WhenAny(wake, shutdown).ConfigureAwait(false);
    }

    private async Task DrainReconnectAsync()
    {
        while (_reconnect.CurrentCount > 0)
            await _reconnect.WaitAsync(TimeSpan.FromMilliseconds(1)).ConfigureAwait(false);
    }

    public void SetPaused(bool paused)
    {
        _paused = paused;
        _ = SendAsync(new PresenceMsg { Paused = paused });
        OnPausedChanged?.Invoke(paused);
        Log.Info(paused ? "agent paused locally" : "agent resumed locally");
    }

    public async Task StopAsync()
    {
        _stopped = true;
        StopHeartbeat();
        try
        {
            _cts.Cancel();
        }
        catch (ObjectDisposedException)
        {
            // already stopping
        }
        if (_channel is not null) await _channel.DisposeAsync().ConfigureAwait(false);
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync().ConfigureAwait(false);
        _cts.Dispose();
        _reconnect.Dispose();
    }
}
