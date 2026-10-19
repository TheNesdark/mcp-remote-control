using System.Reflection;

namespace Mrc.Agent;

/// <summary>
/// Version handling: the C# port reads the same version string the hub expects
/// in hello/info. The single source of truth in the repo is shared/version.ts;
/// keep them in step (the build can override with /p:Version=...).
/// </summary>
public static class Versions
{
    public static string Current { get; } =
        typeof(Versions).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
            .Split('+')[0]
        ?? "0.0.0";

    /// <summary>Component-wise compare of "1.2.3" style versions (see shared/version.ts).</summary>
    public static int Compare(string left, string right)
    {
        static int[] Parts(string v) => v.Split('-')[0]
            .Split('.')
            .Select(p => int.TryParse(p, out var n) ? n : 0)
            .ToArray();

        var a = Parts(left);
        var b = Parts(right);
        for (var i = 0; i < Math.Max(a.Length, b.Length); i++)
        {
            var x = i < a.Length ? a[i] : 0;
            var y = i < b.Length ? b[i] : 0;
            if (x != y) return x.CompareTo(y);
        }
        return 0;
    }
}
