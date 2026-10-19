using System.ComponentModel;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Mrc.Agent;

/// <summary>
/// screenshot: capture the primary screen (or one window) through GDI and
/// encode PNG/JPEG in memory, matching agent/src/screenshot.ts output:
/// base64 chunks of <=256 KiB characters, meta
/// {format, bytes, sha256, width, height}.
/// </summary>
public static class Screenshot
{
    public static Task<JobOutcome> JobCapture(System.Text.Json.JsonElement p, JobContext ctx, CancellationToken ct)
    {
        var format = (Fs.ReadString(p, "format") ?? "png").ToLowerInvariant();
        if (format != "png" && format != "jpeg") format = "png";
        var quality = Math.Clamp(Fs.ReadInt(p, "quality") ?? 80, 1, 100);

        byte[] bytes;
        int width;
        int height;
        try
        {
            (bytes, width, height) = Capture(format, quality);
        }
        catch (Exception ex)
        {
            return Task.FromResult(JobOutcome.Failure($"screenshot failed: {ex.Message}"));
        }
        if (bytes.Length == 0)
            return Task.FromResult(JobOutcome.Failure("screenshot failed: the capture produced no data"));
        if (bytes.Length > Protocol.MaxScreenshotBytes)
            return Task.FromResult(JobOutcome.Failure($"screenshot too large ({bytes.Length} bytes, max {Protocol.MaxScreenshotBytes})"));

        var base64 = Convert.ToBase64String(bytes);
        for (var offset = 0; offset < base64.Length; offset += Protocol.ScreenshotChunkChars)
        {
            var take = Math.Min(Protocol.ScreenshotChunkChars, base64.Length - offset);
            ctx.Stdout(base64.Substring(offset, take), "base64");
        }

        return Task.FromResult(JobOutcome.Success(new Dictionary<string, object?>
        {
            ["format"] = format,
            ["bytes"] = bytes.Length,
            ["sha256"] = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant(),
            ["width"] = width,
            ["height"] = height,
        }));
    }

    [SupportedOSPlatform("windows")]
    private static (byte[] Bytes, int Width, int Height) Capture(string format, int quality)
    {
        var bounds = SystemInformation.VirtualScreen;
        using var bitmap = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format24bppRgb);
        using (var graphics = Graphics.FromImage(bitmap))
        {
            graphics.CopyFromScreen(bounds.Left, bounds.Top, 0, 0, bitmap.Size, CopyPixelOperation.SourceCopy);
        }
        using var stream = new MemoryStream();
        if (format == "jpeg")
        {
            var codec = ImageCodecInfo.GetImageEncoders().First(c => c.FormatID == ImageFormat.Jpeg.Guid);
            using var parameters = new EncoderParameters(1);
            parameters.Param[0] = new EncoderParameter(Encoder.Quality, quality);
            bitmap.Save(stream, codec, parameters);
        }
        else
        {
            bitmap.Save(stream, ImageFormat.Png);
        }
        return (stream.ToArray(), bitmap.Width, bitmap.Height);
    }

    /// <summary>Captures the primary monitor (or the virtual screen) to a file.</summary>
    [SupportedOSPlatform("windows")]
    public static void CaptureScreen(string format, int quality, string path)
    {
        var (bytes, _, _) = Capture(format, quality);
        File.WriteAllBytes(path, bytes);
    }

    /// <summary>Captures a single window (its client area may be clipped by overlaps).</summary>
    [SupportedOSPlatform("windows")]
    public static void CaptureWindow(IntPtr hwnd, string format, int quality, string path)
    {
        var (bytes, _, _) = CaptureWindowBytes(hwnd, format, quality);
        File.WriteAllBytes(path, bytes);
    }

    /// <summary>Captures a single window and returns its encoded bytes.</summary>
    [SupportedOSPlatform("windows")]
    public static (byte[] Bytes, int Width, int Height) CaptureWindowBytes(IntPtr hwnd, string format, int quality)
    {
        if (!GetWindowRect(hwnd, out var rect)) throw new Win32Exception(Marshal.GetLastWin32Error());
        var width = rect.Right - rect.Left;
        var height = rect.Bottom - rect.Top;
        using var bitmap = new Bitmap(width, height, PixelFormat.Format24bppRgb);
        using (var graphics = Graphics.FromImage(bitmap))
        {
            var hdc = graphics.GetHdc();
            try
            {
                PrintWindow(hwnd, hdc, 0);
            }
            finally
            {
                graphics.ReleaseHdc(hdc);
            }
        }
        using var stream = new MemoryStream();
        bitmap.Save(stream, format == "jpeg" ? ImageFormat.Jpeg : ImageFormat.Png);
        return (stream.ToArray(), width, height);
    }

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out Rect lpRect);

    [DllImport("user32.dll")]
    private static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint flags);

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }
}
