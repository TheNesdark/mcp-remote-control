using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Text.Json;

namespace Mrc.Agent;

/// <summary>
/// camera: capture a single JPEG frame from the first available webcam using
/// ffmpeg (dshow on Windows). Returns base64 chunks like screenshot, so the
/// hub can relay it as an MJPEG stream. Requires ffmpeg on PATH (or next to
/// the agent) and a working video input device.
/// </summary>
public static class Camera
{
    public static Task<JobOutcome> JobCapture(JsonElement p, JobContext ctx, CancellationToken ct)
    {
        var format = (Fs.ReadString(p, "format") ?? "jpeg").ToLowerInvariant();
        if (format != "png" && format != "jpeg") format = "jpeg";
        var quality = Math.Clamp(Fs.ReadInt(p, "quality") ?? 70, 1, 100);

        var ffmpeg = FindFfmpeg();
        if (ffmpeg is null)
            return Task.FromResult(JobOutcome.Failure("camera failed: ffmpeg not found"));

        var device = FindFirstVideoDevice(ffmpeg);
        if (device is null)
            return Task.FromResult(JobOutcome.Failure("camera failed: no video input device found"));

        var tmp = Path.Combine(Path.GetTempPath(), $"mrc-cam-{Guid.NewGuid():N}.jpg");
        try
        {
            var args = $"-y -f dshow -i video=\"{device}\" -frames:v 1 -q:v {Math.Max(2, 31 - quality / 4)} \"{tmp}\"";
            using var proc = Process.Start(new ProcessStartInfo(ffmpeg, args)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardError = true,
            });
            if (proc is null) return Task.FromResult(JobOutcome.Failure("camera failed: ffmpeg did not start"));
            proc.WaitForExit(15_000);
            if (!proc.HasExited) { try { proc.Kill(); } catch { } return Task.FromResult(JobOutcome.Failure("camera failed: ffmpeg timeout")); }
            if (proc.ExitCode != 0 || !File.Exists(tmp))
                return Task.FromResult(JobOutcome.Failure($"camera failed: ffmpeg exited {proc.ExitCode}"));

            var bytes = File.ReadAllBytes(tmp);
            if (bytes.Length == 0) return Task.FromResult(JobOutcome.Failure("camera failed: empty capture"));

            // Re-encode through GDI so format/quality are honored consistently.
            using var ms = new MemoryStream(bytes);
            using var bmp = new Bitmap(ms);
            using var outMs = new MemoryStream();
            if (format == "jpeg")
            {
                var codec = ImageCodecInfo.GetImageEncoders().First(c => c.FormatID == ImageFormat.Jpeg.Guid);
                using var parameters = new EncoderParameters(1);
                parameters.Param[0] = new EncoderParameter(Encoder.Quality, quality);
                bmp.Save(outMs, codec, parameters);
            }
            else
            {
                bmp.Save(outMs, ImageFormat.Png);
            }
            var final = outMs.ToArray();

            var base64 = Convert.ToBase64String(final);
            for (var offset = 0; offset < base64.Length; offset += Protocol.ScreenshotChunkChars)
            {
                var take = Math.Min(Protocol.ScreenshotChunkChars, base64.Length - offset);
                ctx.Stdout(base64.Substring(offset, take), "base64");
            }

            return Task.FromResult(JobOutcome.Success(new Dictionary<string, object?>
            {
                ["format"] = format,
                ["bytes"] = final.Length,
                ["sha256"] = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(final)).ToLowerInvariant(),
                ["width"] = bmp.Width,
                ["height"] = bmp.Height,
            }));
        }
        catch (Exception ex)
        {
            return Task.FromResult(JobOutcome.Failure($"camera failed: {ex.Message}"));
        }
        finally
        {
            try { File.Delete(tmp); } catch { }
        }
    }

    internal static string? FindFfmpeg()
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

    internal static string? FindFirstVideoDevice(string ffmpeg)
    {
        try
        {
            using var proc = Process.Start(new ProcessStartInfo(ffmpeg, "-list_devices true -f dshow -i dummy")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardError = true,
            });
            if (proc is null) return null;
            var err = proc.StandardError.ReadToEnd();
            proc.WaitForExit(10_000);
            // Parse lines like:  [dshow @ ...] "Integrated Camera" (video)
            foreach (var line in err.Split('\n'))
            {
                if (!line.Contains("(video)")) continue;
                var start = line.IndexOf('"');
                var end = line.LastIndexOf('"');
                if (start >= 0 && end > start)
                    return line.Substring(start + 1, end - start - 1);
            }
        }
        catch { }
        return null;
    }
}
