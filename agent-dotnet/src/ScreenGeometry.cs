using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Mrc.Agent;

/// <summary>
/// Where the screen is and how the pixels of an application map to it.
///
/// Two things go wrong without this: the recorder and the screenshot capture
/// different areas (the recorder takes the primary screen from (0,0), the
/// screenshot takes the whole virtual desktop, whose origin can be negative),
/// and an application without a per-monitor DPI manifest (a Java application,
/// for example) reports its coordinates in logical pixels while the agent
/// works in physical ones.
/// </summary>
public static class ScreenGeometry
{
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] private static extern bool GetDpiForWindow(IntPtr hwnd, out uint dpi);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left, Top, Right, Bottom;
    }

    public readonly record struct Area(int X, int Y, int Width, int Height)
    {
        public int Right => X + Width;
        public int Bottom => Y + Height;
    }

    /// <summary>The whole desktop, all monitors. The origin can be negative.</summary>
    public static Area Virtual()
    {
        var b = SystemInformation.VirtualScreen;
        return new Area(b.Left, b.Top, b.Width, b.Height);
    }

    /// <summary>The primary monitor.</summary>
    public static Area Primary()
    {
        var b = Screen.PrimaryScreen?.Bounds ?? SystemInformation.VirtualScreen;
        return new Area(b.Left, b.Top, b.Width, b.Height);
    }

    /// <summary>The physical pixels of a window.</summary>
    public static Area RectOf(long hwnd)
    {
        try
        {
            if (GetWindowRect(new IntPtr(hwnd), out var r))
                return new Area(r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top);
        }
        catch (Exception)
        {
            // fall through
        }
        return new Area(0, 0, 0, 0);
    }

    /// <summary>
    /// How a window's coordinates are scaled against the physical ones.
    ///
    /// An application without a per-monitor DPI manifest (every Java
    /// application) is virtualized by Windows: it works in logical pixels
    /// while the agent works in physical ones. The factor is the ratio
    /// between the physical size of the window and the size the application
    /// believes it has; it is 1 when both agree.
    /// </summary>
    public static double ScaleOf(long hwnd, int logicalWidth, int logicalHeight)
    {
        if (logicalWidth <= 0 || logicalHeight <= 0) return 1.0;
        var physical = RectOf(hwnd);
        if (physical.Width <= 0 || physical.Height <= 0) return 1.0;
        var byWidth = (double)physical.Width / logicalWidth;
        var byHeight = (double)physical.Height / logicalHeight;
        // A window that is not maximized does not fill the screen: the size
        // ratio is still the right one, but round the noise away.
        var scale = Math.Abs(byWidth - byHeight) < 0.02 ? byWidth : byWidth;
        if (scale <= 0.1 || scale > 4.0) return 1.0;
        return Math.Round(scale, 3);
    }

    /// <summary>The DPI of a window (96 is the Windows default).</summary>
    public static uint DpiOf(long hwnd)
    {
        try
        {
            if (GetDpiForWindow(new IntPtr(hwnd), out var dpi) && dpi > 0) return dpi;
        }
        catch (Exception)
        {
            // fall through
        }
        return 96;
    }
}
