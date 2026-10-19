using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace Mrc.Agent;

/// <summary>
/// Minimal CDP client: one browser WebSocket, id-matched responses, sessionId
/// routing for flattened tab sessions. Calls reject when the socket dies so a
/// caller can rebuild the pool instead of hanging.
/// </summary>
public sealed class CdpClient : IDisposable
{
    private readonly ClientWebSocket _ws;
    private readonly SemaphoreSlim _sendGate = new(1, 1);
    private readonly Dictionary<int, TaskCompletionSource<JsonElement>> _waiters = new();
    private readonly object _gate = new();
    private int _nextId;
    private volatile bool _closed;

    private CdpClient(ClientWebSocket ws)
    {
        _ws = ws;
        _ = Task.Run(PumpAsync);
    }

    public bool Closed => _closed;

    /// <summary>
    /// Connects the browser WebSocket. On the first connection Chrome 136+
    /// holds the handshake open until the user accepts its "Allow debugging?"
    /// prompt, so the budget is generous (the caller's token, else 120s): a
    /// short one would abort before a human can answer.
    /// </summary>
    public static async Task<CdpClient> ConnectAsync(BrowserCdpEndpointLike endpoint, CancellationToken ct)
    {
        var ws = new ClientWebSocket();
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(120_000);
        try
        {
            await ws.ConnectAsync(new Uri($"ws://127.0.0.1:{endpoint.Port}/devtools/browser/{endpoint.Token}"), timeout.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new InvalidOperationException(
                "CDP browser WebSocket handshake timed out (accept Chrome's \"Allow debugging?\" prompt, then retry)");
        }
        catch (WebSocketException)
        {
            throw new InvalidOperationException("CDP browser WebSocket connect failed (remote debugging turned off since?)");
        }
        return new CdpClient(ws);
    }

    public async Task<JsonElement> SendAsync(string method, object? parameters, string? sessionId, int timeoutMs, CancellationToken ct)
    {
        if (_closed) throw new InvalidOperationException("CDP connection closed");
        int id;
        var waiter = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (_gate)
        {
            id = ++_nextId;
            _waiters[id] = waiter;
        }

        var frame = new Dictionary<string, object?> { ["id"] = id, ["method"] = method, ["params"] = parameters ?? new { } };
        if (sessionId is not null) frame["sessionId"] = sessionId;
        var json = JsonSerializer.Serialize(frame);

        try
        {
            await _sendGate.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                await _ws.SendAsync(Encoding.UTF8.GetBytes(json), WebSocketMessageType.Text, true, ct).ConfigureAwait(false);
            }
            finally
            {
                _sendGate.Release();
            }

            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(timeoutMs);
            using (timeout.Token.Register(() =>
                   {
                       lock (_gate) _waiters.Remove(id);
                       waiter.TrySetException(new InvalidOperationException(
                           $"CDP {method} timed out after {timeoutMs}ms" +
                           (sessionId is not null ? " (a pending 'Allow debugging?' prompt blocks this tab)" : "")));
                   }))
            {
                return await waiter.Task.ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException)
        {
            lock (_gate) _waiters.Remove(id);
            throw;
        }
    }

    private async Task PumpAsync()
    {
        var buffer = new byte[Protocol.MaxFrameBytes];
        using var assembled = new MemoryStream();
        while (!_closed && _ws.State == WebSocketState.Open)
        {
            WebSocketReceiveResult result;
            assembled.SetLength(0);
            do
            {
                try
                {
                    result = await _ws.ReceiveAsync(buffer, CancellationToken.None).ConfigureAwait(false);
                }
                catch (Exception)
                {
                    Fail("CDP connection closed");
                    return;
                }
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    Fail("CDP connection closed unexpectedly");
                    return;
                }
                if (assembled.Length + result.Count > Protocol.MaxFrameBytes * 8)
                {
                    assembled.SetLength(0);
                    break;
                }
                assembled.Write(buffer, 0, result.Count);
            }
            while (!result.EndOfMessage);

            if (assembled.Length == 0) continue;
            Dispatch(Encoding.UTF8.GetString(assembled.GetBuffer(), 0, (int)assembled.Length));
        }
        Fail("CDP connection closed");
    }

    private void Dispatch(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (!root.TryGetProperty("id", out var idElement) || !idElement.TryGetInt32(out var id)) return;
            TaskCompletionSource<JsonElement>? waiter;
            lock (_gate)
            {
                if (!_waiters.Remove(id, out waiter)) return;
            }
            if (root.TryGetProperty("error", out var error))
            {
                var message = error.TryGetProperty("message", out var m) ? m.GetString() : error.ToString();
                waiter.TrySetException(new InvalidOperationException($"CDP error: {message}"));
                return;
            }
            var result = root.TryGetProperty("result", out var value) ? value.Clone() : default;
            waiter.TrySetResult(result);
        }
        catch (JsonException)
        {
            // ignore malformed frames
        }
    }

    private void Fail(string reason)
    {
        _closed = true;
        List<TaskCompletionSource<JsonElement>> waiters;
        lock (_gate)
        {
            waiters = _waiters.Values.ToList();
            _waiters.Clear();
        }
        foreach (var waiter in waiters) waiter.TrySetException(new InvalidOperationException(reason));
    }

    public void Dispose()
    {
        _closed = true;
        try
        {
            if (_ws.State == WebSocketState.Open)
                _ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "closing", CancellationToken.None).Wait(TimeSpan.FromSeconds(2));
        }
        catch (Exception)
        {
            // closing a dead socket is fine
        }
        _ws.Dispose();
        _sendGate.Dispose();
    }
}

/// <summary>Endpoint shape CdpClient needs (decoupled from BrowserCdp's private record).</summary>
public sealed class BrowserCdpEndpointLike
{
    public required int Port { get; init; }
    public required string Token { get; init; }
}
