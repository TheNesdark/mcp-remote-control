using Microsoft.Win32;

namespace Mrc.Agent;

/// <summary>
/// HKCU\...\Run autostart, mirroring agent/src/autostart.ts: the same value
/// name, and a refusal when the running path is an interpreter rather than the
/// published exe.
/// </summary>
public static class Autostart
{
    public const string AutostartName = "mcp-remote-control";
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";

    public static bool IsEnabled()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: false);
            return key?.GetValue(AutostartName) is not null;
        }
        catch (Exception ex)
        {
            Log.Warn("autostart query failed", new { error = ex.Message });
            return false;
        }
    }

    public static void SetEnabled(bool enabled)
    {
        var execPath = Environment.ProcessPath ?? "";
        if (System.Text.RegularExpressions.Regex.IsMatch(execPath, @"[/\\](dotnet|bun)(\.exe)?$",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase))
        {
            throw new InvalidOperationException("autostart needs the published rc-agent.exe (running under an interpreter)");
        }
        using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: true)
                        ?? Registry.CurrentUser.CreateSubKey(RunKey, writable: true)
                        ?? throw new InvalidOperationException("could not open the Run registry key");
        if (enabled)
            key.SetValue(AutostartName, $"\"{execPath}\"", RegistryValueKind.String);
        else
            key.DeleteValue(AutostartName, throwOnMissingValue: false);
        Log.Info(enabled ? "autostart enabled" : "autostart disabled", new { execPath });
    }
}
