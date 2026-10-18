// mrc-cua.cs — standalone C# CUA engine pilot (.NET 4.8, compiled on-Windows with csc.exe)
// Stage 1 of the "strangler" evaluation: native UIA + input + capture, no driver, no bun.
// Commands: all | windows | tree <hwnd> | focus <hwnd> | type <text> | shot <path>
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
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
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint uiAction, uint uiParam, ref uint pvParam, uint fWinIni);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int nIndex);

    const int SM_CXSCREEN = 0;
    const int SM_CYSCREEN = 1;
    static int g_count;

    static void Main(string[] args)
    {
        string cmd = args.Length > 0 ? args[0] : "all";
        try
        {
            switch (cmd)
            {
                case "windows": CmdWindows(); break;
                case "tree": CmdTree(HwndOf(args)); break;
                case "focus": CmdFocus(HwndOf(args)); break;
                case "type": CmdType(args.Length > 1 ? args[1] : "mrc"); break;
                case "shot": CmdShot(args.Length > 1 ? args[1] : "mrc-cua-shot.png"); break;
                default: CmdAll(args.Length > 1 ? args[1] : "mrc-cua-shot.png"); break;
            }
            Console.WriteLine("EVAL_DONE");
        }
        catch (Exception ex)
        {
            Console.WriteLine("ERROR: " + ex.GetType().Name + ": " + ex.Message);
            Environment.ExitCode = 1;
        }
    }

    static IntPtr HwndOf(string[] args)
    {
        uint v;
        return (args.Length > 1 && uint.TryParse(args[1], out v)) ? new IntPtr(v) : IntPtr.Zero;
    }

    static string ProcName(int id)
    {
        try { return System.Diagnostics.Process.GetProcessById(id).ProcessName; }
        catch { return "?"; }
    }

    // ---- windows ----------------------------------------------------------
    static void CmdWindows()
    {
        var list = WindowMatches(null);
        foreach (var w in list)
        {
            AutomationElement.AutomationElementInformation c = w.Current;
            Console.WriteLine(Format("0:X", c.NativeWindowHandle) +
                " pid=" + c.ProcessId + " app=" + ProcName(c.ProcessId) +
                " vis=" + IsWindowVisible((IntPtr)c.NativeWindowHandle) +
                " class=" + c.ClassName + " name=" + c.Name);
        }
        Console.WriteLine("windows=" + list.Count);
    }

    static List<AutomationElement> WindowMatches(string klass)
    {
        var res = new List<AutomationElement>();
        var root = AutomationElement.RootElement;
        var all = root.FindAll(TreeScope.Children, Condition.TrueCondition);
        foreach (AutomationElement w in all)
        {
            AutomationElement.AutomationElementInformation c = w.Current;
            if (c.IsOffscreen) continue;
            if (c.NativeWindowHandle == 0) continue;
            if (klass != null && c.ClassName != klass) continue;
            res.Add(w);
        }
        return res;
    }

    static string Format(string fmt, object v)
    {
        return string.Format("{0:" + fmt + "}", v);
    }

    // ---- tree -------------------------------------------------------------
    static void CmdTree(IntPtr hwnd)
    {
        AutomationElement target = FindByHwnd(hwnd);
        if (target == null) { Console.WriteLine("TARGET_NOT_FOUND hwnd=0x" + hwnd.ToInt64().ToString("X")); return; }
        var walker = TreeWalker.ControlViewWalker;
        g_count = 0;
        Walk(target, 0, walker);
        Console.WriteLine("elements=" + g_count);
    }

    static AutomationElement FindByHwnd(IntPtr hwnd)
    {
        var all = AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition);
        foreach (AutomationElement w in all)
        {
            if (w.Current.NativeWindowHandle == hwnd.ToInt32()) return w;
        }
        return null;
    }

    static void Walk(AutomationElement el, int depth, TreeWalker walker)
    {
        if (depth > 5 || g_count >= 150) return;
        AutomationElement.AutomationElementInformation c = el.Current;
        string role = c.ControlType.ProgrammaticName.Replace("ControlType.", "");
        string nm = c.Name == null ? "" : c.Name;
        if (nm.Length > 70) nm = nm.Substring(0, 70);
        Console.WriteLine(new string(' ', depth * 2) + "[" + role + "] pid=" + c.ProcessId + " Name=" + nm);
        g_count++;
        AutomationElement ch = walker.GetFirstChild(el);
        while (ch != null && g_count < 150)
        {
            Walk(ch, depth + 1, walker);
            ch = walker.GetNextSibling(ch);
        }
    }

    // ---- focus (aggressive steal) -----------------------------------------
    static void CmdFocus(IntPtr target)
    {
        if (target == IntPtr.Zero) { Console.WriteLine("NEED_HWN"); return; }
        uint a, b, zero = 0;
        IntPtr before = GetForegroundWindow();
        // ALT press/release grants us foreground rights to a background process
        keybd_event(0x12, 0, 0, UIntPtr.Zero);
        keybd_event(0x12, 0, 2, UIntPtr.Zero);
        uint orig = 0;
        SystemParametersInfo(0x2000, 0, ref orig, 0);          // SPI_GETFOREGROUNDLOCKTIMEOUT
        SystemParametersInfo(0x2001, 0, ref zero, 0);          // SPI_SETFOREGROUNDLOCKTIMEOUT = 0
        uint fgTid = GetWindowThreadProcessId(before, out a);
        uint tgtTid = GetWindowThreadProcessId(target, out b);
        uint mine = GetCurrentThreadId();
        bool a1 = AttachThreadInput(fgTid, mine, true);
        bool a2 = AttachThreadInput(tgtTid, mine, true);
        ShowWindow(target, 9);                                  // SW_RESTORE
        bool sfw = SetForegroundWindow(target);
        AttachThreadInput(fgTid, mine, false);
        AttachThreadInput(tgtTid, mine, false);
        SystemParametersInfo(0x2001, 0, ref orig, 0);          // restore original timeout
        System.Threading.Thread.Sleep(400);
        IntPtr after = GetForegroundWindow();
        Console.WriteLine("before=0x" + before.ToInt64().ToString("X") +
            " target=0x" + target.ToInt64().ToString("X") +
            " after=0x" + after.ToInt64().ToString("X") +
            " attach1=" + a1 + " attach2=" + a2 + " sfw=" + sfw +
            " RESULT=" + (after == target));
    }

    // ---- type --------------------------------------------------------------
    static void CmdType(string text)
    {
        IntPtr fg = GetForegroundWindow();
        uint pid;
        GetWindowThreadProcessId(fg, out pid);
        SendKeys.SendWait(text);
        Console.WriteLine("SENDINPUT_OK to hwnd=0x" + fg.ToInt64().ToString("X") +
            " pid=" + pid + " text=" + text);
    }

    // ---- screenshot ---------------------------------------------------------
    static void CmdShot(string path)
    {
        int w = GetSystemMetrics(SM_CXSCREEN);
        int h = GetSystemMetrics(SM_CYSCREEN);
        using (Bitmap bmp = new Bitmap(w, h))
        using (Graphics g = Graphics.FromImage(bmp))
        {
            g.CopyFromScreen(0, 0, 0, 0, new Size(w, h));
            bmp.Save(path, ImageFormat.Png);
        }
        Console.WriteLine("SHOT_OK " + path + " " + new FileInfo(path).Length + "b");
    }

    // ---- scripted evaluation --------------------------------------------------
    static void CmdAll(string shotPath)
    {
        Console.WriteLine("== [1] windows (UIA root children, on-screen)");
        CmdWindows();

        Console.WriteLine("== [2] focus steal (target: explorer folder, else desktop)");
        var targets = WindowMatches("CabinetWClass");
        IntPtr tgt;
        if (targets.Count > 0)
            tgt = (IntPtr)targets[0].Current.NativeWindowHandle;
        else
            tgt = new IntPtr(0x101EA);   // known Progman fallback; fails gracefully if stale
        if (tgt != IntPtr.Zero) CmdFocus(tgt);
        System.Threading.Thread.Sleep(300);

        Console.WriteLine("== [3] tree of focused window (ControlView, depth<=5)");
        AutomationElement fe = FindByHwnd(GetForegroundWindow());
        if (fe != null)
        {
            var walker = TreeWalker.ControlViewWalker;
            g_count = 0;
            Walk(fe, 0, walker);
            Console.WriteLine("elements=" + g_count);
        }

        Console.WriteLine("== [4] real keyboard (SendKeys via SendInput) into focused window");
        CmdType("mrc");

        Console.WriteLine("== [5] full screenshot (GDI+ CopyFromScreen)");
        CmdShot(shotPath);
    }
}
