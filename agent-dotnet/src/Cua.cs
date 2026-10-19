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
        // The hub wraps the tool parameters in `args` (the sidecar CLI shape);
        // unwrap once here so every handler reads a flat object.
        var args = p.ValueKind == JsonValueKind.Object && p.TryGetProperty("args", out var bag) && bag.ValueKind == JsonValueKind.Object
            ? bag
            : p;
        try
        {
            var meta = tool switch
            {
                "version" => Version(),
                "list_windows" => ListWindows(),
                "get_window_state" => WindowState(args),
                "click" => Click(args),
                "type_text" => TypeText(args),
                "press_key" => PressKey(args),
                "scroll" => Scroll(args),
                "screenshot" => Capture(args),
                "focus" => FocusJob(args),
                "find_element" => FindElement(args),
                "invoke" => InvokeElement(args),
                "set_value" => SetValue(args),
                "wait_for" => await WaitForAsync(args, ct),
                "table_read" => TableRead(args),
                "clipboard_set" => ClipboardSet(args),
                "clipboard_get" => ClipboardGet(),
                "window" => WindowControl(args),
                "send_hotkey" => SendHotkey(args),
                "drag" => Drag(args),
                "element_screenshot" => ElementScreenshot(args),
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

        // Java (Swing/AWT) apps expose nothing through UIA3, but they do
        // through the Java Access Bridge: read that tree instead.
        var hwnd = new IntPtr(window.Properties.NativeWindowHandle.ValueOrDefault.ToInt64());
        var jab = JavaAccessBridge.ReadTree(hwnd);
        if (jab.Count > 0)
        {
            foreach (var node in jab)
            {
                if (lines.Count >= maxElements) break;
                lines.Add(
                    $"{new string(' ', node.Depth * 2)}- [{node.ControlType}] {node.Name} " +
                    $"jab={node.Role} screen({node.X},{node.Y} {node.Width}x{node.Height})");
                count++;
            }
        }

        var meta = new Dictionary<string, object?>
        {
            ["ok"] = true,
            ["hwnd"] = hwnd.ToInt64(),
            ["pid"] = window.Properties.ProcessId.ValueOrDefault,
            ["title"] = window.Name,
            ["class"] = window.ClassName,
            ["element_count"] = count,
            ["tree"] = string.Join("\n", lines),
            ["engine"] = jab.Count > 0 ? "uia+jab" : "uia",
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
            var mouseButton = button switch
            {
                "right" => FlaUI.Core.Input.MouseButton.Right,
                "middle" => FlaUI.Core.Input.MouseButton.Middle,
                _ => FlaUI.Core.Input.MouseButton.Left,
            };
            DoubleClickAt(point, mouseButton);
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
        if (matches.Count == 0)
        {
            // Java apps are invisible to UIA3: fall back to the Java Access
            // Bridge, which does expose their components (with screen rects).
            var jabRoot = Fs.ReadBool(p, "whole_desktop")
                ? IntPtr.Zero
                : new IntPtr(ResolveWindow(p).Properties.NativeWindowHandle.ValueOrDefault.ToInt64());
            if (jabRoot != IntPtr.Zero)
            {
                var jabMatches = JavaAccessBridge.Find(jabRoot, name, className, controlType, Fs.ReadInt(p, "max_results") ?? 20);
                if (jabMatches.Count > 0)
                {
                    var jabNth = Fs.ReadInt(p, "nth") ?? 0;
                    if (jabNth < 0 || jabNth >= jabMatches.Count)
                        throw new InvalidOperationException($"nth {jabNth} out of range ({jabMatches.Count} matches)");
                    var node = jabMatches[jabNth];
                    return new Dictionary<string, object?>
                    {
                        ["ok"] = true,
                        ["matches"] = jabMatches.Count,
                        ["via"] = "jab",
                        ["element"] = new Dictionary<string, object?>
                        {
                            ["name"] = node.Name,
                            ["class_name"] = node.Role,
                            ["control_type"] = node.ControlType,
                            ["description"] = node.Description,
                            ["bounds"] = new Dictionary<string, object?>
                            {
                                ["x"] = node.X,
                                ["y"] = node.Y,
                                ["width"] = node.Width,
                                ["height"] = node.Height,
                            },
                        },
                        ["click_point"] = new Dictionary<string, object?>
                        {
                            ["x"] = node.X + node.Width / 2,
                            ["y"] = node.Y + node.Height / 2,
                        },
                        // Java components often have an empty accessible name
                        // (a text field is named by the label next to it), so
                        // the tree index is the reliable handle.
                        ["index"] = node.Index,
                        ["text"] = node.Text,
                    };
                }
            }
            throw new InvalidOperationException("no element matched the given criteria");
        }

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

        // Java components: UIA3 has no InvokePattern for them, so go through
        // the Java Access Bridge's own actions (press / click / expand).
        var javaWindow = new IntPtr(target.Properties.NativeWindowHandle.ValueOrDefault.ToInt64());
        if (javaWindow != IntPtr.Zero && JavaAccessBridge.IsAvailable(javaWindow))
        {
            var jabName = Fs.ReadString(p, "name");
            var jabClass = Fs.ReadString(p, "class_name");
            var jabIndex = Fs.ReadInt(p, "jab_index");
            var jabDone = jabIndex is not null
                ? JavaAccessBridge.InvokeByIndex(javaWindow, jabIndex.Value)
                : JavaAccessBridge.Invoke(javaWindow, jabName, jabClass);
            if (jabDone)
            {
                return new Dictionary<string, object?>
                {
                    ["ok"] = true,
                    ["via"] = "jab",
                    ["element"] = new Dictionary<string, object?>
                    {
                        ["name"] = jabName ?? "",
                        ["class_name"] = jabClass ?? "",
                        ["control_type"] = "Button",
                    },
                };
            }
        }

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
        // Java text fields: write through the Java Access Bridge. Prefer the
        // tree index (Java fields have no accessible name of their own).
        var jabWindow = new IntPtr(target.Properties.NativeWindowHandle.ValueOrDefault.ToInt64());
        if (jabWindow != IntPtr.Zero)
        {
            var jabIndex = Fs.ReadInt(p, "jab_index");
            var jabName = Fs.ReadString(p, "name");
            var jabClass = Fs.ReadString(p, "class_name");
            var done = jabIndex is not null
                ? JavaAccessBridge.SetTextByIndex(jabWindow, jabIndex.Value, value)
                : JavaAccessBridge.SetText(jabWindow, jabName, jabClass, value);
            if (done)
                return new Dictionary<string, object?> { ["ok"] = true, ["via"] = "jab", ["chars"] = value.Length };
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
        // The clipboard is an OLE/COM object and needs an STA thread even
        // though the agent runs its jobs on the thread pool.
        Dictionary<string, object?>? result = null;
        Exception? captured = null;
        var thread = new Thread(() =>
        {
            var attempts = 0;
            while (true)
            {
                try
                {
                    System.Windows.Forms.Clipboard.SetText(text);
                    result = new Dictionary<string, object?> { ["ok"] = true, ["chars"] = text.Length };
                    return;
                }
                catch (Exception ex) when (attempts++ < 5)
                {
                    Thread.Sleep(120);
                    if (attempts >= 5) { captured = new InvalidOperationException($"the clipboard is busy: {ex.Message}"); return; }
                }
            }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        if (captured is not null) throw captured;
        return result!;
    }

    /// <summary>
    /// clipboard_get: read the clipboard. This is the extraction path for apps
    /// that expose no usable UIA tree (select-all + copy, then read here).
    /// </summary>
    private static Dictionary<string, object?> ClipboardGet()
    {
        Dictionary<string, object?>? result = null;
        Exception? captured = null;
        var thread = new Thread(() =>
        {
            var attempts = 0;
            while (true)
            {
                try
                {
                    var text = System.Windows.Forms.Clipboard.ContainsText()
                        ? System.Windows.Forms.Clipboard.GetText()
                        : "";
                    result = new Dictionary<string, object?>
                    {
                        ["ok"] = true,
                        ["has_text"] = text.Length > 0,
                        ["chars"] = text.Length,
                        ["text"] = text,
                    };
                    return;
                }
                catch (Exception ex) when (attempts++ < 5)
                {
                    Thread.Sleep(120);
                    if (attempts >= 5) { captured = new InvalidOperationException($"the clipboard is busy: {ex.Message}"); return; }
                }
            }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        if (captured is not null) throw captured;
        return result!;
    }

    /// <summary>window: close / minimize / maximize / restore / move / resize by hwnd.</summary>
    private static Dictionary<string, object?> WindowControl(JsonElement p)
    {
        var action = (Fs.ReadString(p, "action") ?? "").ToLowerInvariant();
        if (action.Length == 0)
            throw new InvalidOperationException("window requires 'action' (close, minimize, maximize, restore, move)");
        RequireConfirm(p, "window");

        // Hwnd targeting is mandatory: a window may be off-screen or have no
        // usable tree, and those are exactly the cases this tool exists for.
        var hwnd = Fs.ReadInt(p, "window_id")
                   ?? throw new InvalidOperationException("window requires window_id (from agent_cua_list_windows)");

        switch (action)
        {
            case "close":
                if (!PostMessage((IntPtr)hwnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero))
                    throw new InvalidOperationException($"WM_CLOSE failed for hwnd {hwnd}");
                return new Dictionary<string, object?> { ["ok"] = true, ["action"] = "close", ["hwnd"] = hwnd };

            case "minimize":
                ShowWindow((IntPtr)hwnd, SW_MINIMIZE);
                return new Dictionary<string, object?> { ["ok"] = true, ["action"] = "minimize", ["hwnd"] = hwnd };

            case "maximize":
                ShowWindow((IntPtr)hwnd, SW_MAXIMIZE);
                return new Dictionary<string, object?> { ["ok"] = true, ["action"] = "maximize", ["hwnd"] = hwnd };

            case "restore":
                ShowWindow((IntPtr)hwnd, SW_RESTORE);
                return new Dictionary<string, object?> { ["ok"] = true, ["action"] = "restore", ["hwnd"] = hwnd };

            case "move":
            {
                var x = Fs.ReadInt(p, "x") ?? throw new InvalidOperationException("window move requires x and y");
                var y = Fs.ReadInt(p, "y") ?? throw new InvalidOperationException("window move requires x and y");
                var width = Fs.ReadInt(p, "width") ?? 0;
                var height = Fs.ReadInt(p, "height") ?? 0;
                if (width <= 0 || height <= 0)
                {
                    if (!GetWindowRect((IntPtr)hwnd, out var current))
                        throw new InvalidOperationException($"could not read the current bounds of hwnd {hwnd}");
                    width = width <= 0 ? current.Right - current.Left : width;
                    height = height <= 0 ? current.Bottom - current.Top : height;
                }
                if (!MoveWindow((IntPtr)hwnd, x, y, width, height, true))
                    throw new InvalidOperationException($"MoveWindow failed for hwnd {hwnd}");
                return new Dictionary<string, object?>
                {
                    ["ok"] = true, ["action"] = "move", ["hwnd"] = hwnd,
                    ["bounds"] = new Dictionary<string, object?> { ["x"] = x, ["y"] = y, ["width"] = width, ["height"] = height },
                };
            }

            default:
                throw new InvalidOperationException($"unknown window action '{action}' (close, minimize, maximize, restore, move)");
        }
    }

    /// <summary>
    /// send_hotkey: one atomic shortcut (ctrl+s, alt+f4, ctrl+shift+t). A
    /// "+"-separated chord is pressed and released together, which is what
    /// menus and apps expect.
    /// </summary>
    private static Dictionary<string, object?> SendHotkey(JsonElement p)
    {
        RequireConfirm(p, "send_hotkey");
        var combo = Fs.ReadString(p, "keys") ?? throw new InvalidOperationException("send_hotkey requires 'keys' (e.g. \"ctrl+s\")");
        var parts = combo.Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (parts.Length == 0) throw new InvalidOperationException("send_hotkey requires at least one key");

        if (Fs.ReadInt(p, "window_id") is not null || Fs.ReadInt(p, "pid") is not null)
            StealForeground(ResolveWindow(p));

        var modifiers = new List<VirtualKeyShort>();
        VirtualKeyShort? final = null;
        foreach (var part in parts)
        {
            switch (part.ToLowerInvariant())
            {
                case "ctrl": case "control": modifiers.Add(VirtualKeyShort.CONTROL); break;
                case "shift": modifiers.Add(VirtualKeyShort.SHIFT); break;
                case "alt": modifiers.Add(VirtualKeyShort.ALT); break;
                case "win": modifiers.Add(VirtualKeyShort.LWIN); break;
                default:
                    var key = VirtualKeyOf(part.ToLowerInvariant());
                    if (key is null && part.Length == 1) key = (VirtualKeyShort)char.ToUpperInvariant(part[0]);
                    if (key is null) throw new InvalidOperationException($"unknown key '{part}' in '{combo}'");
                    final = key;
                    break;
            }
        }
        if (final is null) throw new InvalidOperationException($"'{combo}' has no final key (only modifiers)");

        foreach (var modifier in modifiers) Keyboard.Press(modifier);
        Keyboard.Press(final.Value);
        Keyboard.Release(final.Value);
        for (var i = modifiers.Count - 1; i >= 0; i--) Keyboard.Release(modifiers[i]);

        return new Dictionary<string, object?> { ["ok"] = true, ["keys"] = combo };
    }

    /// <summary>
    /// drag: press, move and release between two points (or two elements) - the
    /// gesture for sliders, reordering, selecting text and dragging files.
    /// Stepped moves keep apps from dropping the drag.
    /// </summary>
    private static Dictionary<string, object?> Drag(JsonElement p)
    {
        RequireConfirm(p, "drag");
        var (fromX, fromY) = ResolveDragPoint(p, "from");
        var (toX, toY) = ResolveDragPoint(p, "to");

        var button = (Fs.ReadString(p, "button") ?? "left").ToLowerInvariant();
        if (Fs.ReadInt(p, "window_id") is not null || Fs.ReadInt(p, "pid") is not null)
            StealForeground(ResolveWindow(p));

        var mouseButton = button switch
        {
            "right" => FlaUI.Core.Input.MouseButton.Right,
            "middle" => FlaUI.Core.Input.MouseButton.Middle,
            _ => FlaUI.Core.Input.MouseButton.Left,
        };

        Mouse.Position = new System.Drawing.Point(fromX, fromY);
        Thread.Sleep(60);
        Mouse.Down(mouseButton);
        for (var step = 1; step <= 8; step++)
        {
            var x = fromX + (toX - fromX) * step / 8;
            var y = fromY + (toY - fromY) * step / 8;
            Mouse.Position = new System.Drawing.Point(x, y);
            Thread.Sleep(30);
        }
        Mouse.Up(mouseButton);

        return new Dictionary<string, object?>
        {
            ["ok"] = true,
            ["from"] = new Dictionary<string, object?> { ["x"] = fromX, ["y"] = fromY },
            ["to"] = new Dictionary<string, object?> { ["x"] = toX, ["y"] = toY },
            ["button"] = button,
        };
    }

    /// <summary>Accepts "from"/"to" either as an x/y pair or as element criteria.</summary>
    private static (int X, int Y) ResolveDragPoint(JsonElement p, string prefix)
    {
        var x = Fs.ReadInt(p, $"{prefix}_x");
        var y = Fs.ReadInt(p, $"{prefix}_y");
        if (x is not null && y is not null) return (x.Value, y.Value);

        var name = Fs.ReadString(p, $"{prefix}_name");
        var automationId = Fs.ReadString(p, $"{prefix}_automation_id");
        if (name is null && automationId is null)
            throw new InvalidOperationException($"drag requires {prefix}_x/{prefix}_y or {prefix}_name/{prefix}_automation_id");

        var root = Fs.ReadBool(p, "whole_desktop") ? Automation.GetDesktop() : ResolveWindow(p);
        var matches = FindAll(root, name, automationId, null, null, 1);
        if (matches.Count == 0) throw new InvalidOperationException($"no element matched the {prefix} criteria");
        var rect = matches[0].BoundingRectangle;
        return ((int)(rect.X + rect.Width / 2), (int)(rect.Y + rect.Height / 2));
    }

    /// <summary>
    /// element_screenshot: capture a single control to a file and return its
    /// path, so the evidence stays scoped to what matters.
    /// </summary>
    private static Dictionary<string, object?> ElementScreenshot(JsonElement p)
    {
        var target = ResolveElement(p);
        var rect = target.BoundingRectangle;
        if (rect.Width < 1 || rect.Height < 1)
            throw new InvalidOperationException("the element has no on-screen rect (hidden or scrolled away)");

        var format = (Fs.ReadString(p, "format") ?? "png").ToLowerInvariant();
        var quality = Math.Clamp(Fs.ReadInt(p, "quality") ?? 85, 1, 100);
        var path = Path.Combine(Path.GetTempPath(),
            $"mrc-cua-elem-{DateTime.Now:yyyyMMdd-HHmmss}.{(format == "jpeg" ? "jpg" : "png")}");

        using (var bitmap = new System.Drawing.Bitmap((int)rect.Width, (int)rect.Height, PixelFormat.Format24bppRgb))
        {
            using (var graphics = System.Drawing.Graphics.FromImage(bitmap))
            {
                graphics.CopyFromScreen((int)rect.X, (int)rect.Y, 0, 0, bitmap.Size, CopyPixelOperation.SourceCopy);
            }
            bitmap.Save(path, format == "jpeg" ? ImageFormat.Jpeg : ImageFormat.Png);
        }
        _ = quality;

        return new Dictionary<string, object?>
        {
            ["ok"] = true,
            ["path"] = path,
            ["bytes"] = new FileInfo(path).Length,
            ["format"] = format,
            ["bounds"] = Bounds(rect),
            ["name"] = target.Name,
            ["control_type"] = target.ControlType.ToString(),
        };
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
                    string? elName = null, elAutoId = null, elClass = null, elCtrl = null;
                    try { elName = element.Name; } catch { }
                    try { elAutoId = element.AutomationId; } catch { }
                    try { elClass = element.ClassName; } catch { }
                    try { elCtrl = element.ControlType.ToString(); } catch { }
                    if (name is not null && !Contains(elName, name)) continue;
                    if (automationId is not null && !Contains(elAutoId, automationId)) continue;
                    if (className is not null && !Contains(elClass, className)) continue;
                    if (controlType is not null &&
                        !string.Equals(elCtrl, controlType, StringComparison.OrdinalIgnoreCase)) continue;
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
            // Some UIA providers throw while enumerating (e.g. when they
            // cannot answer a property query). Surface the error instead of
            // silently returning an empty result.
            throw new InvalidOperationException($"element enumeration failed: {ex.GetType().Name}: {ex.Message}", ex);
        }
        return results;
    }

    private static bool Contains(string? value, string needle) =>
        value is not null && value.Contains(needle, StringComparison.OrdinalIgnoreCase);

    private static Dictionary<string, object?> Describe(AutomationElement element, System.Drawing.Rectangle rect)
    {
        string? name = null, automationId = null, className = null, controlType = null;
        bool enabled = false, offscreen = false;
        try { name = element.Name; } catch { }
        try { automationId = element.AutomationId; } catch { }
        try { className = element.ClassName; } catch { }
        try { controlType = element.ControlType.ToString(); } catch { }
        try { enabled = element.IsEnabled; } catch { }
        try { offscreen = element.IsOffscreen; } catch { }
        int pid = 0;
        try { pid = element.Properties.ProcessId.ValueOrDefault; } catch { }
        return new Dictionary<string, object?>
        {
            ["name"] = name ?? "",
            ["automation_id"] = automationId ?? "",
            ["class_name"] = className ?? "",
            ["control_type"] = controlType ?? "",
            ["enabled"] = enabled,
            ["offscreen"] = offscreen,
            ["pid"] = pid,
            ["bounds"] = Bounds(rect),
        };
    }

    // --------------------------------------------------------------- helpers

    /// <summary>
    /// A double click that Windows (and therefore Java AWT/Swing, Tk, ...) really
    /// recognises as one. FlaUI's Mouse.DoubleClick re-positions the cursor
    /// between the two clicks, and a mouse move resets the OS click counter, so
    /// those apps saw two single clicks instead of a double click. Set the
    /// position once, then press/release twice inside the double-click time.
    /// </summary>
    private static void DoubleClickAt(System.Drawing.Point point, MouseButton button)
    {
        Mouse.Position = point;
        Thread.Sleep(40);
        Mouse.Down(button);
        Thread.Sleep(30);
        Mouse.Up(button);
        // Well inside the 500 ms default double-click time; Swing needs the
        // second press within the OS threshold to count as a double click.
        Thread.Sleep(90);
        Mouse.Down(button);
        Thread.Sleep(30);
        Mouse.Up(button);
    }

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

    [DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int cmdShow);

    [DllImport("user32.dll")]
    private static extern bool MoveWindow(IntPtr hWnd, int x, int y, int width, int height, bool repaint);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out NativeRect rect);

    private const uint WM_CLOSE = 0x0010;
    private const int SW_MINIMIZE = 6;
    private const int SW_MAXIMIZE = 3;
    private const int SW_RESTORE = 9;

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }
}
