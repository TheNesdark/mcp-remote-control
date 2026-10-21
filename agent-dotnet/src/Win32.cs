using System.Runtime.InteropServices;
using System.Text;

namespace Mrc.Agent;

/// <summary>
/// Plain Win32 window lookups.
///
/// UIA3 is the right tool to describe a control, but enumerating the desktop
/// while a Java application is open takes seconds: the MSAA proxy of Windows
/// talks to the Java Access Bridge for Swing windows, and that round trip is
/// slow. Listing windows and finding "the window of this process" therefore
/// go straight to Windows, which is instant and never touches the bridge.
/// </summary>
public static class Win32
{
    public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hwnd, out int pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left, Top, Right, Bottom;
    }

    public sealed record WindowInfo(
        long Hwnd, int Pid, string Process, string Class, string Title,
        bool Visible, int X, int Y, int Width, int Height);

    /// <summary>Every top level window of the desktop, in z order.</summary>
    public static List<WindowInfo> Enumerate()
    {
        var list = new List<WindowInfo>();
        EnumWindows((hwnd, _) =>
        {
            try
            {
                GetWindowThreadProcessId(hwnd, out var pid);
                var title = new StringBuilder(512);
                GetWindowText(hwnd, title, 512);
                var cls = new StringBuilder(256);
                GetClassName(hwnd, cls, 256);
                GetWindowRect(hwnd, out var rect);
                list.Add(new WindowInfo(
                    hwnd.ToInt64(), pid, ProcessName(pid), cls.ToString(), title.ToString(),
                    IsWindowVisible(hwnd), rect.Left, rect.Top,
                    rect.Right - rect.Left, rect.Bottom - rect.Top));
            }
            catch (Exception)
            {
                // a window can vanish while it is being described
            }
            return true;
        }, IntPtr.Zero);
        return list;
    }

    /// <summary>The biggest visible top level window of a process.</summary>
    public static WindowInfo? BiggestForPid(int pid)
    {
        WindowInfo? best = null;
        foreach (var w in Enumerate())
        {
            if (w.Pid != pid || !w.Visible) continue;
            if (w.Width < 1 || w.Height < 1) continue;
            if (best is null || (long)w.Width * w.Height > (long)best.Width * best.Height) best = w;
        }
        return best;
    }

    /// <summary>The class name of a window ("SunAwtDialog", "Shell_TrayWnd"...).</summary>
    public static string ClassOf(long hwnd)
    {
        try
        {
            var cls = new StringBuilder(256);
            GetClassName(new IntPtr(hwnd), cls, 256);
            return cls.ToString();
        }
        catch (Exception)
        {
            return "";
        }
    }

    /// <summary>Process id of the window's owner (0 when it is gone).</summary>
    public static int PidOf(long hwnd)
    {
        try
        {
            GetWindowThreadProcessId(new IntPtr(hwnd), out var pid);
            return (int)pid;
        }
        catch (Exception)
        {
            return 0;
        }
    }

    /// <summary>The process that owns a window ("java", "explorer"...).</summary>
    public static string ProcessOf(long hwnd)
    {
        try
        {
            GetWindowThreadProcessId(new IntPtr(hwnd), out var pid);
            return ProcessName(pid);
        }
        catch (Exception)
        {
            return "";
        }
    }

    /// <summary>True for a Java (AWT/Swing) window.</summary>
    public static bool IsJavaWindow(long hwnd) =>
        ClassOf(hwnd).StartsWith("SunAwt", StringComparison.OrdinalIgnoreCase);

    private static string ProcessName(int pid)
    {
        try { return System.Diagnostics.Process.GetProcessById(pid).ProcessName; }
        catch (Exception) { return ""; }
    }
}
