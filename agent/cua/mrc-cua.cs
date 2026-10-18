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
                case "browser_state": result = CmdBrowserState(p); break;
                case "browser_open": result = CmdBrowserOpen(p); break;
                case "browser_navigate": result = CmdBrowserNavigate(p); break;
                case "browser_get_text": result = CmdBrowserText(p); break;
                case "browser_tabs": result = CmdBrowserTabs(p); break;
                case "browser_click": result = CmdBrowserClick(p); break;
                case "record": result = CmdRecord(p); break;
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

    // =========================================================================
    // Native browser control + screen recording
    //
    // The browser tools attach to the browser the USER already runs (their real
    // profile, their tabs) through the Windows UI Automation tree: the active
    // tab's Document element exposes the page title/text and its clickable
    // links, and the address bar carries the URL (ValuePattern). No Playwright,
    // no parallel headless profile. When nothing is open, browser_open launches
    // the installed browser with the user's default profile — launching
    // Chrome/Edge with a URL opens a tab in the live instance.
    // =========================================================================

    static readonly string[] BrowserNames = { "chrome", "msedge", "firefox" };

    static readonly PropertyCondition IsDocument =
        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document);
    static readonly PropertyCondition IsEdit =
        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit);
    static readonly PropertyCondition IsTabItem =
        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.TabItem);

    static bool IsBrowserProcess(string name)
    {
        foreach (string b in BrowserNames) if (name == b) return true;
        return false;
    }

    /** All visible browser windows, biggest first (front-most candidates). */
    static List<AutomationElement> BrowserWindows()
    {
        List<AutomationElement> list = new List<AutomationElement>();
        var all = AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition);
        foreach (AutomationElement w in all)
        {
            AutomationElement.AutomationElementInformation c = w.Current;
            if (c.NativeWindowHandle == 0) continue;
            if (!IsWindowVisible((IntPtr)c.NativeWindowHandle)) continue;
            if (!IsBrowserProcess(ProcName(c.ProcessId).ToLowerInvariant())) continue;
            list.Add(w);
        }
        list.Sort(delegate(AutomationElement a, AutomationElement b2)
        {
            Rect ra = a.Current.BoundingRectangle, rb = b2.Current.BoundingRectangle;
            long aa = RectFinite(ra) ? (long)ra.Width * (long)ra.Height : 0;
            long ab = RectFinite(rb) ? (long)rb.Width * (long)rb.Height : 0;
            return ab.CompareTo(aa);
        });
        return list;
    }

    /** Target browser window: explicit window_id/pid, else the biggest live one. */
    static AutomationElement BrowserWindow(Dictionary<string, string> p)
    {
        if (Have(p, "window_id") || Have(p, "hwnd") || Have(p, "pid"))
        {
            AutomationElement el = FindTarget(p);
            string proc = ProcName(el.Current.ProcessId).ToLowerInvariant();
            if (!IsBrowserProcess(proc))
                throw new InvalidOperationException("target process '" + proc + "' is not a browser (chrome/msedge/firefox)");
            return el;
        }
        List<AutomationElement> wins = BrowserWindows();
        if (wins.Count == 0)
            throw new InvalidOperationException("no browser window is open; call browser_open first");
        return wins[0];
    }

    /** The active page Document (focused element's ancestor, else first Document under the window). */
    static AutomationElement ActiveDocument(AutomationElement win)
    {
        try
        {
            AutomationElement focused = AutomationElement.FocusedElement;
            TreeWalker walker = TreeWalker.ControlViewWalker;
            for (int up = 0; up < 12 && focused != null; up++)
            {
                if (focused.Current.ControlType == ControlType.Document) return focused;
                focused = walker.GetParent(focused);
            }
        }
        catch { /* the focused element may be gone */ }
        try { return win.FindFirst(TreeScope.Descendants, IsDocument); }
        catch { return null; }
    }

    /** The URL from the address bar (first Edit whose ValuePattern value looks like a URL). */
    static string ReadAddressBar(AutomationElement win)
    {
        try
        {
            AutomationElementCollection edits = win.FindAll(TreeScope.Descendants, IsEdit);
            foreach (AutomationElement e in edits)
            {
                object pat;
                if (!e.TryGetCurrentPattern(ValuePattern.Pattern, out pat)) continue;
                string v;
                try { v = ((ValuePattern)pat).Current.Value; } catch { continue; }
                if (string.IsNullOrEmpty(v)) continue;
                string lower = v.ToLowerInvariant();
                if (lower.StartsWith("http://") || lower.StartsWith("https://") || lower.StartsWith("file://") ||
                    lower.StartsWith("about:") || lower.StartsWith("edge://") || lower.StartsWith("chrome://") ||
                    lower.StartsWith("data:"))
                    return v;
            }
        }
        catch { }
        return "";
    }

    static void AppendBounds(StringBuilder sb, Rect r)
    {
        sb.Append("\"x\":").Append(Num(r.X)).Append(",\"y\":").Append(Num(r.Y))
          .Append(",\"width\":").Append(Num(r.Width)).Append(",\"height\":").Append(Num(r.Height));
    }

    // ---------------------------------------------------------------- state
    static string CmdBrowserState(Dictionary<string, string> p)
    {
        AutomationElement win = BrowserWindow(p);
        AutomationElement.AutomationElementInformation c = win.Current;
        AutomationElement doc = ActiveDocument(win);
        StringBuilder sb = new StringBuilder();
        sb.Append("{\"ok\":true")
          .Append(",\"browser\":").Append(JsonStr(ProcName(c.ProcessId).ToLowerInvariant()))
          .Append(",\"window_id\":").Append(c.NativeWindowHandle)
          .Append(",\"window_title\":").Append(JsonStr(c.Name == null ? "" : c.Name))
          .Append(",\"url\":").Append(JsonStr(ReadAddressBar(win)))
          .Append(",\"page_title\":").Append(JsonStr(doc == null ? "" : (doc.Current.Name ?? "")))
          .Append(",\"page_ready\":").Append(doc != null && !doc.Current.IsOffscreen ? "true" : "false")
          .Append(",\"bounds\":{");
        AppendBounds(sb, c.BoundingRectangle);
        sb.Append("}}");
        return sb.ToString();
    }

    // ----------------------------------------------------------------- open
    static string CmdBrowserOpen(Dictionary<string, string> p)
    {
        if (!Flag(p, "confirm")) throw new InvalidOperationException("browser_open requires confirm=1");
        string want = Param(p, "browser").ToLowerInvariant();
        string url = Param(p, "url");
        if (url.Length > 0 && !IsHttpUrl(url) && !url.ToLowerInvariant().StartsWith("file:"))
            throw new ArgumentException("url must be a full http(s):// or file:// URL");
        if (want.Length > 0 && !IsBrowserProcess(want))
            throw new ArgumentException("browser must be chrome, msedge or firefox");

        // Live instance first: take over the open browser (user profile + tabs).
        List<AutomationElement> wins = BrowserWindows();
        if (want.Length > 0)
        {
            for (int i = wins.Count - 1; i >= 0; i--)
                if (ProcName(wins[i].Current.ProcessId).ToLowerInvariant() != want) wins.RemoveAt(i);
        }
        if (wins.Count > 0)
        {
            AutomationElement win = wins[0];
            string proc = ProcName(win.Current.ProcessId).ToLowerInvariant();
            StealFocus((IntPtr)win.Current.NativeWindowHandle);
            if (url.Length > 0)
            {
                if (Flag(p, "new_tab")) { PressCombo(0x11, 0x54); System.Threading.Thread.Sleep(450); }
                NavigateAddressBar(win, url);
            }
            return "{\"ok\":true,\"mode\":\"takeover\",\"browser\":" + JsonStr(proc) +
                   ",\"window_id\":" + win.Current.NativeWindowHandle +
                   ",\"navigated\":" + (url.Length > 0 ? "true" : "false") + "}";
        }

        // Nothing live: launch the default-profile browser; with a URL it opens a
        // tab in the live instance (Chrome/Edge) or a new default-profile window.
        string exe = BrowserExe(want.Length > 0 ? want : "chrome");
        if (exe == null) throw new InvalidOperationException("browser '" + (want.Length > 0 ? want : "chrome") + "' is not installed here");
        ProcessStartInfo psi = new ProcessStartInfo(exe);
        if (url.Length > 0) psi.Arguments = "\"" + url + "\"";
        psi.UseShellExecute = false;
        Process.Start(psi);
        string procName = Path.GetFileNameWithoutExtension(exe);
        AutomationElement born = null;
        for (int i = 0; i < 40 && born == null; i++)
        {
            System.Threading.Thread.Sleep(300);
            foreach (AutomationElement w in BrowserWindows())
                if (ProcName(w.Current.ProcessId).ToLowerInvariant() == procName) { born = w; break; }
        }
        if (born == null)
            return "{\"ok\":true,\"mode\":\"launched\",\"browser\":" + JsonStr(procName) +
                   ",\"window_id\":0,\"note\":\"the window did not register yet; poll browser_state\"}";
        return "{\"ok\":true,\"mode\":\"launched\",\"browser\":" + JsonStr(procName) +
               ",\"window_id\":" + born.Current.NativeWindowHandle + "}";
    }

    static bool IsHttpUrl(string url)
    {
        string lower = url.ToLowerInvariant();
        return lower.StartsWith("http://") || lower.StartsWith("https://");
    }

    static string BrowserExe(string name)
    {
        string[] candidates;
        if (name == "msedge")
            candidates = new string[] {
                Environment.ExpandEnvironmentVariables(@"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
                Environment.ExpandEnvironmentVariables(@"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe") };
        else if (name == "firefox")
            candidates = new string[] {
                Environment.ExpandEnvironmentVariables(@"%ProgramFiles%\Mozilla Firefox\firefox.exe"),
                Environment.ExpandEnvironmentVariables(@"%ProgramFiles(x86)%\Mozilla Firefox\firefox.exe") };
        else
            candidates = new string[] {
                Environment.ExpandEnvironmentVariables(@"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
                Environment.ExpandEnvironmentVariables(@"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
                Environment.ExpandEnvironmentVariables(@"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe") };
        foreach (string c in candidates) { try { if (File.Exists(c)) return c; } catch { } }
        return null;
    }

    // ------------------------------------------------------------- navigate
    /** Focus the address bar (Ctrl+L), replace its contents, type the URL, Enter. */
    static void NavigateAddressBar(AutomationElement win, string url)
    {
        if (!StealFocus((IntPtr)win.Current.NativeWindowHandle))
            throw new InvalidOperationException("foreground unavaiable before navigate");
        PressCombo(0x11, 0x4C); // Ctrl+L selects the whole address bar
        System.Threading.Thread.Sleep(250);
        TypeUnicode(url);
        System.Threading.Thread.Sleep(120);
        PressKeyVk(0x0D); // Enter
    }

    static string CmdBrowserNavigate(Dictionary<string, string> p)
    {
        if (!Flag(p, "confirm")) throw new InvalidOperationException("browser_navigate requires confirm=1");
        string url = Param(p, "url");
        if (url.Length == 0 || !IsHttpUrl(url))
            throw new ArgumentException("browser_navigate requires a full http(s):// 'url'");
        AutomationElement win = BrowserWindow(p);
        if (Flag(p, "new_tab"))
        {
            StealFocus((IntPtr)win.Current.NativeWindowHandle);
            PressCombo(0x11, 0x54); // Ctrl+T
            System.Threading.Thread.Sleep(450);
        }
        NavigateAddressBar(win, url);
        System.Threading.Thread.Sleep(600);
        StringBuilder sb = new StringBuilder();
        sb.Append("{\"ok\":true,\"navigated\":true,\"window_id\":").Append(win.Current.NativeWindowHandle)
          .Append(",\"url\":").Append(JsonStr(url)).Append("}");
        return sb.ToString();
    }

    // ------------------------------------------------------------- read page
    static string CmdBrowserText(Dictionary<string, string> p)
    {
        AutomationElement win = BrowserWindow(p);
        AutomationElement doc = ActiveDocument(win);
        if (doc == null) throw new InvalidOperationException("no page is loaded in this browser window");
        int max = 8000;
        string maxStr = Param(p, "max_chars");
        if (maxStr.Length > 0 && !int.TryParse(maxStr, out max)) max = 8000;
        if (max < 200) max = 200;
        if (max > 40000) max = 40000;
        StringBuilder text = new StringBuilder();
        object pat;
        if (doc.TryGetCurrentPattern(TextPattern.Pattern, out pat))
        {
            try
            {
                TextPattern tp = (TextPattern)pat;
                string chunk = tp.DocumentRange.GetText(max + 1);
                if (chunk != null) text.Append(chunk);
            }
            catch (Exception ex) { throw new InvalidOperationException("TextPattern read failed: " + ex.Message); }
        }
        else if (doc.TryGetCurrentPattern(ValuePattern.Pattern, out pat))
        {
            try { text.Append(((ValuePattern)pat).Current.Value ?? ""); }
            catch { }
        }
        if (text.Length == 0)
        {
            // last resort: concatenate the UIA names of the subtree
            try
            {
                foreach (AutomationElement e in doc.FindAll(TreeScope.Descendants, Condition.TrueCondition))
                {
                    string n = e.Current.Name;
                    if (!string.IsNullOrEmpty(n)) { text.Append(n).Append('\n'); }
                    if (text.Length >= max) break;
                }
            }
            catch { }
        }
        string joined = text.ToString().Replace("\r\n", "\n");
        bool truncated = joined.Length > max;
        if (truncated) joined = joined.Substring(0, max);
        StringBuilder sb = new StringBuilder();
        sb.Append("{\"ok\":true,\"url\":").Append(JsonStr(ReadAddressBar(win)))
          .Append(",\"title\":").Append(JsonStr(doc.Current.Name ?? ""))
          .Append(",\"truncated\":").Append(truncated ? "true" : "false")
          .Append(",\"text\":").Append(JsonStr(joined)).Append("}");
        return sb.ToString();
    }

    // ------------------------------------------------------------------ tabs
    static string CmdBrowserTabs(Dictionary<string, string> p)
    {
        AutomationElement win = BrowserWindow(p);
        List<AutomationElement> tabs = new List<AutomationElement>();
        try
        {
            AutomationElementCollection found = win.FindAll(TreeScope.Descendants, IsTabItem);
            foreach (AutomationElement t in found) tabs.Add(t);
        }
        catch { }
        StringBuilder sb = new StringBuilder();
        sb.Append("{\"ok\":true,\"browser\":").Append(JsonStr(ProcName(win.Current.ProcessId).ToLowerInvariant()))
          .Append(",\"tab_count\":").Append(tabs.Count).Append(",\"tabs\":[");
        bool first = true;
        foreach (AutomationElement t in tabs)
        {
            if (!first) sb.Append(",");
            first = false;
            bool selected = false;
            try
            {
                object pat;
                if (t.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pat))
                    selected = ((SelectionItemPattern)pat).Current.IsSelected;
            }
            catch { }
            sb.Append("{\"title\":").Append(JsonStr(t.Current.Name ?? ""))
              .Append(",\"selected\":").Append(selected ? "true" : "false").Append("}");
        }
        sb.Append("]}");
        return sb.ToString();
    }

    // ----------------------------------------------------------------- click
    static string CmdBrowserClick(Dictionary<string, string> p)
    {
        if (!Flag(p, "confirm")) throw new InvalidOperationException("browser_click requires confirm=1");
        string match = (Param(p, "match") ?? "").Trim().ToLowerInvariant();
        if (match.Length == 0)
            throw new ArgumentException("browser_click requires 'match' (case-insensitive text contained in a link or button)");
        AutomationElement win = BrowserWindow(p);
        AutomationElement doc = ActiveDocument(win);
        if (doc == null) throw new InvalidOperationException("no page is loaded in this browser window");
        List<AutomationElement> hits = new List<AutomationElement>();
        ControlType[] kinds = new ControlType[] { ControlType.Hyperlink, ControlType.Button };
        foreach (ControlType ct in kinds)
        {
            try
            {
                AndCondition cond = new AndCondition(
                    new PropertyCondition(AutomationElement.ControlTypeProperty, ct),
                    new PropertyCondition(AutomationElement.IsEnabledProperty, true));
                AutomationElementCollection found = doc.FindAll(TreeScope.Descendants, cond);
                foreach (AutomationElement e in found)
                {
                    string name = e.Current.Name ?? "";
                    if (name.ToLowerInvariant().Contains(match)) hits.Add(e);
                    if (hits.Count > 12) break;
                }
            }
            catch { }
            if (hits.Count > 12) break;
        }
        if (hits.Count == 0) throw new InvalidOperationException("no enabled link or button contains '" + match + "'");
        int nth = 0;
        string nthStr = Param(p, "nth");
        if (nthStr.Length > 0) int.TryParse(nthStr, out nth);
        if (nth < 0 || nth >= hits.Count)
            throw new ArgumentException("nth " + nth + " out of range (" + hits.Count + " matches for '" + match + "')");
        AutomationElement target = hits[nth];
        Rect r = target.Current.BoundingRectangle;
        if (!RectFinite(r) || r.Width < 1)
            throw new InvalidOperationException("the target element is not visible on screen; scroll it into view first");
        int cx = (int)(r.X + r.Width / 2), cy = (int)(r.Y + r.Height / 2);
        if (!StealFocus((IntPtr)win.Current.NativeWindowHandle)) throw new InvalidOperationException("foreground unavaiable before click");
        if (!SetCursorPos(cx, cy)) throw new InvalidOperationException("SetCursorPos failed");
        System.Threading.Thread.Sleep(60);
        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
        StringBuilder sb = new StringBuilder();
        sb.Append("{\"ok\":true,\"clicked\":{\"x\":").Append(cx).Append(",\"y\":").Append(cy)
          .Append("},\"name\":").Append(JsonStr(target.Current.Name ?? ""))
          .Append(",\"matches\":").Append(hits.Count).Append("}");
        return sb.ToString();
    }

    static void PressKeyVk(byte vk)
    {
        keybd_event(vk, 0, 0, UIntPtr.Zero);
        keybd_event(vk, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }

    static void PressCombo(byte ctrlVk, byte keyVk)
    {
        keybd_event(ctrlVk, 0, 0, UIntPtr.Zero);
        PressKeyVk(keyVk);
        keybd_event(ctrlVk, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }

    // -------------------------------------------------------------- recording
    /**
     * record: capture the primary monitor at N fps for `duration_sec` into a
     * video file on the remote machine. One-shot: blocks until the clip is
     * encoded and returns the path; the hub pulls it with a chunked transfer.
     * The agent runs CUA jobs sequentially, so the clip stays short (max 60 s,
     * hard job timeout). Frames go to temp JPEGs first, then:
     *   - ffmpeg on PATH -> MP4 (h264), or
     *   - otherwise a Motion-JPEG AVI written by the small writer below.
     */
    static string CmdRecord(Dictionary<string, string> p)
    {
        if (!Flag(p, "confirm")) throw new InvalidOperationException("record requires confirm=1");
        int seconds = 10;
        string secStr = Param(p, "duration_sec");
        if (secStr.Length > 0 && !int.TryParse(secStr, out seconds)) seconds = 10;
        if (seconds < 1) seconds = 1;
        if (seconds > 60) seconds = 60;
        int fps = 4;
        string fpsStr = Param(p, "fps");
        if (fpsStr.Length > 0 && !int.TryParse(fpsStr, out fps)) fps = 4;
        if (fps < 1) fps = 1;
        if (fps > 10) fps = 10;

        int width = GetSystemMetrics(0), height = GetSystemMetrics(1);
        string frameDir = Path.Combine(Path.GetTempPath(), "mrc-cua-frames-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(frameDir);
        string ffmpeg = FindFfmpeg();
        bool useFfmpeg = ffmpeg != null;
        string outPath = Param(p, "path");
        if (outPath.Length == 0)
            outPath = Path.Combine(Path.GetTempPath(), "mrc-cua-rec-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + (useFfmpeg ? ".mp4" : ".avi"));
        else if (!useFfmpeg && outPath.ToLowerInvariant().EndsWith(".mp4"))
            outPath = Path.ChangeExtension(outPath, ".avi");

        int frameCount = 0;
        long totalBytes = 0;
        string encoder;
        try
        {
            int total = seconds * fps;
            int perMs = Math.Max(1, 1000 / fps);
            long budget = (long)seconds * 1000;
            var sw = System.Diagnostics.Stopwatch.StartNew();
            for (int i = 0; i < total; i++)
            {
                using (Bitmap frame = new Bitmap(width, height, PixelFormat.Format24bppRgb))
                {
                    using (Graphics g = Graphics.FromImage(frame))
                    {
                        g.CopyFromScreen(0, 0, 0, 0, frame.Size);
                    }
                    string framePath = Path.Combine(frameDir, i.ToString("D5") + ".jpg");
                    frame.Save(framePath, ImageFormat.Jpeg);
                    totalBytes += new FileInfo(framePath).Length;
                }
                frameCount++;
                long elapsed = sw.ElapsedMilliseconds;
                long target = (long)(i + 1) * perMs;
                if (elapsed < target && target < budget) System.Threading.Thread.Sleep((int)(target - elapsed));
                else if (elapsed >= budget) break;
            }
            if (frameCount == 0) throw new InvalidOperationException("captured zero frames");

            if (useFfmpeg)
            {
                string args = "-y -framerate " + fps + " -start_number 0 -i \"" + Path.Combine(frameDir, "%05d.jpg") +
                    "\" -c:v libx264 -pix_fmt yuv420p -crf 23 -movflags +faststart \"" + outPath + "\"";
                ProcessStartInfo psi = new ProcessStartInfo(ffmpeg, args);
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                Process enc = Process.Start(psi);
                if (!enc.WaitForExit(180000)) { try { enc.Kill(); } catch { } throw new InvalidOperationException("ffmpeg encoding timed out"); }
                if (enc.ExitCode != 0) throw new InvalidOperationException("ffmpeg exited " + enc.ExitCode);
                encoder = "ffmpeg/h264";
            }
            else
            {
                WriteMjpegAvi(outPath, frameDir, frameCount, width, height, fps);
                encoder = "mjpeg-avi";
            }
        }
        finally
        {
            try { Directory.Delete(frameDir, true); } catch { }
        }

        StringBuilder sb = new StringBuilder();
        sb.Append("{\"ok\":true,\"path\":").Append(JsonStr(outPath))
          .Append(",\"bytes\":").Append(new FileInfo(outPath).Length)
          .Append(",\"frames\":").Append(frameCount)
          .Append(",\"fps\":").Append(fps)
          .Append(",\"duration_sec\":").Append(seconds)
          .Append(",\"resolution\":\"").Append(width).Append("x").Append(height).Append("\"")
          .Append(",\"encoder\":").Append(JsonStr(encoder))
          .Append(",\"codec_hint\":").Append(JsonStr(useFfmpeg ? "mp4/h264" : "avi motion-jpeg; convert with ffmpeg if needed"))
          .Append("}");
        return sb.ToString();
    }

    static string FindFfmpeg()
    {
        try
        {
            string local = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "ffmpeg.exe");
            if (File.Exists(local)) return local;
        }
        catch { }
        foreach (string dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
        {
            if (dir.Trim().Length == 0) continue;
            try
            {
                string candidate = Path.Combine(dir.Trim(), "ffmpeg.exe");
                if (File.Exists(candidate)) return candidate;
            }
            catch { }
        }
        return null;
    }

    /**
     * Minimal Motion-JPEG AVI writer (RIFF/AVI, one video stream, idx1 index).
     * Streams the captured JPEGs from frameDir; sizes are known up front so the
     * header is exact. Unpadded chunks (AVI decoders read JPEG sizes from the
     * index) — players and ffmpeg open the result fine.
     */
    static void WriteMjpegAvi(string outPath, string frameDir, int frameCount, int width, int height, int fps)
    {
        long[] sizes = new long[frameCount];
        long dataBytes = 0;
        for (int i = 0; i < frameCount; i++)
        {
            sizes[i] = new FileInfo(Path.Combine(frameDir, i.ToString("D5") + ".jpg")).Length;
            dataBytes += 8 + sizes[i];
        }
        long moviData = 4 + dataBytes;               // 'movi' fourcc + chunks
        long strlSize = 4 + (8 + 56) + (8 + 40);     // 'strl' + strh + strf
        long hdrlSize = 4 + (8 + 56) + (8 + strlSize);
        long idx1Size = 8 + frameCount * 16;
        long riffSize = 4 + (8 + hdrlSize) + (8 + moviData) + idx1Size;

        byte[] avih = AviMainHeader(fps, frameCount, width, height, dataBytes);
        byte[] strh = AviStreamHeader(fps, frameCount, width, height);
        byte[] strf = AviBitmapHeader(width, height);

        using (FileStream fs = new FileStream(outPath, FileMode.Create, FileAccess.Write))
        using (BinaryWriter bw = new BinaryWriter(fs))
        {
            bw.Write(Encoding.ASCII.GetBytes("RIFF"));
            bw.Write((uint)riffSize);
            bw.Write(Encoding.ASCII.GetBytes("AVI "));

            bw.Write(Encoding.ASCII.GetBytes("LIST"));
            bw.Write((uint)hdrlSize);
            bw.Write(Encoding.ASCII.GetBytes("hdrl"));
            bw.Write(Encoding.ASCII.GetBytes("avih"));
            bw.Write((uint)56);
            bw.Write(avih);
            bw.Write(Encoding.ASCII.GetBytes("LIST"));
            bw.Write((uint)strlSize);
            bw.Write(Encoding.ASCII.GetBytes("strl"));
            bw.Write(Encoding.ASCII.GetBytes("strh"));
            bw.Write((uint)56);
            bw.Write(strh);
            bw.Write(Encoding.ASCII.GetBytes("strf"));
            bw.Write((uint)40);
            bw.Write(strf);

            bw.Write(Encoding.ASCII.GetBytes("LIST"));
            bw.Write((uint)moviData);
            bw.Write(Encoding.ASCII.GetBytes("movi"));
            long offset = 4; // index offsets are relative to the movi fourcc
            int[] offsets = new int[frameCount];
            for (int i = 0; i < frameCount; i++)
            {
                offsets[i] = (int)offset;
                bw.Write(Encoding.ASCII.GetBytes("00dc"));
                bw.Write((uint)sizes[i]);
                byte[] jpeg = File.ReadAllBytes(Path.Combine(frameDir, i.ToString("D5") + ".jpg"));
                bw.Write(jpeg);
                offset += 8 + sizes[i];
            }

            bw.Write(Encoding.ASCII.GetBytes("idx1"));
            bw.Write((uint)(frameCount * 16));
            for (int i = 0; i < frameCount; i++)
            {
                bw.Write(Encoding.ASCII.GetBytes("00dc"));
                bw.Write(0x10u); // AVIIF_KEYFRAME (every MJPEG frame is one)
                bw.Write((uint)offsets[i]);
                bw.Write((uint)sizes[i]);
            }
        }
    }

    static byte[] AviMainHeader(int fps, int frameCount, int width, int height, long dataBytes)
    {
        byte[] b = new byte[56];
        WriteUInt32(b, 0, (uint)(1000000 / fps));                       // dwMicroSecPerFrame
        WriteUInt32(b, 4, (uint)Math.Min(uint.MaxValue, dataBytes / Math.Max(1, frameCount) * (long)fps + 1024)); // dwMaxBytesPerSec
        WriteUInt32(b, 8, 0);                                           // dwPaddingGranularity
        WriteUInt32(b, 12, 0x10);                                       // dwFlags: AVIF_HASINDEX
        WriteUInt32(b, 16, (uint)frameCount);                           // dwTotalFrames
        WriteUInt32(b, 20, 0);                                          // dwInitialFrames
        WriteUInt32(b, 24, 1);                                          // dwStreams
        WriteUInt32(b, 28, (uint)width * (uint)height * 4u);            // dwSuggestedBufferSize
        WriteUInt32(b, 32, (uint)width);                                // dwWidth
        WriteUInt32(b, 36, (uint)height);                               // dwHeight
        // 4 reserved dwords left as 0
        return b;
    }

    static byte[] AviStreamHeader(int fps, int frameCount, int width, int height)
    {
        byte[] b = new byte[56];
        WriteFourcc(b, 0, "vids");
        WriteFourcc(b, 4, "MJPG");
        WriteUInt32(b, 8, 0);            // dwFlags
        b[12] = 0; b[13] = 0;            // wPriority
        b[14] = 0; b[15] = 0;            // wLanguage
        WriteUInt32(b, 16, 0);           // dwInitialFrames
        WriteUInt32(b, 20, 1);           // dwScale
        WriteUInt32(b, 24, (uint)fps);   // dwRate
        WriteUInt32(b, 28, 0);           // dwStart
        WriteUInt32(b, 32, (uint)frameCount); // dwLength
        WriteUInt32(b, 36, (uint)width * (uint)height * 4u); // dwSuggestedBufferSize
        WriteUInt32(b, 40, uint.MaxValue); // dwQuality
        WriteUInt32(b, 44, 0);           // dwSampleSize
        // rcFrame: left, top, right, bottom (int16 each)
        b[48] = 0; b[49] = 0; b[50] = 0; b[51] = 0;
        b[52] = (byte)(width & 0xFF); b[53] = (byte)(width >> 8);
        b[54] = (byte)(height & 0xFF); b[55] = (byte)(height >> 8);
        return b;
    }

    static byte[] AviBitmapHeader(int width, int height)
    {
        byte[] b = new byte[40];
        WriteUInt32(b, 0, 40);                      // biSize
        WriteUInt32(b, 4, (uint)width);             // biWidth
        WriteUInt32(b, 8, (uint)height);            // biHeight
        b[12] = 1; b[13] = 0;                       // biPlanes
        b[14] = 24; b[15] = 0;                      // biBitCount
        WriteFourcc(b, 16, "MJPG");                 // biCompression
        WriteUInt32(b, 20, (uint)width * (uint)height * 3u); // biSizeImage
        WriteUInt32(b, 24, 2835);                   // biXPelsPerMeter (~72dpi)
        WriteUInt32(b, 28, 2835);                   // biYPelsPerMeter
        WriteUInt32(b, 32, 0);                      // biClrUsed
        WriteUInt32(b, 36, 0);                      // biClrImportant
        return b;
    }

    static void WriteUInt32(byte[] b, int at, uint v)
    {
        b[at] = (byte)(v & 0xFF);
        b[at + 1] = (byte)((v >> 8) & 0xFF);
        b[at + 2] = (byte)((v >> 16) & 0xFF);
        b[at + 3] = (byte)((v >> 24) & 0xFF);
    }

    static void WriteFourcc(byte[] b, int at, string fourcc)
    {
        b[at] = (byte)fourcc[0];
        b[at + 1] = (byte)fourcc[1];
        b[at + 2] = (byte)fourcc[2];
        b[at + 3] = (byte)fourcc[3];
    }
}

