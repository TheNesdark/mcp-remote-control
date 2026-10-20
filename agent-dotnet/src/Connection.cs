using System.Net.WebSockets;
using System.Text;

namespace Mrc.Agent;

public enum LogLevel { Debug, Info, Warn, Error }

/// <summary>
/// ISO8601 + padded level + message + JSON fields, matching the hub's log shape.
/// </summary>
public static class Log
{
    private static readonly object Gate = new();
    private static LogLevel _level = LogLevel.Info;
    private static string? _file;
    private const long MaxLogBytes = 5 * 1024 * 1024;

    public static void SetLevel(string? level)
    {
        _level = (level ?? "info").ToLowerInvariant() switch
        {
            "debug" => LogLevel.Debug,
            "warn" or "warning" => LogLevel.Warn,
            "error" => LogLevel.Error,
            _ => LogLevel.Info,
        };
    }

    public static void SetFile(string? path) => _file = string.IsNullOrEmpty(path) ? null : path;

    public static void Debug(string msg, object? fields = null) => Write(LogLevel.Debug, msg, fields);
    public static void Info(string msg, object? fields = null) => Write(LogLevel.Info, msg, fields);
    public static void Warn(string msg, object? fields = null) => Write(LogLevel.Warn, msg, fields);
    public static void Error(string msg, object? fields = null) => Write(LogLevel.Error, msg, fields);

    private static void Write(LogLevel level, string msg, object? fields)
    {
        if (level < _level) return;
        var line = $"{DateTime.UtcNow:yyyy-MM-ddTHH:mm:ss.fffZ} {level.ToString().ToUpperInvariant(),-5} {msg}" +
                   (fields is null ? "" : " " + Json.Serialize(fields));
        lock (Gate)
        {
            try
            {
                Console.Error.WriteLine(line);
            }
            catch (IOException)
            {
                // no console (windows subsystem): the file sink below still gets it
            }
            if (_file is not null) AppendFile(line);
        }
    }

    private static void AppendFile(string line)
    {
        try
        {
            var dir = Path.GetDirectoryName(_file!);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            Rotate();
            File.AppendAllText(_file!, line + Environment.NewLine, Encoding.UTF8);
        }
        catch (Exception)
        {
            // logging must never take the agent down
        }
    }

    private static void Rotate()
    {
        try
        {
            var info = new FileInfo(_file!);
            if (!info.Exists || info.Length < MaxLogBytes) return;
            var previous = _file + ".1";
            if (File.Exists(previous)) File.Delete(previous);
            File.Move(_file!, previous);
        }
        catch (Exception)
        {
            // best effort
        }
    }
}

/// <summary>
/// Minimal "one JSON message per text frame" socket wrapper: the hub's framing
/// is exactly that, and a fresh 1 MiB buffer per message is what the TS side
/// effectively allocates too.
/// </summary>
public sealed class WsChannel : IAsyncDisposable
{
    private readonly ClientWebSocket _ws;
    private readonly SemaphoreSlim _sendGate = new(1, 1);

    public event Action<string>? Message;
    public event Action<string?>? Closed;

    public WsChannel(ClientWebSocket ws) => _ws = ws;

    public bool IsOpen => _ws.State == WebSocketState.Open;

    public async Task SendAsync(string json, CancellationToken ct)
    {
        var bytes = Encoding.UTF8.GetBytes(json);
        await _sendGate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await _ws.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, ct).ConfigureAwait(false);
        }
        finally
        {
            _sendGate.Release();
        }
    }

    /// <summary>Reads frames until the socket closes; raises Message per text frame.</summary>
    public async Task PumpAsync(CancellationToken ct)
    {
        var buffer = new byte[Protocol.MaxFrameBytes];
        using var assembled = new MemoryStream();
        while (!ct.IsCancellationRequested && _ws.State == WebSocketState.Open)
        {
            WebSocketReceiveResult result;
            assembled.SetLength(0);
            do
            {
                result = await _ws.ReceiveAsync(buffer, ct).ConfigureAwait(false);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    Closed?.Invoke(_ws.CloseStatusDescription);
                    return;
                }
                if (assembled.Length + result.Count > Protocol.MaxFrameBytes * 4)
                {
                    Log.Warn("oversized server frame dropped", new { bytes = assembled.Length + result.Count });
                    assembled.SetLength(0);
                    break;
                }
                assembled.Write(buffer, 0, result.Count);
            }
            while (!result.EndOfMessage);

            if (assembled.Length == 0) continue;
            Message?.Invoke(Encoding.UTF8.GetString(assembled.GetBuffer(), 0, (int)assembled.Length));
        }
    }

    public async ValueTask DisposeAsync()
    {
        try
        {
            if (_ws.State == WebSocketState.Open)
            {
                // A half-open socket never answers the close handshake (the
                // hub container was replaced under us): bound the wait and
                // abort afterwards, so the caller is never stuck on it.
                var closing = _ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "agent stopping", CancellationToken.None);
                await closing.WaitAsync(TimeSpan.FromSeconds(2), CancellationToken.None).ConfigureAwait(false);
            }
        }
        catch (Exception)
        {
            // closing a dead socket is fine
        }
        try { _ws.Abort(); } catch { /* already gone */ }
        _ws.Dispose();
        _sendGate.Dispose();
    }
}
