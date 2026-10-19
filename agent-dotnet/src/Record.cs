using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace Mrc.Agent;

/// <summary>
/// record / record.status: capture the primary monitor to a clip. This runs
/// directly in the agent (no sidecar): frames go to temp JPEGs, then ffmpeg
/// encodes MP4/h264 when it is available, otherwise the built-in Motion-JPEG
/// AVI writer is used.
///
/// Long clips use the split mode: `record` returns as soon as the frames are
/// captured and hands the encoding to ffmpeg in the background, and
/// `record.status` polls it. That keeps every hub job result short, so a proxy
/// in front of the hub's HTTP face never sees an idle stream.
/// </summary>
public static class Record
{
    public const int SplitMinSec = 15;
    private const int PollIntervalMs = 1_500;
    private const int PollMaxMs = 300_000;

    private static readonly object StateGate = new();
    private static string _frameDir = "";
    private static string _outPath = "";
    private static string _encoder = "";
    private static string _error = "";
    private static int _frames;
    private static int _fps;
    private static int _width;
    private static int _height;
    private static bool _done;
    private static Process? _encoderProcess;

    public static async Task<JobOutcome> JobRecord(JsonElement p, JobContext ctx, CancellationToken ct)
    {
        var seconds = Math.Clamp(Fs.ReadInt(p, "duration_sec") ?? 10, 1, 60);
        var fps = Math.Clamp(Fs.ReadInt(p, "fps") ?? 4, 1, 10);

        var width = ScreenWidth();
        var height = ScreenHeight();
        var ffmpeg = FindFfmpeg();
        var split = seconds > SplitMinSec;
        var frameDir = Path.Combine(Path.GetTempPath(), $"mrc-rec-frames-{Guid.NewGuid():N}");
        Directory.CreateDirectory(frameDir);
        var outPath = Path.Combine(Path.GetTempPath(),
            $"mrc-rec-{DateTime.Now:yyyyMMdd-HHmmss}{(ffmpeg is not null ? ".mp4" : ".avi")}");

        var frameCount = await Task.Run(() => CaptureFrames(frameDir, seconds, fps, width, height, ct), ct).ConfigureAwait(false);
        if (frameCount == 0) return JobOutcome.Failure("captured zero frames");

        if (!split)
        {
            try
            {
                if (ffmpeg is not null)
                {
                    await RunFfmpegAsync(ffmpeg, frameDir, outPath, fps, ct).ConfigureAwait(false);
                    return JobOutcome.Success(Meta(outPath, frameCount, fps, seconds, width, height, "ffmpeg/h264"));
                }
                WriteMjpegAvi(outPath, frameDir, frameCount, width, height, fps);
                return JobOutcome.Success(Meta(outPath, frameCount, fps, seconds, width, height, "mjpeg-avi"));
            }
            finally
            {
                TryDeleteDir(frameDir);
            }
        }

        lock (StateGate)
        {
            _frameDir = frameDir;
            _outPath = outPath;
            _frames = frameCount;
            _fps = fps;
            _width = width;
            _height = height;
            _encoder = ffmpeg is not null ? "ffmpeg/h264" : "mjpeg-avi";
            _error = "";
            _done = false;
            _encoderProcess = null;
            if (ffmpeg is not null)
            {
                try
                {
                    _encoderProcess = StartFfmpeg(ffmpeg, frameDir, outPath, fps);
                }
                catch (Exception ex)
                {
                    _error = ex.Message;
                }
            }
        }

        return JobOutcome.Success(new Dictionary<string, object?>
        {
            ["ok"] = true,
            ["status"] = "encoding",
            ["done"] = false,
            ["path"] = outPath,
            ["bytes"] = 0,
            ["frames"] = frameCount,
            ["fps"] = fps,
            ["duration_sec"] = seconds,
            ["resolution"] = $"{width}x{height}",
            ["encoder"] = ffmpeg is not null ? "ffmpeg/h264" : "mjpeg-avi",
        });
    }

    public static Task<JobOutcome> JobStatus(JsonElement p, JobContext ctx, CancellationToken ct)
    {
        string frameDir, outPath, encoder, error;
        int frames, fps, width, height;
        bool done;
        Process? process;
        lock (StateGate)
        {
            if (_frameDir.Length == 0) return Task.FromResult(JobOutcome.Failure("no split recording to report on"));
            frameDir = _frameDir;
            outPath = _outPath;
            encoder = _encoder;
            error = _error;
            frames = _frames;
            fps = _fps;
            width = _width;
            height = _height;
            done = _done;
            process = _encoderProcess;
        }

        if (error.Length > 0)
            return Task.FromResult(JobOutcome.Failure(error));

        if (!done && encoder == "mjpeg-avi")
        {
            try
            {
                WriteMjpegAvi(outPath, frameDir, frames, width, height, fps);
                lock (StateGate) { _done = true; _frameDir = ""; }
                done = true;
            }
            catch (Exception ex)
            {
                lock (StateGate) _error = ex.Message;
                return Task.FromResult(JobOutcome.Failure(ex.Message));
            }
            finally
            {
                TryDeleteDir(frameDir);
            }
        }
        else if (!done && process is not null)
        {
            try
            {
                if (process.HasExited)
                {
                    var code = process.ExitCode;
                    process.Dispose();
                    lock (StateGate) _encoderProcess = null;
                    if (code != 0)
                    {
                        lock (StateGate) _error = $"ffmpeg exited {code}";
                        return Task.FromResult(JobOutcome.Failure($"ffmpeg exited {code}"));
                    }
                    lock (StateGate) { _done = true; _frameDir = ""; }
                    done = true;
                    TryDeleteDir(frameDir);
                }
            }
            catch (Exception)
            {
                // still running
            }
        }

        var bytes = 0L;
        if (done && File.Exists(outPath)) bytes = new FileInfo(outPath).Length;
        return Task.FromResult(JobOutcome.Success(new Dictionary<string, object?>
        {
            ["ok"] = true,
            ["status"] = done ? "done" : "encoding",
            ["done"] = done,
            ["path"] = outPath,
            ["bytes"] = bytes,
            ["frames"] = frames,
            ["fps"] = fps,
            ["resolution"] = $"{width}x{height}",
            ["encoder"] = encoder,
        }));
    }

    // ------------------------------------------------------------ frame capture

    private static int CaptureFrames(string frameDir, int seconds, int fps, int width, int height, CancellationToken ct)
    {
        var total = seconds * fps;
        var perMs = Math.Max(1, 1000 / fps);
        var budget = (long)seconds * 1000;
        var stopwatch = Stopwatch.StartNew();
        var captured = 0;
        for (var i = 0; i < total && !ct.IsCancellationRequested; i++)
        {
            using (var frame = new Bitmap(width, height, PixelFormat.Format24bppRgb))
            {
                using (var graphics = Graphics.FromImage(frame))
                {
                    graphics.CopyFromScreen(0, 0, 0, 0, frame.Size, CopyPixelOperation.SourceCopy);
                }
                frame.Save(Path.Combine(frameDir, i.ToString("D5") + ".jpg"), ImageFormat.Jpeg);
            }
            captured++;
            var elapsed = stopwatch.ElapsedMilliseconds;
            var target = (long)(i + 1) * perMs;
            if (elapsed < target && target < budget) Thread.Sleep((int)(target - elapsed));
            else if (elapsed >= budget) break;
        }
        return captured;
    }

    // ------------------------------------------------------------------ ffmpeg

    private static string? FindFfmpeg()
    {
        var local = Path.Combine(AppContext.BaseDirectory, "ffmpeg.exe");
        if (File.Exists(local)) return local;
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
        {
            if (dir.Trim().Length == 0) continue;
            var candidate = Path.Combine(dir.Trim(), "ffmpeg.exe");
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }

    private static Process StartFfmpeg(string ffmpeg, string frameDir, string outPath, int fps)
    {
        var args = $"-y -framerate {fps} -start_number 0 -i \"{Path.Combine(frameDir, "%05d.jpg")}\" " +
                   $"-c:v libx264 -pix_fmt yuv420p -crf 23 -movflags +faststart \"{outPath}\"";
        var process = Process.Start(new ProcessStartInfo(ffmpeg, args)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
        });
        return process ?? throw new InvalidOperationException("ffmpeg did not start");
    }

    private static async Task RunFfmpegAsync(string ffmpeg, string frameDir, string outPath, int fps, CancellationToken ct)
    {
        using var process = StartFfmpeg(ffmpeg, frameDir, outPath, fps);
        await process.WaitForExitAsync(ct).ConfigureAwait(false);
        if (process.ExitCode != 0) throw new InvalidOperationException($"ffmpeg exited {process.ExitCode}");
    }

    // ----------------------------------------------------------- MJPEG AVI sink

    /// <summary>
    /// Minimal Motion-JPEG AVI writer (RIFF): no external dependency, which is
    /// what a machine without ffmpeg relies on. VLC plays the result directly.
    /// </summary>
    private static void WriteMjpegAvi(string outPath, string frameDir, int frameCount, int width, int height, int fps)
    {
        var frames = Directory.EnumerateFiles(frameDir, "*.jpg").OrderBy(f => f, StringComparer.Ordinal).Take(frameCount).ToList();
        using var stream = new FileStream(outPath, FileMode.Create, FileAccess.Write);
        using var writer = new BinaryWriter(stream);

        var moviPayload = new MemoryStream();
        var index = new List<(string Id, uint Flags, uint Offset, uint Size)>();
        foreach (var frame in frames)
        {
            var bytes = File.ReadAllBytes(frame);
            var offset = (uint)moviPayload.Position + 4;
            moviPayload.Write(System.Text.Encoding.ASCII.GetBytes("00dc"));
            moviPayload.Write(bytes);
            if (bytes.Length % 2 == 1) moviPayload.Write(new byte[] { 0 }, 0, 1);
            index.Add(("00dc", 0x10, offset, (uint)bytes.Length));
        }
        moviPayload.Position = 0;

        var maxBytesPerSec = width * height * 3 * fps;
        writer.Write(System.Text.Encoding.ASCII.GetBytes("RIFF"));
        var riffSizePos = stream.Position;
        writer.Write(0);
        writer.Write(System.Text.Encoding.ASCII.GetBytes("AVI "));

        writer.Write(System.Text.Encoding.ASCII.GetBytes("LIST"));
        var hdrlSizePos = stream.Position;
        writer.Write(0);
        writer.Write(System.Text.Encoding.ASCII.GetBytes("hdrl"));

        writer.Write(System.Text.Encoding.ASCII.GetBytes("avih"));
        writer.Write(56);
        writer.Write(1_000_000 / fps);
        writer.Write(maxBytesPerSec);
        writer.Write(0);
        writer.Write(0x10);
        writer.Write(frameCount);
        writer.Write(0);
        writer.Write(1);
        writer.Write(moviPayload.Length);
        writer.Write(width);
        writer.Write(height);
        writer.Write(0);
        writer.Write(0);
        writer.Write(0);
        writer.Write(0);

        writer.Write(System.Text.Encoding.ASCII.GetBytes("LIST"));
        var strlSizePos = stream.Position;
        writer.Write(0);
        writer.Write(System.Text.Encoding.ASCII.GetBytes("strl"));
        writer.Write(System.Text.Encoding.ASCII.GetBytes("strh"));
        writer.Write(56);
        writer.Write(System.Text.Encoding.ASCII.GetBytes("vids"));
        writer.Write(System.Text.Encoding.ASCII.GetBytes("MJPG"));
        writer.Write(0);
        writer.Write(0);
        writer.Write(0);
        writer.Write(1);
        writer.Write(fps);
        writer.Write(0);
        writer.Write(frameCount);
        writer.Write(moviPayload.Length);
        writer.Write(-1);
        writer.Write(0);
        writer.Write(0);
        writer.Write(0);
        writer.Write((short)0);
        writer.Write((short)0);
        writer.Write((short)width);
        writer.Write((short)height);
        writer.Write(System.Text.Encoding.ASCII.GetBytes("strf"));
        writer.Write(40);
        writer.Write(40);
        writer.Write(width);
        writer.Write(height);
        writer.Write((short)1);
        writer.Write((short)24);
        writer.Write(System.Text.Encoding.ASCII.GetBytes("MJPG"));
        writer.Write(width * height * 3);
        writer.Write(0);
        writer.Write(0);
        writer.Write(0);
        writer.Write(0);

        var strlEnd = stream.Position;
        writer.Write(System.Text.Encoding.ASCII.GetBytes("LIST"));
        var moviSizePos = stream.Position;
        writer.Write(0);
        writer.Write(System.Text.Encoding.ASCII.GetBytes("movi"));
        moviPayload.CopyTo(stream);
        var moviEnd = stream.Position;

        writer.Write(System.Text.Encoding.ASCII.GetBytes("idx1"));
        writer.Write(index.Count * 16);
        foreach (var (id, flags, offset, size) in index)
        {
            writer.Write(System.Text.Encoding.ASCII.GetBytes(id));
            writer.Write(flags);
            writer.Write(offset);
            writer.Write(size);
        }
        var end = stream.Position;

        PatchSize(writer, riffSizePos, (uint)(end - riffSizePos - 4));
        PatchSize(writer, hdrlSizePos, (uint)(strlSizePos - hdrlSizePos - 4 + 4 + (strlEnd - strlSizePos)));
        PatchSize(writer, strlSizePos, (uint)(strlEnd - strlSizePos - 4));
        PatchSize(writer, moviSizePos, (uint)(moviEnd - moviSizePos - 4));
    }

    private static void PatchSize(BinaryWriter writer, long position, uint value)
    {
        var current = writer.BaseStream.Position;
        writer.BaseStream.Position = position;
        writer.Write(value);
        writer.BaseStream.Position = current;
    }

    private static Dictionary<string, object?> Meta(string outPath, int frames, int fps, int seconds, int width, int height, string encoder) => new()
    {
        ["ok"] = true,
        ["status"] = "done",
        ["done"] = true,
        ["path"] = outPath,
        ["bytes"] = new FileInfo(outPath).Length,
        ["frames"] = frames,
        ["fps"] = fps,
        ["duration_sec"] = seconds,
        ["resolution"] = $"{width}x{height}",
        ["encoder"] = encoder,
    };

    private static void TryDeleteDir(string dir)
    {
        try
        {
            Directory.Delete(dir, true);
        }
        catch (Exception)
        {
            // best effort
        }
    }

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);

    private static int ScreenWidth() => GetSystemMetrics(0);
    private static int ScreenHeight() => GetSystemMetrics(1);
}
