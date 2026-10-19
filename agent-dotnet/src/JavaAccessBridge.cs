using System.Runtime.InteropServices;
using System.Text;

namespace Mrc.Agent;

/// <summary>
/// Java Access Bridge client: reads the component tree of a Java (Swing/AWT)
/// application that has JAB enabled, so the computer-use tools work on Java
/// apps instead of being blind to them (UIA3 exposes nothing for Swing).
///
/// How it works (Windows JAB):
///  - The JVM loads WindowsAccessBridge-64.dll when the accessibility property
///    file names com.sun.java.accessibility.AccessBridge, and creates its own
///    hidden "Access Bridge status" dialog.
///  - The AT side (this process) must create the SAME dialog template out of
///    its own copy of the DLL, call Windows_run() (which broadcasts a hello) and
///    pump Windows messages: the JVM answers, and both sides then talk over a
///    memory-mapped file.
///  - After that, the native calls below read the tree.
///
/// The bridge is timing sensitive (the JVM answers on its AWT thread), so the
/// connection is retried with a fresh broadcast until it takes.
///
/// Everything is optional: when the DLL, the property file or a Java window are
/// missing, IsAvailable stays false and the UIA path is used unchanged.
/// </summary>
public static class JavaAccessBridge
{
    private const string DllName = "WindowsAccessBridge-64.dll";
    private const string DialogTemplate = "ACCESSBRIDGESTATUSWINDOW";

    // AccessibleContextInfo (AccessBridgePackages.h): fixed-size wchar_t arrays.
    private const int InfoSize = 6188;
    private const int OffName = 0;          // wchar_t[1024]
    private const int OffDescription = 2048; // wchar_t[1024]
    private const int OffRole = 4096;       // wchar_t[256]
    private const int OffRoleEn = 4608;     // wchar_t[256]
    private const int OffStates = 5120;     // wchar_t[256]
    private const int OffChildren = 6148;   // jint
    private const int OffX = 6152, OffY = 6156, OffWidth = 6160, OffHeight = 6164;

    // VisibleChildrenInfo: int count + 4 bytes padding + AccessibleContext[256].
    private const int VisibleChildrenSize = 8 + 256 * 8;
    private const int VisibleChildrenOffset = 8;

    private static readonly object Gate = new();
    private static IntPtr _dll;
    private static IntPtr _info;
    private static IntPtr _visible;
    private static IntPtr _message;
    private static Thread? _atThread;
    private static volatile bool _atRun;

    // ---- native interop -------------------------------------------------

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadLibrary(string name);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateDialogParam(IntPtr instance, string template, IntPtr parent, IntPtr dlgProc, IntPtr param);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool PeekMessage(IntPtr msg, IntPtr hwnd, uint min, uint max, uint remove);

    [DllImport("user32.dll")]
    private static extern bool DispatchMessage(IntPtr msg);

    [DllImport(DllName)] private static extern void Windows_run();
    [DllImport(DllName)] private static extern bool isJavaWindow(IntPtr hwnd);
    [DllImport(DllName)] private static extern bool getAccessibleContextFromHWND(IntPtr hwnd, out long vmId, out long context);
    [DllImport(DllName)] private static extern bool getAccessibleContextInfo(long vmId, long context, IntPtr info);
    [DllImport(DllName)] private static extern int getVisibleChildrenCount(long vmId, long context);
    [DllImport(DllName)] private static extern bool getVisibleChildren(long vmId, long context, int startIndex, IntPtr visibleChildren);
    [DllImport(DllName, CharSet = CharSet.Unicode)]
    private static extern bool setTextContents(long vmId, long context, string text);
    [DllImport(DllName)] private static extern int getAccessibleActionsCount(long vmId, long context);
    [DllImport(DllName, CharSet = CharSet.Unicode)]
    private static extern string getAccessibleActionName(long vmId, long context, int index);

    // ---- public API ------------------------------------------------------

    /// <summary>True when the bridge is loaded and a Java window is reachable.</summary>
    public static bool IsAvailable(IntPtr hwnd) => Connect(hwnd);

    /// <summary>
    /// The component tree of a Java window: role, name and screen bounds of every
    /// visible node. Empty when the window is not a Java window.
    /// </summary>
    public static List<JabNode> ReadTree(IntPtr hwnd, int maxDepth = 12, int maxNodes = 4000)
    {
        var nodes = new List<JabNode>();
        if (!Connect(hwnd)) return nodes;
        lock (Gate)
        {
            if (!getAccessibleContextFromHWND(hwnd, out var vmId, out var context) || context == 0) return nodes;
            Walk(vmId, context, 0, maxDepth, maxNodes, nodes);
        }
        return nodes;
    }

    /// <summary>
    /// Finds a Java component by substring of its name, by class name (the JAB
    /// role) or by control type. Used when UIA3 finds nothing in a Java window.
    /// </summary>
    public static List<JabNode> Find(IntPtr hwnd, string? name, string? className, string? controlType, int max)
    {
        var hits = new List<JabNode>();
        if (!Connect(hwnd)) return hits;
        foreach (var node in ReadTree(hwnd))
        {
            if (hits.Count >= max) break;
            if (name is not null && !Contains(node.Name, name)) continue;
            if (className is not null && !Contains(node.Role, className)) continue;
            if (controlType is not null && !Contains(node.ControlType, controlType)) continue;
            hits.Add(node);
        }
        return hits;
    }

    private static bool Contains(string? value, string needle) =>
        !string.IsNullOrEmpty(value) && value.Contains(needle, StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Writes text into a Java text field, addressed by the same criteria
    /// find_element uses. Returns false when the field cannot be found.
    /// </summary>
    public static bool SetText(IntPtr hwnd, string? name, string? className, string value)
    {
        if (!Connect(hwnd)) return false;
        lock (Gate)
        {
            if (!getAccessibleContextFromHWND(hwnd, out var vmId, out var root)) return false;
            return SetTextDeep(vmId, root, name, className, value, 0);
        }
    }

    private static bool SetTextDeep(long vmId, long context, string? name, string? className, string value, int depth)
    {
        if (depth > 12) return false;
        getAccessibleContextInfo(vmId, context, _info);
        var role = ReadWide(OffRoleEn, 256);
        if (role.Length == 0) role = ReadWide(OffRole, 256);
        var nodeName = ReadWide(OffName, 1024);
        var isField = role.Contains("text field", StringComparison.OrdinalIgnoreCase)
            || role.Contains("editable", StringComparison.OrdinalIgnoreCase)
            || role.Contains("password", StringComparison.OrdinalIgnoreCase)
            || role.Contains("text", StringComparison.OrdinalIgnoreCase);
        var nameOk = name is null || Contains(nodeName, name);
        var classOk = className is null || Contains(role, className);
        if (isField && nameOk && classOk && setTextContents(vmId, context, value)) return true;

        var count = getVisibleChildrenCount(vmId, context);
        if (count <= 0) return false;
        for (var start = 0; start < count; start += 256)
        {
            if (!getVisibleChildren(vmId, context, start, _visible)) break;
            var returned = Marshal.ReadInt32(_visible, 0);
            for (var i = 0; i < returned; i++)
            {
                var child = Marshal.ReadInt64(_visible, VisibleChildrenOffset + i * 8);
                if (child != 0 && SetTextDeep(vmId, child, name, className, value, depth + 1)) return true;
            }
            if (returned < 256) break;
        }
        return false;
    }

    /// <summary>
    /// Invokes a Java component's default action (press / click / expand) by
    /// name. Used for Java buttons, which UIA3 cannot see at all.
    /// </summary>
    public static bool Invoke(IntPtr hwnd, string? name, string? className)
    {
        if (!Connect(hwnd)) return false;
        lock (Gate)
        {
            if (!getAccessibleContextFromHWND(hwnd, out var vmId, out var root)) return false;
            return InvokeDeep(vmId, root, name, className, 0);
        }
    }

    private static bool InvokeDeep(long vmId, long context, string? name, string? className, int depth)
    {
        if (depth > 12) return false;
        getAccessibleContextInfo(vmId, context, _info);
        var role = ReadWide(OffRoleEn, 256);
        if (role.Length == 0) role = ReadWide(OffRole, 256);
        var nodeName = ReadWide(OffName, 1024);
        var nameOk = name is null || Contains(nodeName, name);
        var classOk = className is null || Contains(role, className);

        if (nameOk && classOk)
        {
            var actions = getAccessibleActionsCount(vmId, context);
            for (var i = 0; i < actions; i++)
            {
                var action = getAccessibleActionName(vmId, context, i);
                if (string.IsNullOrEmpty(action)) continue;
                if (!IsActivatable(action)) continue;
                if (DoAction(vmId, context, action)) return true;
            }
        }

        var count = getVisibleChildrenCount(vmId, context);
        if (count <= 0) return false;
        for (var start = 0; start < count; start += 256)
        {
            if (!getVisibleChildren(vmId, context, start, _visible)) break;
            var returned = Marshal.ReadInt32(_visible, 0);
            for (var i = 0; i < returned; i++)
            {
                var child = Marshal.ReadInt64(_visible, VisibleChildrenOffset + i * 8);
                if (child != 0 && InvokeDeep(vmId, child, name, className, depth + 1)) return true;
            }
            if (returned < 256) break;
        }
        return false;
    }

    private static bool IsActivatable(string action)
    {
        var a = action.ToLowerInvariant();
        return a.Contains("press") || a.Contains("click") || a.Contains("expand") || a.Contains("toggle")
            || a.Contains("activate") || a.Contains("push") || a.Contains("open") || a.Contains("select");
    }

    private static bool DoAction(long vmId, long context, string action)
    {
        // AccessibleActionsToDo: an array of action names, null-terminated.
        var buffer = Marshal.AllocHGlobal(64);
        try
        {
            for (var i = 0; i < 8; i++) Marshal.WriteIntPtr(buffer, i * 8, IntPtr.Zero);
            var namePtr = Marshal.StringToHGlobalUni(action);
            try { Marshal.WriteIntPtr(buffer, 0, namePtr); }
            finally { Marshal.FreeHGlobal(namePtr); }
            var failure = 0;
            return doAccessibleActions(vmId, context, buffer, ref failure);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    [DllImport(DllName)]
    private static extern bool doAccessibleActions(long vmId, long context, IntPtr actionsToDo, ref int failure);

    /// <summary>Writes text into the Java component at a given tree index.</summary>
    public static bool SetTextByIndex(IntPtr hwnd, int index, string value)
    {
        if (!Connect(hwnd)) return false;
        lock (Gate)
        {
            if (!getAccessibleContextFromHWND(hwnd, out var vmId, out var root)) return false;
            return SetTextAt(vmId, root, index, value, 0);
        }
    }

    private static bool SetTextAt(long vmId, long context, int target, string value, int depth)
    {
        if (depth > 12) return false;
        getAccessibleContextInfo(vmId, context, _info);
        var role = ReadWide(OffRoleEn, 256);
        if (role.Length == 0) role = ReadWide(OffRole, 256);
        if (target == 0)
        {
            var isField = role.Contains("text", StringComparison.OrdinalIgnoreCase)
                || role.Contains("editable", StringComparison.OrdinalIgnoreCase)
                || role.Contains("password", StringComparison.OrdinalIgnoreCase);
            if (isField) return setTextContents(vmId, context, value);
        }
        var count = getVisibleChildrenCount(vmId, context);
        if (count <= 0) return false;
        var seen = 0;
        for (var start = 0; start < count; start += 256)
        {
            if (!getVisibleChildren(vmId, context, start, _visible)) break;
            var returned = Marshal.ReadInt32(_visible, 0);
            for (var i = 0; i < returned; i++)
            {
                var child = Marshal.ReadInt64(_visible, VisibleChildrenOffset + i * 8);
                if (child == 0) continue;
                seen++;
                if (seen == target) return SetTextAt(vmId, child, 0, value, depth + 1);
            }
            if (returned < 256) break;
        }
        return false;
    }

    /// <summary>Invokes the Java component at a given tree index.</summary>
    public static bool InvokeByIndex(IntPtr hwnd, int index)
    {
        if (!Connect(hwnd)) return false;
        lock (Gate)
        {
            if (!getAccessibleContextFromHWND(hwnd, out var vmId, out var root)) return false;
            return InvokeAt(vmId, root, index, 0);
        }
    }

    private static bool InvokeAt(long vmId, long context, int target, int depth)
    {
        if (depth > 12) return false;
        getAccessibleContextInfo(vmId, context, _info);
        if (target == 0)
        {
            var actions = getAccessibleActionsCount(vmId, context);
            for (var i = 0; i < actions; i++)
            {
                var action = getAccessibleActionName(vmId, context, i);
                if (string.IsNullOrEmpty(action) || !IsActivatable(action)) continue;
                if (DoAction(vmId, context, action)) return true;
            }
        }
        var count = getVisibleChildrenCount(vmId, context);
        if (count <= 0) return false;
        var seen = 0;
        for (var start = 0; start < count; start += 256)
        {
            if (!getVisibleChildren(vmId, context, start, _visible)) break;
            var returned = Marshal.ReadInt32(_visible, 0);
            for (var i = 0; i < returned; i++)
            {
                var child = Marshal.ReadInt64(_visible, VisibleChildrenOffset + i * 8);
                if (child == 0) continue;
                seen++;
                if (seen == target) return InvokeAt(vmId, child, 0, depth + 1);
            }
            if (returned < 256) break;
        }
        return false;
    }

    // ---- internals -------------------------------------------------------

    private sealed record Node(long Context, long VmId, string Role, string Name, int X, int Y, int W, int H, int Depth);

    private static void Walk(long vmId, long context, int depth, int maxDepth, int maxNodes, List<JabNode> outNodes)
    {
        if (depth > maxDepth || outNodes.Count >= maxNodes) return;
        getAccessibleContextInfo(vmId, context, _info);
        var role = ReadWide(OffRoleEn, 256);
        if (role.Length == 0) role = ReadWide(OffRole, 256);
        var name = ReadWide(OffName, 1024);
        var description = ReadWide(OffDescription, 1024);
        var x = Marshal.ReadInt32(_info, OffX);
        var y = Marshal.ReadInt32(_info, OffY);
        var w = Marshal.ReadInt32(_info, OffWidth);
        var h = Marshal.ReadInt32(_info, OffHeight);
        var index = outNodes.Count;
        var text = ReadNodeText(vmId, context, role);
        outNodes.Add(new JabNode(role, name, description, x, y, w, h, depth, index, text));

        var count = getVisibleChildrenCount(vmId, context);
        if (count <= 0) return;
        for (var start = 0; start < count; start += 256)
        {
            if (!getVisibleChildren(vmId, context, start, _visible)) break;
            var returned = Marshal.ReadInt32(_visible, 0);
            for (var i = 0; i < returned && outNodes.Count < maxNodes; i++)
            {
                var child = Marshal.ReadInt64(_visible, VisibleChildrenOffset + i * 8);
                if (child != 0) Walk(vmId, child, depth + 1, maxDepth, maxNodes, outNodes);
            }
            if (returned < 256) break;
        }
    }

    /// <summary>
    /// The text a Java component holds. The text handle is not exposed by the
    /// native DLL, so this reports the component's description (Swing puts the
    /// value of a text field there often enough to be useful) and the caller
    /// falls back to focus+copy for the real value.
    /// </summary>
    private static string ReadNodeText(long vmId, long context, string role)
    {
        var description = ReadWide(OffDescription, 1024);
        if (description.Length > 0) return description;
        return "";
    }

    private static string ReadWide(int offset, int chars)
    {
        var bytes = new byte[chars * 2];
        Marshal.Copy(IntPtr.Add(_info, offset), bytes, 0, chars * 2);
        var end = 0;
        for (var i = 0; i < chars; i++)
        {
            if (bytes[i * 2] == 0 && bytes[i * 2 + 1] == 0) { end = i; break; }
        }
        if (end == 0) return "";
        return Encoding.Unicode.GetString(bytes, 0, end * 2);
    }

    /// <summary>
    /// Ensures the AT side is connected to the JVM. Retries with a fresh
    /// broadcast: the JVM answers from its AWT thread, which can be busy.
    /// </summary>
    private static bool Connect(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return false;
        if (!EnsureLoaded()) return false;
        if (isJavaWindow(hwnd)) return true;

        // The AT thread broadcasts on its own; just wait for the JVM to answer.
        for (var attempt = 0; attempt < 20; attempt++)
        {
            for (var wait = 0; wait < 10; wait++)
            {
                Thread.Sleep(120);
                if (isJavaWindow(hwnd))
                {
                    Log.Info("jab: connected to the Java application", new { hwnd = hwnd.ToInt64(), attempt });
                    return true;
                }
            }
        }
        Log.Info("jab: the Java application did not answer the bridge handshake", new { hwnd = hwnd.ToInt64() });
        return false;
    }

    /// <summary>
    /// Finds the JAB native library: next to the java.exe on PATH, or in the
    /// JREs Oracle/JDK install. The agent loads it by absolute path because it
    /// is not in the system directory.
    /// </summary>
    private static string? FindBridgeLibrary()
    {
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            var candidate = Path.Combine(dir.Trim(), DllName);
            if (File.Exists(candidate)) return candidate;
        }
        foreach (var root in new[]
                 {
                     Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                     Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                 })
        {
            if (string.IsNullOrEmpty(root)) continue;
            var javaDir = Path.Combine(root, "Java");
            if (!Directory.Exists(javaDir)) continue;
            try
            {
                foreach (var jre in Directory.EnumerateDirectories(javaDir))
                {
                    var candidate = Path.Combine(jre, "bin", DllName);
                    if (File.Exists(candidate)) return candidate;
                }
            }
            catch (Exception)
            {
                // ignore
            }
        }
        return null;
    }

    /// <summary>
    /// Turns the Java Access Bridge on for the current user, so the NEXT launch
    /// of a Java app exposes its component tree. It cannot help an app that is
    /// already running: the JVM reads the property file at startup.
    /// </summary>
    private static void EnsureBridgeEnabled()
    {
        try
        {
            var props = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".accessibility.properties");
            if (File.Exists(props))
            {
                var text = File.ReadAllText(props);
                if (text.Contains("com.sun.java.accessibility.AccessBridge", StringComparison.Ordinal)) return;
            }
            foreach (var jabswitch in FindJabswitch())
            {
                var psi = new System.Diagnostics.ProcessStartInfo(jabswitch, "-enable")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                };
                using var proc = System.Diagnostics.Process.Start(psi);
                proc?.WaitForExit(5000);
                Log.Info("jab: enabled the Java Access Bridge; restart the Java app to expose its tree",
                    new { jabswitch, properties = props });
                return;
            }
        }
        catch (Exception ex)
        {
            Log.Debug("jab: could not enable the bridge", new { error = ex.Message });
        }
    }

    /// <summary>The jabswitch tool of the installed JREs (JDK-only tool).</summary>
    private static IEnumerable<string> FindJabswitch()
    {
        foreach (var root in new[]
                 {
                     Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                     Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                 })
        {
            if (string.IsNullOrEmpty(root)) continue;
            var javaDir = Path.Combine(root, "Java");
            if (!Directory.Exists(javaDir)) continue;
            string[] jres;
            try { jres = Directory.GetDirectories(javaDir); }
            catch (Exception) { continue; }
            foreach (var jre in jres)
            {
                var candidate = Path.Combine(jre, "bin", "jabswitch.exe");
                if (File.Exists(candidate)) yield return candidate;
            }
        }
    }

    /// <summary>
    /// The bridge needs three things on ONE thread: its status dialog, the
    /// hello broadcast and the message pump. Windows delivers a window's
    /// messages to the thread that created it, so doing the broadcast from a
    /// job thread (busy waiting) while the dialog lives elsewhere means the
    /// JVM's answer is queued where nobody pumps it and the handshake never
    /// completes. This thread owns all three.
    /// </summary>
    private static void AtThread()
    {
        var path = FindBridgeLibrary();
        if (path is null)
        {
            EnsureBridgeEnabled();
            Log.Info("jab: the Java Access Bridge library was not found",
                new { hint = "install a JRE with jabswitch and enable the bridge" });
            return;
        }
        var dll = LoadLibrary(path);
        if (dll == IntPtr.Zero)
        {
            Log.Info("jab: the bridge library could not be loaded", new { path, error = Marshal.GetLastWin32Error() });
            return;
        }
        // Publish it so EnsureLoaded() knows the bridge is up.
        _dll = dll;
        var dialog = CreateDialogParam(dll, DialogTemplate, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        Log.Info("jab: bridge loaded", new { path, dialog = dialog.ToInt64(), error = dialog == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0 });

        while (_atRun)
        {
            try
            {
                // Broadcast the hello from this thread, so the dialog the JVM
                // answers to belongs to the thread that pumps messages.
                Windows_run();
                var until = Environment.TickCount64 + 1000;
                while (Environment.TickCount64 < until)
                {
                    while (PeekMessage(_message, IntPtr.Zero, 0, 0, 1)) DispatchMessage(_message);
                    Thread.Sleep(20);
                }
            }
            catch (Exception ex)
            {
                Log.Debug("jab: the bridge thread hit an error", new { error = ex.Message });
                Thread.Sleep(500);
            }
        }
    }

    private static bool EnsureLoaded()
    {
        lock (Gate)
        {
            if (_dll != IntPtr.Zero) return true;
            var path = FindBridgeLibrary();
            if (path is null)
            {
                EnsureBridgeEnabled();
                Log.Info("jab: the Java Access Bridge library was not found",
                    new { hint = "install a JRE with jabswitch and enable the bridge" });
                return false;
            }
            _info = Marshal.AllocHGlobal(InfoSize);
            _visible = Marshal.AllocHGlobal(VisibleChildrenSize);
            _message = Marshal.AllocHGlobal(64);
            _atRun = true;
            _atThread = new Thread(AtThread) { IsBackground = true, Name = "jab-at" };
            _atThread.Start();
            // The thread loads the DLL; wait a moment for it to be ready.
            for (var i = 0; i < 50 && _dll == IntPtr.Zero; i++) Thread.Sleep(100);
            return _dll != IntPtr.Zero;
        }
    }
}

/// <summary>One node of a Java component tree.</summary>
public sealed record JabNode(
    string Role,
    string Name,
    string Description,
    int X,
    int Y,
    int Width,
    int Height,
    int Depth,
    int Index,
    string Text)
{
    /// <summary>UIA-ish control type derived from the JAB role.</summary>
    public string ControlType => Role switch
    {
        "push button" => "Button",
        "text" or "static text" => "Text",
        "password text" => "Edit",
        "text field" or "editable text" => "Edit",
        "combo box" => "ComboBox",
        "check box" => "CheckBox",
        "radio button" => "RadioButton",
        "label" => "Text",
        "list" or "list box" => "List",
        "table" => "Table",
        "tree" => "Tree",
        "panel" => "Pane",
        "dialog" => "Window",
        "frame" => "Window",
        _ => Role,
    };
}
