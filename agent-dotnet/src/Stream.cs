using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;

namespace Mrc.Agent;

/// <summary>
/// stream.start / stream.stop: live MJPEG capture, fanned out by the hub to
/// the /stream/&lt;agent&gt; viewers.
///
/// ffmpeg does the capture when it is available: gdigrab for the desktop,
/// dshow for a webcam. It writes JPEG frames to stdout (image2pipe); each
/// frame is split out, base64-encoded and pushed as a `stream.frame` message
/// over the agent's existing WebSocket. Without ffmpeg a GDI loop keeps the
/// screen streaming at a lower rate (the camera source then fails with a
/// clear error).
///
/// Frames larger than Protocol.MaxStreamFrameBytes are dropped: base64 + JSON
/// framing must stay below the WebSocket frame limit or the whole socket dies.
/// Capture stops when the hub sends stream.stop (last viewer left) or when the
/// connection drops.
/// </summary>
public sealed class StreamManager
{
    private readonly Func<object, Task> _send;
    private readonly object _gate = new();
    private readonly Dictionary<string, Session> _sessions = new();

    public StreamManager(Func<object, Task> send)
    {
        _send = send;
    }

    /// <summary>True while any capture is running (tray tooltip / diagnose).</summary>
    public bool AnyActive
    {
        get
        {
            lock (_gate) return _sessions.Count > 0;
        }
    }

    public void Start(StreamStartMsg msg)
    {
        _ = Task.Run(() => RunStart(msg));
    }

    private void RunStart(StreamStartMsg msg)
    {
        var session = new Session
        {
            StreamId = msg.StreamId,
            Source = msg.Source == "camera" ? "camera" : "screen",
            Fps = Math.Clamp(msg.Fps, 1, 30),
            Quality = Math.Clamp(msg.Quality, 1, 100),
            MaxWidth = Math.Clamp(msg.MaxWidth, 160, 4096),
        };

        lock (_gate)
        {
            if (_sessions.ContainsKey(session.StreamId)) return;
            _sessions[session.StreamId] = session;
        }

        try
        {
            var ffmpeg = Camera.FindFfmpeg();
            if (ffmpeg is not null)
            {
                var args = session.Source == "camera"
                    ? DshowArgs(RequireCamera(ffmpeg), session)
                    : GdiGrabArgs(session);
                session.Process = StartFfmpeg(ffmpeg, args);
            }
            else if (session.Source == "camera")
            {
                Fail(session, "ffmpeg not found on the agent machine (the camera source needs it)");
                return;
            }

            Send(new StreamStateMsg { StreamId = session.StreamId, Status = "started", Fps = session.Fps });
            Log.Info("stream capture started", new
            {
                streamId = session.StreamId,
                source = session.Source,
                fps = session.Fps,
                quality = session.Quality,
                maxWidth = session.MaxWidth,
                encoder = session.Process is null ? "gdi" : "ffmpeg",
            });

            session.Worker = session.Process is null
                ? Task.Run(() => GdiLoop(session))
                : Task.Run(() => PumpFfmpeg(session));
        }
        catch (Exception ex)
        {
            Fail(session, ex.Message);
        }
    }

    private static string RequireCamera(string ffmpeg)
    {
        var device = Camera.FindFirstVideoDevice(ffmpeg);
        if (device is null || device.Length == 0)
            throw new InvalidOperationException("no video input device found");
        return device;
    }

    public void Stop(string streamId)
    {
        Session? session;
        lock (_gate) _sessions.TryGetValue(streamId, out session);
        if (session is null) return;
        RequestStop(session, notify: true);
    }

    /// <summary>Kill every capture (connection lost, or the agent is exiting).</summary>
    public void StopAll()
    {
        List<Session> all;
        lock (_gate)
        {
            all = _sessions.Values.ToList();
            _sessions.Clear();
        }
        foreach (var session in all) RequestStop(session, notify: false);
    }

    private void RequestStop(Session session, bool notify)
    {
        if (notify) Send(new StreamStateMsg { StreamId = session.StreamId, Status = "stopped" });
        try { session.Cts.Cancel(); } catch { /* already gone */ }
        var process = session.Process;
        if (process is not null)
        {
            try
            {
                if (!process.HasExited) process.Kill(entireProcessTree: true);
            }
            catch
            {
                // already dead
            }
        }
        // The worker removes the session; this is the safety net for a worker
        // that never got to run (process start raced the stop).
        _ = Task.Run(async () =>
        {
            try
            {
                var worker = session.Worker;
                if (worker is not null) await worker.WaitAsync(TimeSpan.FromSeconds(10)).ConfigureAwait(false);
            }
            catch
            {
                // timeout or fault: fall through and forget the session
            }
            Forget(session);
        });
    }

    // ------------------------------------------------------------------ ffmpeg

    private static Process StartFfmpeg(string ffmpeg, string args)
    {
        var process = Process.Start(new ProcessStartInfo(ffmpeg, args)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        });
        return process ?? throw new InvalidOperationException("ffmpeg did not start");
    }

    /// <summary>`-q:v` is inverted (2 = best, 31 = worst); map 1-100 onto it.</summary>
    private static int QualityToQscale(int quality) => Math.Clamp(31 - (int)Math.Round(quality * 0.38), 2, 31);

    /// <summary>Never upscales: min(maxWidth, input width), height keeps aspect and stays even.</summary>
    private static string ScaleFilter(int maxWidth) => $"-vf scale='min({maxWidth},iw)':-2 ";

    private static string GdiGrabArgs(Session s) =>
        $"-hide_banner -loglevel warning -f gdigrab -framerate {s.Fps} -i desktop " +
        $"{ScaleFilter(s.MaxWidth)}-q:v {QualityToQscale(s.Quality)} -f image2pipe -c:v mjpeg -";

    private static string DshowArgs(string device, Session s) =>
        $"-hide_banner -loglevel warning -f dshow -framerate {s.Fps} -i video=\"{device}\" " +
        $"{ScaleFilter(s.MaxWidth)}-q:v {QualityToQscale(s.Quality)} -f image2pipe -c:v mjpeg -";

    /// <summary>Reads the ffmpeg stdout pipe and pushes every complete JPEG.</summary>
    private void PumpFfmpeg(Session s)
    {
        var process = s.Process!;
        string? stderrTail = null;
        var stderrTask = Task.Run(() =>
        {
            try
            {
                var lines = new Queue<string>();
                string? line;
                while ((line = process.StandardError.ReadLine()) is not null)
                {
                    if (line.Trim().Length == 0) continue;
                    lines.Enqueue(line);
                    while (lines.Count > 4) lines.Dequeue();
                    stderrTail = string.Join(" | ", lines);
                }
            }
            catch
            {
                // pipe closed with the process
            }
        });

        string? error = null;
        var splitter = new JpegSplitter();
        var buffer = new byte[256 * 1024];
        try
        {
            var stdout = process.StandardOutput.BaseStream;
            while (true)
            {
                var read = stdout.Read(buffer, 0, buffer.Length);
                if (read <= 0) break;
                if (s.Cts.IsCancellationRequested) break;
                foreach (var frame in splitter.Feed(buffer, read))
                {
                    DispatchFrame(s, frame);
                }
            }
        }
        catch (Exception ex)
        {
            if (!s.Cts.IsCancellationRequested) error = $"capture read failed: {ex.Message}";
        }

        try { process.WaitForExit(2_000); } catch { /* ignore */ }
        try { stderrTask.Wait(500); } catch { /* ignore */ }
        try { process.Dispose(); } catch { /* ignore */ }

        if (!s.Cts.IsCancellationRequested && error is null)
        {
            var exit = SafeExitCode(process);
            error = stderrTail is null
                ? $"the capture process ended (ffmpeg exit {exit})"
                : $"the capture process ended (ffmpeg exit {exit}): {stderrTail}";
        }
        FinishWorker(s, error);
    }

    private static int SafeExitCode(Process process)
    {
        try { return process.ExitCode; } catch { return -1; }
    }

    // --------------------------------------------------------------- GDI fallback

    /// <summary>ffmpeg-less screen capture: slower, but keeps the stream alive.</summary>
    private void GdiLoop(Session s)
    {
        string? error = null;
        try
        {
            var fps = Math.Clamp(Math.Min(s.Fps, 10), 1, 10);
            var perMs = Math.Max(1, 1000 / fps);
            var area = ScreenGeometry.Virtual();
            if (area.Width <= 0 || area.Height <= 0) throw new InvalidOperationException("no screen to capture");
            var stopwatch = Stopwatch.StartNew();
            long i = 0;
            while (!s.Cts.IsCancellationRequested)
            {
                using (var full = new Bitmap(area.Width, area.Height, PixelFormat.Format24bppRgb))
                {
                    using (var graphics = Graphics.FromImage(full))
                    {
                        graphics.CopyFromScreen(area.X, area.Y, 0, 0, full.Size, CopyPixelOperation.SourceCopy);
                    }
                    using var frame = Downscale(full, s.MaxWidth);
                    var jpeg = EncodeJpeg(frame, s.Quality);
                    if (jpeg.Length > Protocol.MaxStreamFrameBytes) jpeg = EncodeJpeg(frame, 35);
                    DispatchFrame(s, jpeg);
                }
                var target = (i + 1) * perMs;
                var elapsed = stopwatch.ElapsedMilliseconds;
                if (elapsed < target) Thread.Sleep((int)Math.Min(target - elapsed, perMs));
                i++;
            }
        }
        catch (Exception ex)
        {
            error = $"capture loop failed: {ex.Message}";
        }
        if (s.Cts.IsCancellationRequested) error = null;
        FinishWorker(s, error);
    }

    private static Bitmap Downscale(Bitmap source, int maxWidth)
    {
        if (source.Width <= maxWidth) return source;
        var width = maxWidth;
        var height = Math.Max(2, source.Height * maxWidth / source.Width);
        var scaled = new Bitmap(width, height, PixelFormat.Format24bppRgb);
        using (var graphics = Graphics.FromImage(scaled))
        {
            graphics.InterpolationMode = InterpolationMode.Bilinear;
            graphics.DrawImage(source, new Rectangle(0, 0, width, height));
        }
        return scaled;
    }

    private static byte[] EncodeJpeg(Bitmap bitmap, int quality)
    {
        var codec = ImageCodecInfo.GetImageEncoders().First(c => c.FormatID == ImageFormat.Jpeg.Guid);
        using var parameters = new EncoderParameters(1);
        parameters.Param[0] = new EncoderParameter(Encoder.Quality, (long)quality);
        using var stream = new MemoryStream();
        bitmap.Save(stream, codec, parameters);
        return stream.ToArray();
    }

    // ------------------------------------------------------------------ plumbing

    private void DispatchFrame(Session s, byte[] frame)
    {
        if (frame.Length == 0) return;
        if (frame.Length > Protocol.MaxStreamFrameBytes)
        {
            s.Dropped++;
            if (s.Dropped % 25 == 1)
            {
                Log.Warn("stream frame dropped (too large)", new { streamId = s.StreamId, bytes = frame.Length });
            }
            return;
        }
        var seq = s.Sent;
        s.Sent = seq + 1;
        Send(new StreamFrameMsg
        {
            StreamId = s.StreamId,
            Seq = seq,
            Data = Convert.ToBase64String(frame),
            Bytes = frame.Length,
        });
    }

    private void Send(object msg)
    {
        try
        {
            _ = _send(msg);
        }
        catch (Exception ex)
        {
            Log.Debug("stream send failed", new { error = ex.Message });
        }
    }

    private void Fail(Session session, string error)
    {
        Forget(session);
        Send(new StreamStateMsg { StreamId = session.StreamId, Status = "error", Error = error });
        Log.Warn("stream capture failed to start", new { streamId = session.StreamId, error });
    }

    private void FinishWorker(Session session, string? error)
    {
        Forget(session);
        if (error is not null)
        {
            Send(new StreamStateMsg { StreamId = session.StreamId, Status = "error", Error = error });
        }
        try { session.Cts.Dispose(); } catch { /* already disposed */ }
        Log.Info("stream capture ended", new
        {
            streamId = session.StreamId,
            frames = session.Sent,
            dropped = session.Dropped,
            error,
        });
    }

    private void Forget(Session session)
    {
        lock (_gate)
        {
            if (_sessions.TryGetValue(session.StreamId, out var current) && ReferenceEquals(current, session))
            {
                _sessions.Remove(session.StreamId);
            }
        }
    }

    private sealed class Session
    {
        public required string StreamId { get; init; }
        public required string Source { get; init; }
        public required int Fps { get; init; }
        public required int Quality { get; init; }
        public required int MaxWidth { get; init; }
        public readonly CancellationTokenSource Cts = new();
        public Process? Process;
        public Task? Worker;
        /// <summary>Frames pushed (also the next sequence number).</summary>
        public long Sent;
        public long Dropped;
    }

    /// <summary>
    /// Splits concatenated JPEGs out of the ffmpeg image2pipe stream. The
    /// buffer keeps the tail of a partial frame for the next chunk; JPEG bytes
    /// never contain a bare FF D9 outside the end-of-image marker, so scanning
    /// for it is safe.
    /// </summary>
    private sealed class JpegSplitter
    {
        private readonly MemoryStream _pending = new();

        public List<byte[]> Feed(byte[] data, int count)
        {
            _pending.Write(data, 0, count);
            var buffer = _pending.GetBuffer();
            var length = (int)_pending.Length;
            var frames = new List<byte[]>();
            var consumed = 0;

            while (true)
            {
                var soi = FindMarker(buffer, consumed, length, 0xD8);
                if (soi < 0)
                {
                    // Nothing starts a frame yet: keep only a trailing FF (it
                    // may be the first byte of a marker split across chunks).
                    consumed = length > 0 && buffer[length - 1] == 0xFF ? length - 1 : length;
                    break;
                }
                var eoi = FindMarker(buffer, soi + 2, length, 0xD9);
                if (eoi < 0)
                {
                    consumed = soi;
                    break;
                }
                var frame = new byte[eoi + 2 - soi];
                Buffer.BlockCopy(buffer, soi, frame, 0, frame.Length);
                frames.Add(frame);
                consumed = eoi + 2;
            }

            var remaining = length - consumed;
            _pending.SetLength(0);
            if (remaining > 0) _pending.Write(buffer, consumed, remaining);
            return frames;
        }

        private static int FindMarker(byte[] buffer, int start, int length, byte second)
        {
            for (var i = Math.Max(0, start); i < length - 1; i++)
            {
                if (buffer[i] == 0xFF && buffer[i + 1] == second) return i;
            }
            return -1;
        }
    }
}
