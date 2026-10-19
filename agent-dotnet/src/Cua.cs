using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text.Json;
using FlaUI.Core;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Definitions;
using FlaUI.Core.Input;
using FlaUI.Core.WindowsAPI;
using FlaUI.UIA3;

namespace Mrc.Agent;

/// <summary>
/// Windows automation for the agent_cua_* tools, now implemented INSIDE this
/// binary with FlaUI instead of the old mrc-cua.exe sidecar.
///
/// Why the change: the sidecar had to be compiled on the target with the
/// Framework's csc.exe (source embedded, .sha marker, remote-compile failure
/// modes). FlaUI is a plain NuGet package (152 KB, net8.0-windows), so the
/// engine ships in this exe and nothing is compiled at runtime.
///
/// Tool names and result shapes are unchanged, so the hub tools keep working:
///   list_windows, get_window_state, click, type_text, press_key, scroll,
///   focus, screenshot.
/// The browser_* tools stay on the CDP client (BrowserCdp.cs) and recording
/// stays on the ffmpeg/MJPEG path (Record.cs).
/// </summary>
public static class Cua
{
    private static readonly UIA3Automation Automation = new();
    private static readonly object Gate = new();
    private static AutomationElement? _foreground;

    // ------------------------------------------------------------------- job

    public static async Task<JobOutcome> JobCall(JsonElement p, JobContext ctx, CancellationToken ct)
    {
        var tool = Fs.ReadString(p, "tool");
        if (string.IsNullOrEmpty(tool)) return JobOutcome.Failure("invalid cua params: tool: Required");
        try
        {
            var meta = tool switch
            {
                "version" => Version(),
                "list_windows" => ListWindows(),
                "get_window_state" => WindowState(p),
                "click" => Click(p),
                "type_text" => TypeText(p),
                "press_key" => PressKey(p),
                "scroll" => Scroll(p),
                "screenshot" => Capture(p),
                "focus" => FocusJob(p),
                "find_element" => FindElement(p),
                "invoke" => InvokeElement(p),
                "set_value" => SetValue(p),
                "wait_for" => await WaitForAsync(p, ct),
                "table_read" => TableRead(p),
                "clipboard_set" => ClipboardSet(p),
                _ => throw new InvalidOperationException($"unknown tool '{tool}'"),
            };
            return JobOutcome.Success(meta);
        }
        catch (Exception ex)
        {
            return JobOutcome.Failure(ex.Message);
        }
    }

    // -------------------------------------------------------------- inventory

    private static Dictionary<string, object?> Version() => new()
    {
        ["ok"] = true,
        ["version"] = "1.0",
        ["engine"] = "flaui/uia3",
        ["platform"] = "windows",
    };

    private static Dictionary<string, object?> ListWindows()
    {
        var windows = new List<Dictionary<string, object?>>();
        lock (Gate)
        {
            var desktop = Automation.GetDesktop();
            foreach (var window in desktop.FindAllChildren())
            {
                try
                {
                    if (window.IsOffscreen) continue;
                    var rect = window.BoundingRectangle;
                    if (rect.Width < 1 || rect.Height < 1) continue;
                    windows.Add(new Dictionary<string, object?>
                    {
                        ["hwnd"] = window.Properties.NativeWindowHandle.ValueOrDefault.ToInt64(),
                        ["pid"] = window.Properties.ProcessId.ValueOrDefault,
                        ["process"] = ProcessName(window.Properties.ProcessId.ValueOrDefault),
                        ["class"] = window.ClassName,
                        ["title"] = window.Name,
                        ["visible"] = !window.IsOffscreen,
                        ["bounds"] = Bounds(rect),
                    });
                }
                catch (Exception)
                {
                    // a window can vanish mid-enumeration
                }
            }
        }
        return new Dictionary<string, object?> { ["ok"] = true, ["windows"] = windows };
    }

    /// <summary>ControlView tree with role, name, automation id, pid and screen rect.</summary>
    private static Dictionary<string, object?> WindowState(JsonElement p)
    {
        var maxElements = Fs.ReadInt(p, "max_elements") ?? 80;
        var window = ResolveWindow(p);
        var lines = new List<string>();
        var count = 0;

        void Walk(AutomationElement element, int depth)
        {
            if (count >= maxElements) return;
            try
            {
                var rect = element.BoundingRectangle;
                var id = element.AutomationId;
                lines.Add(
                    $"{new string(' ', depth * 2)}- [{element.ControlType}] {element.Name} " +
                    $"id={id} pid={element.Properties.ProcessId.ValueOrDefault} " +
                    $"screen({(int)rect.X},{(int)rect.Y} {(int)rect.Width}x{(int)rect.Height})");
                count++;
                foreach (var child in element.FindAllChildren())
                {
                    if (count >= maxElements) break;
                    Walk(child, depth + 1);
                }
            }
            catch (Exception)
            {
                // element disappeared
            }
        }

        Walk(window, 0);
        var meta = new Dictionary<string, object?>
        {
            ["ok"] = true,
            ["hwnd"] = window.Properties.NativeWindowHandle.ValueOrDefault.ToInt64(),
            ["pid"] = window.Properties.ProcessId.ValueOrDefault,
            ["title"] = window.Name,
            ["class"] = window.ClassName,
            ["element_count"] = count,
            ["tree"] = string.Join("\n", lines),
        };

        if (Fs.ReadBool(p, "include_screenshot") || p.ValueKind == JsonValueKind.Object && p.TryGetProperty("include_screenshot", out var shot) && shot.ValueKind == JsonValueKind.True)
        {
            var path = Path.Combine(Path.GetTempPath(), $"mrc-cua-shot-{DateTime.Now:yyyyMMdd-HHmmss}.png");
            Screenshot.CaptureWindow((IntPtr)(window.Properties.NativeWindowHandle.ValueOrDefault.ToInt64()), "png", 80, path);
            meta["path"] = path;
        }
        return meta;
    }

    // ------------------------------------------------------------------ input

    private static Dictionary<string, object?> Click(JsonElement p)
    {
        RequireConfirm(p, "click");
        var x = Fs.ReadInt(p, "x") ?? throw new InvalidOperationException("click requires x and y");
        var y = Fs.ReadInt(p, "y") ?? throw new InvalidOperationException("click requires x and y");
        var window = ResolveWindow(p);
        StealForeground(window);

        var button = Fs.ReadString(p, "button") ?? "left";
        var doubleClick = Fs.ReadBool(p, "double_click");
        var point = new System.Drawing.Point(x, y);
        if (doubleClick)
        {
            if (button == "right")
            {
                Mouse.RightClick(point);
                Mouse.RightClick(point);
            }
            else
            {
                Mouse.DoubleClick(point);
            }
        }
        else
        {
            switch (button)
            {
                case "right": Mouse.RightClick(point); break;
                case "middle": Mouse.Click(point, MouseButton.Middle); break;
                default: Mouse.Click(point); break;
            }
        }
        return new Dictionary<string, object?>
        {
            ["ok"] = true,
            ["clicked"] = new Dictionary<string, object?> { ["x"] = x, ["y"] = y, ["button"] = button, ["double"] = doubleClick },
        };
    }

    private static Dictionary<string, object?> TypeText(JsonElement p)
    {
        RequireConfirm(p, "type_text");
        var text = Fs.ReadString(p, "text") ?? "";
        var window = ResolveWindow(p);
        StealForeground(window);
        Keyboard.Type(text);
        return new Dictionary<string, object?> { ["ok"] = true, ["typed_chars"] = text.Length };
    }

    private static Dictionary<string, object?> PressKey(JsonElement p)
    {
        RequireConfirm(p, "press_key");
        var key = (Fs.ReadString(p, "key") ?? "").ToLowerInvariant();
        if (key.Length == 0) throw new InvalidOperationException("press_key requires 'key'");
        var window = ResolveWindow(p);
        StealForeground(window);

        var virtualKey = VirtualKeyOf(key);
        var modifiers = ParseModifiers(Fs.ReadString(p, "modifiers"));
        foreach (var modifier in modifiers) Keyboard.Press(modifier);
        if (virtualKey is not null) Keyboard.Press(virtualKey.Value);
        else if (key.Length == 1) Keyboard.Type(key);
        else throw new InvalidOperationException($"unknown key '{key}'");
        for (var i = modifiers.Count - 1; i >= 0; i--) Keyboard.Release(modifiers[i]);

        return new Dictionary<string, object?> { ["ok"] = true, ["key"] = key };
    }

    private static Dictionary<string, object?> Scroll(JsonElement p)
    {
        RequireConfirm(p, "scroll");
        var x = Fs.ReadInt(p, "x") ?? throw new InvalidOperationException("scroll requires x and y");
        var y = Fs.ReadInt(p, "y") ?? throw new InvalidOperationException("scroll requires x and y");
        var ticks = Fs.ReadInt(p, "ticks") ?? 0;
        var window = ResolveWindow(p);
        StealForeground(window);
        Mouse.Position = new System.Drawing.Point(x, y);
        Mouse.Scroll(ticks);
        return new Dictionary<string, object?>
        {
            ["ok"] = true,
            ["scrolled"] = new Dictionary<string, object?> { ["x"] = x, ["y"] = y, ["delta"] = ticks },
        };
    }

    private static Dictionary<string, object?> FocusJob(JsonElement p)
    {
        var window = ResolveWindow(p);
        StealForeground(window);
        return new Dictionary<string, object?>
        {
            ["ok"] = true,
            ["focused_hwnd"] = window.Properties.NativeWindowHandle.ValueOrDefault.ToInt64(),
        };
    }

    private static Dictionary<string, object?> Capture(JsonElement p)
    {
        var format = (Fs.ReadString(p, "format") ?? "png").ToLowerInvariant();
        var quality = Math.Clamp(Fs.ReadInt(p, "quality") ?? 80, 1, 100);
        var path = Path.Combine(Path.GetTempPath(), $"mrc-cua-shot-{DateTime.Now:yyyyMMdd-HHmmss}.{(format == "jpeg" ? "jpg" : "png")}");

        var windowId = Fs.ReadInt(p, "window_id");
        if (windowId is not null)
        {
            Screenshot.CaptureWindow((IntPtr)windowId.Value, format, quality, path);
        }
        else
        {
            Screenshot.CaptureScreen(format, quality, path);
        }
        var bytes = new FileInfo(path).Length;
        return new Dictionary<string, object?> { ["ok"] = true, ["path"] = path, ["bytes"] = bytes, ["format"] = format };
    }

    // ------------------------------------------------------- element-oriented

    /// <summary>
    /// find_element: locate a control by name / automation id / class and return
    /// its identity and rect, so clicks stop depending on screen arithmetic.
    /// </summary>
    private static Dictionary<string, object?> FindElement(JsonElement p)
    {
        var name = Fs.ReadString(p, "name");
        var automationId = Fs.ReadString(p, "automation_id");
        var className = Fs.ReadString(p, "class_name");
        var controlType = Fs.ReadString(p, "control_type");
        if (name is null && automationId is null && className is null && controlType is null)
            throw new InvalidOperationException("find_element needs at least one of name, automation_id, class_name, control_type");

        var root = Fs.ReadBool(p, "whole_desktop") ? Automation.GetDesktop() : ResolveWindow(p);
        var matches = FindAll(root, name, automationId, className, controlType, Fs.ReadInt(p, "max_results") ?? 20);
        if (matches.Count == 0) throw new InvalidOperationException("no element matched the given criteria");

        var nth = Fs.ReadInt(p, "nth") ?? 0;
        if (nth < 0 || nth >= matches.Count)
            throw new InvalidOperationException($"nth {nth} out of range ({matches.Count} matches)");

        var target = matches[nth];
        var rect = target.BoundingRectangle;
        return new Dictionary<string, object?>
        {
            ["ok"] = true,
            ["matches"] = matches.Count,
            ["element"] = Describe(target, rect),
            ["click_point"] = new Dictionary<string, object?>
            {
                ["x"] = (int)(rect.X + rect.Width / 2),
                ["y"] = (int)(rect.Y + rect.Height / 2),
            },
        };
    }

    /// <summary>invoke: activate a control through UIA instead of clicking a point.</summary>
    private static Dictionary<string, object?> InvokeElement(JsonElement p)
    {
        RequireConfirm(p, "invoke");
        var target = ResolveElement(p);
        StealForeground(target);

        var via = "invoke";
        try
        {
            var button = target.AsButton();
            button.Invoke();
        }
        catch (Exception)
        {
            // Fall back to a real click on the element's centre: some controls
            // expose no InvokePattern (custom canvases, some webviews).
            var rect = target.BoundingRectangle;
            if (rect.Width < 1 || rect.Height < 1)
                throw new InvalidOperationException("the element exposes no InvokePattern and has no on-screen rect");
            Mouse.Click(new System.Drawing.Point((int)(rect.X + rect.Width / 2), (int)(rect.Y + rect.Height / 2)));
            via = "mouse";
        }

        var finalRect = target.BoundingRectangle;
        return new Dictionary<string, object?>
        {
            ["ok"] = true,
            ["via"] = via,
            ["element"] = Describe(target, finalRect),
        };
    }

    /// <summary>set_value: write into a field without stealing focus or clicking it.</summary>
    private static Dictionary<string, object?> SetValue(JsonElement p)
    {
        RequireConfirm(p, "set_value");
        var value = Fs.ReadString(p, "value") ?? throw new InvalidOperationException("set_value requires 'value'");
        var target = ResolveElement(p);

        try
        {
            var textBox = target.AsTextBox();
            textBox.Text = value;
            return new Dictionary<string, object?> { ["ok"] = true, ["via"] = "textbox", ["chars"] = value.Length };
        }
        catch (Exception)
        {
            // Non-textbox controls may still expose the generic value pattern.
        }
        if (target.Patterns.Value.TryGetPattern(out var valuePattern))
        {
            valuePattern.SetValue(value);
            return new Dictionary<string, object?> { ["ok"] = true, ["via"] = "value-pattern", ["chars"] = value.Length };
        }
        throw new InvalidOperationException("the element does not accept a value (no TextBox or ValuePattern)");
    }

    /// <summary>
    /// wait_for: block until an element shows up (or disappears) instead of
    /// sleeping a fixed time. Polls the same criteria find_element accepts.
    /// </summary>
    private static async Task<Dictionary<string, object?>> WaitForAsync(JsonElement p, CancellationToken ct)
    {
        var name = Fs.ReadString(p, "name");
        var automationId = Fs.ReadString(p, "automation_id");
        var className = Fs.ReadString(p, "class_name");
        var controlType = Fs.ReadString(p, "control_type");
        if (name is null && automationId is null && className is null && controlType is null)
            throw new InvalidOperationException("wait_for needs at least one of name, automation_id, class_name, control_type");

        var timeoutMs = Math.Clamp(Fs.ReadInt(p, "timeout_ms") ?? 15_000, 200, 120_000);
        var wantGone = Fs.ReadBool(p, "until_gone");
        var pollMs = Math.Clamp(Fs.ReadInt(p, "poll_ms") ?? 250, 50, 5_000);
        var root = Fs.ReadBool(p, "whole_desktop") ? Automation.GetDesktop() : ResolveWindow(p);
        var deadline = Environment.TickCount64 + timeoutMs;

        while (Environment.TickCount64 < deadline)
        {
            ct.ThrowIfCancellationRequested();
            var matches = FindAll(root, name, automationId, className, controlType, 1);
            var present = matches.Count > 0;
            if (present != wantGone)
            {
                if (!present)
                    return new Dictionary<string, object?>
                    {
                        ["ok"] = true,
                        ["present"] = false,
                        ["waited_ms"] = timeoutMs - (int)(deadline - Environment.TickCount64),
                    };
                var target = matches[0];
                return new Dictionary<string, object?>
                {
                    ["ok"] = true,
                    ["present"] = true,
                    ["waited_ms"] = timeoutMs - (int)(deadline - Environment.TickCount64),
                    ["element"] = Describe(target, target.BoundingRectangle),
                };
            }
            await Task.Delay(pollMs, ct).ConfigureAwait(false);
        }
        throw new InvalidOperationException(wantGone
            ? $"the element was still present after {timeoutMs}ms"
            : $"the element did not appear within {timeoutMs}ms");
    }

    /// <summary>
    /// table_read: read a grid/table as rows of cells. Uses GridPattern when the
    /// app exposes it (Excel, most datagrids) and falls back to walking the rows
    /// by control type, which covers ListView/TreeView-style tables.
    /// </summary>
    private static Dictionary<string, object?> TableRead(JsonElement p)
    {
        var maxRows = Math.Clamp(Fs.ReadInt(p, "max_rows") ?? 200, 1, 5_000);
        var maxCells = Math.Clamp(Fs.ReadInt(p, "max_cells") ?? 5_000, 1, 50_000);
        var root = ResolveElement(p);

        // 1) Preferred: the real grid pattern (tells us rows AND columns).
        if (root.Patterns.Grid.TryGetPattern(out var grid))
        {
            var rows = new List<List<string>>();
            var rowCount = Math.Min(grid.RowCount, maxRows);
            var colCount = grid.ColumnCount;
            var truncated = grid.RowCount > maxRows;
            for (var r = 0; r < rowCount && rows.Count * Math.Max(1, colCount) < maxCells; r++)
            {
                var row = new List<string>();
                for (var c = 0; c < colCount && rows.Count * Math.Max(1, colCount) + row.Count < maxCells; c++)
                {
                    try
                    {
                        row.Add(grid.GetItem(r, c)?.Name ?? "");
                    }
                    catch (Exception)
                    {
                        row.Add("");
                    }
                }
                rows.Add(row);
            }
            return new Dictionary<string, object?>
            {
                ["ok"] = true,
                ["via"] = "grid-pattern",
                ["row_count"] = grid.RowCount,
                ["column_count"] = colCount,
                ["returned_rows"] = rows.Count,
                ["truncated"] = truncated,
                ["rows"] = rows,
            };
        }

        // 2) Fallback: each descendant that looks like a row (a ListItem or a
        //    DataItem) contributes its children's names as cells.
        var container = root;
        var dataRows = container.FindAllDescendants()
            .Where(e => e.ControlType == ControlType.DataItem || e.ControlType == ControlType.ListItem)
            .Take(maxRows)
            .ToList();
        if (dataRows.Count == 0)
            throw new InvalidOperationException("the element exposes neither a GridPattern nor row-like children; try get_window_state");

        var fallbackRows = new List<List<string>>();
        foreach (var row in dataRows)
        {
            var cells = row.FindAllChildren()
                .Where(e => e.ControlType != ControlType.ScrollBar)
                .Select(e => e.Name ?? "")
                .ToList();
            if (cells.Count == 0) cells.Add(row.Name ?? "");
            fallbackRows.Add(cells);
        }
        return new Dictionary<string, object?>
        {
            ["ok"] = true,
            ["via"] = "row-children",
            ["row_count"] = dataRows.Count,
            ["returned_rows"] = fallbackRows.Count,
            ["truncated"] = dataRows.Count >= maxRows,
            ["rows"] = fallbackRows,
        };
    }

    /// <summary>clipboard_set: preload the clipboard (the paste-based input path).</summary>
    private static Dictionary<string, object?> ClipboardSet(JsonElement p)
    {
        RequireConfirm(p, "clipboard_set");
        var text = Fs.ReadString(p, "text") ?? throw new InvalidOperationException("clipboard_set requires 'text'");
        var attempts = 0;
        while (true)
        {
            try
            {
                System.Windows.Forms.Clipboard.SetText(text);
                return new Dictionary<string, object?> { ["ok"] = true, ["chars"] = text.Length };
            }
            catch (Exception ex) when (attempts++ < 5)
            {
                // The clipboard can be locked briefly by another process.
                Thread.Sleep(120);
                if (attempts >= 5) throw new InvalidOperationException($"the clipboard is busy: {ex.Message}");
            }
        }
    }

    /// <summary>Resolves the target element from explicit criteria or the whole window.</summary>
    private static AutomationElement ResolveElement(JsonElement p)
    {
        var name = Fs.ReadString(p, "name");
        var automationId = Fs.ReadString(p, "automation_id");
        var className = Fs.ReadString(p, "class_name");
        var controlType = Fs.ReadString(p, "control_type");
        if (name is null && automationId is null && className is null && controlType is null)
            throw new InvalidOperationException("provide at least one of name, automation_id, class_name, control_type (or use click with x/y)");

        var root = Fs.ReadBool(p, "whole_desktop") ? Automation.GetDesktop() : ResolveWindow(p);
        var matches = FindAll(root, name, automationId, className, controlType, 50);
        if (matches.Count == 0) throw new InvalidOperationException("no element matched the given criteria");
        var nth = Fs.ReadInt(p, "nth") ?? 0;
        if (nth < 0 || nth >= matches.Count) throw new InvalidOperationException($"nth {nth} out of range ({matches.Count} matches)");
        return matches[nth];
    }

    /// <summary>Substring match on Name/AutomationId (case-insensitive) + exact class/type.</summary>
    private static List<AutomationElement> FindAll(
        AutomationElement root, string? name, string? automationId, string? className, string? controlType, int max)
    {
        var results = new List<AutomationElement>();
        try
        {
            foreach (var element in root.FindAllDescendants())
            {
                if (results.Count >= max) break;
                try
                {
                    if (name is not null && !Contains(element.Name, name)) continue;
                    if (automationId is not null && !Contains(element.AutomationId, automationId)) continue;
                    if (className is not null && !Contains(element.ClassName, className)) continue;
                    if (controlType is not null &&
                        !string.Equals(element.ControlType.ToString(), controlType, StringComparison.OrdinalIgnoreCase)) continue;
                    results.Add(element);
                }
                catch (Exception)
                {
                    // element vanished between enumeration and inspection
                }
            }
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException($"element search failed: {ex.Message}");
        }
        return results;
    }

    private static bool Contains(string? value, string needle) =>
        value is not null && value.Contains(needle, StringComparison.OrdinalIgnoreCase);

    private static Dictionary<string, object?> Describe(AutomationElement element, System.Drawing.Rectangle rect) => new()
    {
        ["name"] = element.Name,
        ["automation_id"] = element.AutomationId,
        ["class_name"] = element.ClassName,
        ["control_type"] = element.ControlType.ToString(),
        ["enabled"] = element.IsEnabled,
        ["offscreen"] = element.IsOffscreen,
        ["pid"] = element.Properties.ProcessId.ValueOrDefault,
        ["bounds"] = Bounds(rect),
    };

    // --------------------------------------------------------------- helpers

    private static void RequireConfirm(JsonElement p, string tool)
    {
        if (!Fs.ReadBool(p, "confirm")) throw new InvalidOperationException($"{tool} requires confirm=1");
    }

    /// <summary>Targets a window by hwnd, or the pid's biggest window, or the desktop.</summary>
    private static AutomationElement ResolveWindow(JsonElement p)
    {
        var hwnd = Fs.ReadInt(p, "window_id");
        if (hwnd is not null)
        {
            var element = Automation.FromHandle((IntPtr)hwnd.Value);
            if (element is null) throw new InvalidOperationException($"no window with hwnd {hwnd.Value}");
            return element;
        }
        var pid = Fs.ReadInt(p, "pid");
        if (pid is not null)
        {
            var best = Automation.GetDesktop().FindAllChildren()
                .Where(w => w.Properties.ProcessId.ValueOrDefault == pid.Value)
                .OrderByDescending(w => w.BoundingRectangle.Width * (double)w.BoundingRectangle.Height)
                .FirstOrDefault();
            if (best is null) throw new InvalidOperationException($"no on-screen window for pid {pid.Value}");
            return best;
        }
        throw new InvalidOperationException("provide window_id (from agent_cua_list_windows) or pid");
    }

    private static void StealForeground(AutomationElement window)
    {
        try
        {
            var handle = (IntPtr)window.Properties.NativeWindowHandle.ValueOrDefault.ToInt64();
            if (handle != IntPtr.Zero) SetForegroundWindow(handle);
            window.Focus();
            _foreground = window;
        }
        catch (Exception)
        {
            // best effort: input still goes to whatever has focus
        }
    }

    private static string? ProcessName(int pid)
    {
        try
        {
            return System.Diagnostics.Process.GetProcessById(pid).ProcessName;
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static Dictionary<string, object?> Bounds(System.Drawing.Rectangle rect) => new()
    {
        ["x"] = (int)rect.X,
        ["y"] = (int)rect.Y,
        ["width"] = (int)rect.Width,
        ["height"] = (int)rect.Height,
    };

    private static List<FlaUI.Core.WindowsAPI.VirtualKeyShort> ParseModifiers(string? raw)
    {
        var result = new List<FlaUI.Core.WindowsAPI.VirtualKeyShort>();
        foreach (var part in (raw ?? "").Split(new[] { ',', '+' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            switch (part.ToLowerInvariant())
            {
                case "ctrl": case "control": result.Add(VirtualKeyShort.CONTROL); break;
                case "shift": result.Add(VirtualKeyShort.SHIFT); break;
                case "alt": result.Add(VirtualKeyShort.ALT); break;
                case "win": result.Add(VirtualKeyShort.LWIN); break;
            }
        }
        return result;
    }

    private static VirtualKeyShort? VirtualKeyOf(string key) => key switch
    {
        "enter" or "return" => VirtualKeyShort.RETURN,
        "escape" or "esc" => VirtualKeyShort.ESCAPE,
        "tab" => VirtualKeyShort.TAB,
        "backspace" => VirtualKeyShort.BACK,
        "space" => VirtualKeyShort.SPACE,
        "del" or "delete" => VirtualKeyShort.DELETE,
        "home" => VirtualKeyShort.HOME,
        "end" => VirtualKeyShort.END,
        "pageup" => VirtualKeyShort.PRIOR,
        "pagedown" => VirtualKeyShort.NEXT,
        "up" => VirtualKeyShort.UP,
        "down" => VirtualKeyShort.DOWN,
        "left" => VirtualKeyShort.LEFT,
        "right" => VirtualKeyShort.RIGHT,
        "f1" => VirtualKeyShort.F1, "f2" => VirtualKeyShort.F2, "f3" => VirtualKeyShort.F3,
        "f4" => VirtualKeyShort.F4, "f5" => VirtualKeyShort.F5, "f6" => VirtualKeyShort.F6,
        "f7" => VirtualKeyShort.F7, "f8" => VirtualKeyShort.F8, "f9" => VirtualKeyShort.F9,
        "f10" => VirtualKeyShort.F10, "f11" => VirtualKeyShort.F11, "f12" => VirtualKeyShort.F12,
        _ => null,
    };

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);
}
