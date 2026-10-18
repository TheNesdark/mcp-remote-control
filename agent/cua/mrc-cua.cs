// mrc-cua.cs — own CUA engine sidecar for mcp-remote-control (Windows, .NET 4.8).
// Compiled on the target machine with csc.exe by the agent (agent/src/cua.ts);
// no installer, no external driver. One-shot CLI semantics:
//
//   mrc-cua.exe <tool> --param value --param2 value
//
// It prints ONE JSON object on stdout: {"ok":true,...} or {"ok":false,"error":"..."}.
// Tools are parameterized by screen coordinates (window_id is the HWND in decimal)
// and intentionally stateless: element caching/token staleness problems the old
// driver had do not exist here — get_window_state returns bounds, click/scroll
// take absolute screen points.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Forms;

static class MrcCua
{
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int nIndex);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);

    const uint MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
    const uint MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
    const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040;
    const uint MOUSEEVENTF_WHEEL = 0x0800;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_UNICODE = 0x0004;

    // ---------------------------------------------------------------- struct
    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
    [StructLayout(LayoutKind.Explicit)]
    struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public INPUTUNION u; }

    static int g_count;

    static int Main(string[] args)
    {
        if (args.Length < 1) { Fail("usage: mrc-cua.exe <tool> [--param value ...]"); return 2; }
        string tool = args[0];
        Dictionary<string, string> p = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 1; i + 1 < args.Length; i += 2)
        {
            string key = args[i];
            if (key.StartsWith("--")) key = key.Substring(2);
            p[key] = args[i + 1];
        }
        try
        {
            string result;
            switch (tool.ToLowerInvariant())
            {
                case "version": result = "{\"ok\":true,\"version\":\"1.0\",\"engine\":\"csc/uiautomation\",\"platform\":\"windows\"}"; break;
                case "list_windows": result = CmdWindows(); break;
                case "get_window_state": result = CmdWindowState(p); break;
                case "click": result = CmdClick(p); break;
                case "type_text": result = CmdType(p); break;
                case "press_key": result = CmdKey(p); break;
                case "scroll": result = CmdScroll(p); break;
                case "screenshot": result = CmdShot(p); break;
                case "focus": result = CmdFocus(p); break;
                default: Fail("unknown tool '" + tool + "'"); return 2;
            }
            Emit(result);
            // Mirrored to a file when the caller asks for it: Bun (and other
            // pipe readers) can truncate large redirected stdout on Windows,
            // so the agent passes --out and reads the file instead.
            string outPath = Param(p, "out");
            if (outPath.Length > 0)
            {
                try { File.WriteAllBytes(outPath, Encoding.UTF8.GetBytes(result)); } catch { /* best effort */ }
            }
            return 0;
        }
        catch (Exception ex)
        {
            Fail(ex.GetType().Name + ": " + ex.Message);
            return 1;
        }
    }

    static void Fail(string error)
    {
        Emit("{\"ok\":false,\"error\":" + JsonStr(error) + "}");
    }

    /**
     * Writes the whole response as raw UTF-8 bytes to the redirected stdout.
     * Console.Out with a changed OutputEncoding drops the trailing byte under
     * .NET Framework when stdout is a pipe (observed live: the final `}` of the
     * JSON never reached the reader), so we bypass the console writer entirely.
     */
    static void Emit(string json)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(json);
        Stream stdout = Console.OpenStandardOutput();
        stdout.Write(bytes, 0, bytes.Length);
        stdout.Flush();
    }

    static string JsonStr(string value)
    {
        var sb = new StringBuilder();
        sb.Append('"');
        foreach (char c in value)
        {
            if (c == '"') sb.Append("\\\"");
            else if (c == '\\') sb.Append("\\\\");
            else if (c == '\n') sb.Append("\\n");
            else if (c == '\r') sb.Append("\\r");
            else if (c == '\t') sb.Append("\\t");
            else if (c < 32) sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        sb.Append('"');
        return sb.ToString();
    }

    static bool Flag(Dictionary<string, string> p, string key)
    {
        string v; return p.TryGetValue(key, out v) && (v == "1" || v == "true" || v == "yes");
    }

    static bool Have(Dictionary<string, string> p, string key)
    {
        string v; return p.TryGetValue(key, out v) && v.Length > 0;
    }

    // ------------------------------------------------------------- windows
    static void Windows(OnWindow onWindow)
    {
        var all = AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition);
        foreach (AutomationElement w in all)
        {
            AutomationElement.AutomationElementInformation c = w.Current;
            if (c.IsOffscreen) continue;
            if (c.NativeWindowHandle == 0) continue;
            onWindow(c);
        }
    }

    delegate void OnWindow(AutomationElement.AutomationElementInformation info);

    static AutomationElement FindTarget(Dictionary<string, string> p)
    {
        string wid = Have(p, "window_id") ? p["window_id"] : (Have(p, "hwnd") ? p["hwnd"] : null);
        if (wid != null)
        {
            IntPtr hwnd;
            try { hwnd = new IntPtr(long.Parse(wid)); } catch { throw new ArgumentException("invalid window_id '" + wid + "'"); }
            if (!IsWindow(hwnd)) throw new InvalidOperationException("window not found (stale window_id)");
            AutomationElement el = AutomationElement.FromHandle(hwnd);
            return el;
        }
        string pidStr = Have(p, "pid") ? p["pid"] : null;
        if (pidStr != null)
        {
            int pid;
            try { pid = int.Parse(pidStr); } catch { throw new ArgumentException("invalid pid '" + pidStr + "'"); }
            AutomationElement best = null; long bestArea = -1;
            var all = AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition);
            foreach (AutomationElement w in all)
            {
                AutomationElement.AutomationElementInformation c = w.Current;
                if (c.ProcessId != pid) continue;
                Rect r = c.BoundingRectangle;
                if (!RectFinite(r)) continue;
                long area = (long)r.Width * (long)r.Height;
                if (area > bestArea) { bestArea = area; best = w; }
            }
            if (best == null) throw new InvalidOperationException("no on-screen window for pid " + pid);
            return best;
        }
        throw new ArgumentException("targeting requires 'window_id' or 'pid'");
    }

    static string CmdWindows()
    {
        var sb = new StringBuilder();
        sb.Append("{\"ok\":true,\"windows\":[");
        bool first = true;
        Windows(delegate(AutomationElement.AutomationElementInformation c)
        {
            AppendWindow(sb, ref first, c);
        });
        sb.Append("]}");
        return sb.ToString();
    }

    static void AppendWindow(StringBuilder sb, ref bool first, AutomationElement.AutomationElementInformation c)
    {
        if (!first) sb.Append(",");
        first = false;
        Rect r = c.BoundingRectangle;
        sb.Append("{\"hwnd\":").Append(c.NativeWindowHandle)
          .Append(",\"pid\":").Append(c.ProcessId)
          .Append(",\"process\":").Append(JsonStr(ProcName(c.ProcessId)))
          .Append(",\"class\":").Append(JsonStr(c.ClassName == null ? "" : c.ClassName))
          .Append(",\"title\":").Append(JsonStr(c.Name == null ? "" : c.Name))
          .Append(",\"visible\":").Append(IsWindowVisible((IntPtr)c.NativeWindowHandle) ? "true" : "false")
          .Append(",\"bounds\":{\"x\":").Append(Num(r.X))
          .Append(",\"y\":").Append(Num(r.Y))
          .Append(",\"width\":").Append(Num(r.Width))
          .Append(",\"height\":").Append(Num(r.Height))
          .Append("}}"); // close bounds obj + close the window record
    }

    /** UIA hands out Infinity/NaN rects for invisible ghost windows (AnyDesk...). */
    static bool RectFinite(Rect r)
    {
        return !double.IsNaN(r.X) && !double.IsInfinity(r.X)
            && !double.IsNaN(r.Y) && !double.IsInfinity(r.Y)
            && !double.IsNaN(r.Width) && !double.IsInfinity(r.Width)
            && !double.IsNaN(r.Height) && !double.IsInfinity(r.Height);
    }

    static string Num(double v)
    {
        if (double.IsNaN(v) || double.IsInfinity(v)) return "0";
        return ((long)Math.Round(v)).ToString(System.Globalization.CultureInfo.InvariantCulture);
    }

    static string ProcName(int id)
    {
        try { return Process.GetProcessById(id).ProcessName; }
        catch { return "?"; }
    }

    // ------------------------------------------------------------- window state
    static string CmdWindowState(Dictionary<string, string> p)
    {
        AutomationElement target = FindTarget(p);
        AutomationElement.AutomationElementInformation c = target.Current;
        int max;
        if (!Have(p, "max_elements") || !int.TryParse(p["max_elements"], out max)) max = 80;
        if (max < 10) max = 10;

        var walker = TreeWalker.ControlViewWalker;
        g_count = 0;
        var lines = new List<string>();
        Walk(target, 0, walker, lines, max);
        var sb = new StringBuilder();
        sb.Append("{\"ok\":true,\"hwnd\":").Append(c.NativeWindowHandle);
        sb.Append(",\"pid\":").Append(c.ProcessId);
        sb.Append(",\"title\":").Append(JsonStr(c.Name == null ? "" : c.Name));
        sb.Append(",\"class\":").Append(JsonStr(c.ClassName == null ? "" : c.ClassName));
        Rect rc = c.BoundingRectangle;
        sb.Append(",\"bounds\":{\"x\":").Append(Num(rc.X));
        sb.Append(",\"y\":").Append(Num(rc.Y));
        sb.Append(",\"width\":").Append(Num(rc.Width));
        sb.Append(",\"height\":").Append(Num(rc.Height));
        sb.Append("}");
        sb.Append(",\"element_count\":").Append(g_count);
        sb.Append(",\"tree\":\"");
        EscapeInto(sb, string.Join("\n", lines.ToArray()));
        sb.Append("\"");
        if ((Flag(p, "include_screenshot") || Have(p, "screenshot_path")) && RectFinite(rc) && rc.Width > 1 && rc.Height > 1)
        {
            string path = Have(p, "screenshot_path") ? p["screenshot_path"] :
                Path.Combine(Path.GetTempPath(), "mrc-cua-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".png");
            ShotRect(new Rectangle((int)rc.X, (int)rc.Y, (int)rc.Width, (int)rc.Height), path);
            sb.Append(",\"screenshot_path\":").Append(JsonStr(path));
        }
        sb.Append("}");
        return sb.ToString();
    }

    static void EscapeInto(StringBuilder sb, string text)
    {
        foreach (char ch in text)
        {
            if (ch == '\\') sb.Append("\\\\");
            else if (ch == '"') sb.Append("\\\"");
            else if (ch == '\n') sb.Append("\\n");
            else if (ch == '\r') { }
            else if (ch < 32) sb.Append(' ');
            else sb.Append(ch);
        }
    }

    static string BoundsText(Rect r)
    {
        if (!RectFinite(r)) return "screen(?)";
        return string.Format(System.Globalization.CultureInfo.InvariantCulture, "screen({0:0},{1:0} {2:0}x{3:0})", r.X, r.Y, r.Width, r.Height);
    }

    static void Walk(AutomationElement el, int depth, TreeWalker walker, List<string> lines, int max)
    {
        if (depth > 6 || g_count >= max) return;
        AutomationElement.AutomationElementInformation c = el.Current;
        string role = c.ControlType.ProgrammaticName.Replace("ControlType.", "");
        string nm = c.Name == null ? "" : c.Name;
        if (nm.Length > 60) nm = nm.Substring(0, 60);
        string id = c.AutomationId == null ? "" : c.AutomationId; 
        if (id.Length > 50) id = id.Substring(0, 50);
        var lb = new StringBuilder();
        lb.Append(new string(' ', depth * 4));
        lb.Append("- [").Append(role).Append("] ");
        EscapeInto(lb, nm);
        if (id.Length > 0 && !id.Equals(nm, StringComparison.Ordinal))
        {
            lb.Append(" id=");
            EscapeInto(lb, id);
        }
        lb.Append(" pid=").Append(c.ProcessId);
        lb.Append(" ").Append(BoundsText(c.BoundingRectangle));
        lines.Add(lb.ToString());
        g_count++;
        AutomationElement ch = walker.GetFirstChild(el);
        while (ch != null && g_count < max)
        {
            Walk(ch, depth + 1, walker, lines, max);
            ch = walker.GetNextSibling(ch);
        }
    }

    // ------------------------------------------------------------- focus
    static IntPtr ResolveHwnd(Dictionary<string, string> p)
    {
        AutomationElement target = FindTarget(p);
        return (IntPtr)target.Current.NativeWindowHandle;
    }

    static bool StealFocus(IntPtr target)
    {
        if (target == IntPtr.Zero || !IsWindow(target)) return false;
        uint a, b, zero = 0;
        IntPtr before = GetForegroundWindow();
        if (before == target) return true;
        keybd_event(0x12, 0, 0, UIntPtr.Zero);
        keybd_event(0x12, 0, 2, UIntPtr.Zero);
        uint orig = 0;
        SystemParametersInfo(0x2000, 0, ref orig, 0);
        SystemParametersInfo(0x2001, 0, ref zero, 0);
        uint fgTid = GetWindowThreadProcessId(before, out a);
        uint tgtTid = GetWindowThreadProcessId(target, out b);
        uint mine = GetCurrentThreadId();
        bool a1 = AttachThreadInput(fgTid, mine, true);
        bool a2 = AttachThreadInput(tgtTid, mine, true);
        ShowWindow(target, 9);
        bool sfw = SetForegroundWindow(target);
        AttachThreadInput(fgTid, mine, false);
        AttachThreadInput(tgtTid, mine, false);
        SystemParametersInfo(0x2001, 0, ref orig, 0);
        System.Threading.Thread.Sleep(250);
        return GetForegroundWindow() == target && (a1 || a2 || sfw);
    }

    [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint uiAction, uint uiParam, ref uint pvParam, uint fWinIni);

    static string CmdFocus(Dictionary<string, string> p)
    {
        IntPtr hwnd = ResolveHwnd(p);
        bool ok = StealFocus(hwnd);
        if (!ok) throw new InvalidOperationException("foreground unavaiable: Windows refused the focus change for hwnd " + hwnd);
        return "{\"ok\":true,\"focused_hwnd\":" + hwnd.ToInt64() + "}";
    }

    // ------------------------------------------------------------- input
    static string CmdClick(Dictionary<string, string> p)
    {
        if (!Flag(p, "confirm")) throw new InvalidOperationException("click requires confirm=1");
        IntPtr hwnd = ResolveHwnd(p);
        if (!StealFocus(hwnd)) throw new InvalidOperationException("foreground unavaiable before click");
        int x, y;
        if (!int.TryParse(Param(p, "x"), out x) || !int.TryParse(Param(p, "y"), out y))
            throw new ArgumentException("click requires integer x and y (screen coordinates)");
        string button = Param(p, "button") == "right" ? "right" : (Param(p, "button") == "middle" ? "middle" : "left");
        bool dbl = Flag(p, "double_click");
        if (!SetCursorPos(x, y)) throw new InvalidOperationException("SetCursorPos failed");
        System.Threading.Thread.Sleep(60);
        uint down = button == "right" ? MOUSEEVENTF_RIGHTDOWN : button == "middle" ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_LEFTDOWN;
        uint up = button == "right" ? MOUSEEVENTF_RIGHTUP : button == "middle" ? MOUSEEVENTF_MIDDLEUP : MOUSEEVENTF_LEFTUP;
        if (dbl)
        {
            mouse_event(down, 0, 0, 0, UIntPtr.Zero); mouse_event(up, 0, 0, 0, UIntPtr.Zero);
            System.Threading.Thread.Sleep(60);
        }
        mouse_event(down, 0, 0, 0, UIntPtr.Zero);
        mouse_event(up, 0, 0, 0, UIntPtr.Zero);
        return "{\"ok\":true,\"clicked\":{\"x\":" + x + ",\"y\":" + y + ",\"button\":\"" + button + "\"}}";
    }

    static string CmdScroll(Dictionary<string, string> p)
    {
        if (!Flag(p, "confirm")) throw new InvalidOperationException("scroll requires confirm=1");
        int x, y, ticks;
        if (!int.TryParse(Param(p, "x"), out x) || !int.TryParse(Param(p, "y"), out y) || !int.TryParse(Param(p, "ticks"), out ticks))
            throw new ArgumentException("scroll requires integer x, y and ticks (wheel notches, negative = down)");
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(60);
        int delta = ticks * 120;
        mouse_event(MOUSEEVENTF_WHEEL, 0, 0, (uint)delta, UIntPtr.Zero);
        return "{\"ok\":true,\"scrolled\":{\"x\":" + x + ",\"y\":" + y + ",\"delta\":" + delta + "}}";
    }

    static string CmdType(Dictionary<string, string> p)
    {
        if (!Flag(p, "confirm")) throw new InvalidOperationException("type_text requires confirm=1");
        IntPtr hwnd = ResolveHwnd(p);
        if (!StealFocus(hwnd)) throw new InvalidOperationException("foreground unavaiable before type_text");
        string text = Param(p, "text");
        int sent;
        try
        {
            sent = TypeUnicode(text);
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException("SendInput failed: " + ex.Message);
        }
        return "{\"ok\":true,\"typed_chars\":" + sent + "}";
    }

    static int TypeUnicode(string text)
    {
        int count = 0;
        foreach (char ch in text)
        {
            INPUT[] inps = new INPUT[2];
            inps[0].type = 1;
            inps[0].u.ki.wScan = ch;
            inps[0].u.ki.dwFlags = KEYEVENTF_UNICODE;
            inps[1].type = 1;
            inps[1].u.ki.wScan = ch;
            inps[1].u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
            uint r = SendInput(2, inps, Marshal.SizeOf(typeof(INPUT)));
            if (r == 2) count++;
        }
        return count;
    }

    static string CmdKey(Dictionary<string, string> p)
    {
        if (!Flag(p, "confirm")) throw new InvalidOperationException("press_key requires confirm=1");
        IntPtr hwnd = ResolveHwnd(p);
        if (!StealFocus(hwnd)) throw new InvalidOperationException("foreground unavaiable before press_key");
        string key = (Param(p, "key") ?? "").Trim().ToLowerInvariant();
        if (key.Length == 0) throw new ArgumentException("press_key requires 'key'");
        List<byte> before = new List<byte>();
        List<byte> after = new List<byte>();
        string mods = Param(p, "modifiers") ?? "";
        foreach (string mv in mods.Replace(';', ',').Split(new[] { ',', '+' }))
        {
            byte vk = ModVk(mv.Trim().ToLowerInvariant());
            if (vk != 0) { before.Add(vk); after.Insert(0, vk); }
        }
        List<byte> seq = new List<byte>();
        seq.AddRange(before);
        seq.Add(KeyVk(key));
        seq.AddRange(after);
        // press order: pre-mods, key down+up, post-mods; key itself needs down then up
        foreach (byte vk in before) keybd_event(vk, 0, 0, UIntPtr.Zero);
        byte main = KeyVk(key);
        keybd_event(main, 0, 0, UIntPtr.Zero);
        keybd_event(main, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        foreach (byte vk in after) keybd_event(vk, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        return "{\"ok\":true,\"key\":" + JsonStr(key) + "}";
    }

    static byte ModVk(string m)
    {
        if (m == "ctrl" || m == "control") return 0x11;
        if (m == "shift") return 0x10;
        if (m == "alt") return 0x12;
        if (m == "meta" || m == "win") return 0x5B;
        return 0;
    }

    static byte KeyVk(string k)
    {
        if (k.Length == 1) { char ch = k[0]; if (ch >= 'a' && ch <= 'z') return (byte)char.ToUpper(ch); if (ch >= '0' && ch <= '9') return (byte)ch; return 0; }
        switch (k)
        {
            case "enter": case "return": return 0x0D;
            case "escape": case "esc": return 0x1B;
            case "tab": return 0x09;
            case "backspace": return 0x08;
            case "space": return 0x20;
            case "delete": case "del": return 0x2E;
            case "home": return 0x24;
            case "end": return 0x23;
            case "pageup": return 0x21;
            case "pagedown": return 0x22;
            case "up": case "arrowup": return 0x26;
            case "down": case "arrowdown": return 0x28;
            case "left": case "arrowleft": return 0x25;
            case "right": case "arrowright": return 0x27;
            default:
                if (k.Length == 2 && (k[0] == 'f' || k[0] == 'F'))
                {
                    int n; if (int.TryParse(k.Substring(1), out n) && n >= 1 && n <= 12) return (byte)(0x70 + n - 1);
                }
                return 0;
        }
    }
    // ------------------------------------------------------------- screenshot
    static string CmdShot(Dictionary<string, string> p)
    {
        string path = Param(p, "path");
        if (path.Length == 0) path = Path.Combine(Path.GetTempPath(), "mrc-cua-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".png");
        if (Have(p, "window_id") || Have(p, "hwnd") || Have(p, "pid"))
        {
            AutomationElement.AutomationElementInformation c = FindTarget(p).Current;
            Rect r = c.BoundingRectangle;
            if (RectFinite(r) && r.Width > 1 && r.Height > 1)
            {
                ShotRect(new Rectangle((int)r.X, (int)r.Y, (int)r.Width, (int)r.Height), path);
            }
            else
            {
                ShotRect(new Rectangle(0, 0, GetSystemMetrics(0), GetSystemMetrics(1)), path);
            }
        }
        else
        {
            ShotRect(new Rectangle(0, 0, GetSystemMetrics(0), GetSystemMetrics(1)), path);
        }
        return "{\"ok\":true,\"path\":" + JsonStr(path) + ",\"bytes\":" + new FileInfo(path).Length + "}";
    }

    static void ShotRect(Rectangle r, string path)
    {
        using (Bitmap bmp = new Bitmap(r.Width, r.Height, PixelFormat.Format32bppArgb))
        using (Graphics g = Graphics.FromImage(bmp))
        {
            g.CopyFromScreen(r.X, r.Y, 0, 0, r.Size);
            bmp.Save(path, ImageFormat.Png);
        }
    }

    static string Param(Dictionary<string, string> p, string key)
    {
        string v; return p.TryGetValue(key, out v) ? v : "";
    }
}
