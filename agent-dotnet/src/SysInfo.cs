using System.Management;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace Mrc.Agent;

/// <summary>
/// info: machine inventory (host, OS, user, CPU, memory, NICs, disks).
/// The shape mirrors SysInfo in agent/src/sysinfo.ts so the hub tool
/// agent_agent_info keeps rendering the same fields.
/// </summary>
public static class SysInfo
{
    public static Task<JobOutcome> Job(JsonElement _, JobContext ctx, CancellationToken ct)
    {
        var host = Environment.MachineName;
        var info = new Dictionary<string, object?>
        {
            ["agent"] = new Dictionary<string, object?>
            {
                ["name"] = Settings.Current.Name,
                ["version"] = Versions.Current,
                ["id"] = Settings.Current.AgentId,
                ["server"] = Settings.Current.ServerUrl,
                ["caps"] = Protocol.Caps,
                ["uptimeSec"] = (long)Environment.TickCount64 / 1000,
            },
            ["host"] = host,
            ["os"] = new Dictionary<string, object?>
            {
                ["platform"] = "win32",
                ["type"] = "Windows_NT",
                ["release"] = Environment.OSVersion.Version.ToString(),
                ["arch"] = RuntimeInformation.OSArchitecture.ToString().ToLowerInvariant(),
            },
            ["user"] = Environment.UserName,
            ["uptimeSec"] = (long)Environment.TickCount64 / 1000,
            ["execPath"] = Environment.ProcessPath ?? "",
            ["standalone"] = true,
            ["cpu"] = Cpu(),
            ["memory"] = Memory(),
            ["ips"] = Network(),
            ["disks"] = Disks(),
            ["time"] = DateTimeOffset.UtcNow.ToString("o"),
        };
        ctx.StdoutJson(info);
        return Task.FromResult(JobOutcome.Success(new Dictionary<string, object?>
        {
            ["host"] = host,
            ["platform"] = "win32",
        }));
    }

    private static Dictionary<string, object?> Cpu() => new()
    {
        ["model"] = CpuModel(),
        ["cores"] = Environment.ProcessorCount,
        ["speedMhz"] = null,
        ["loadAvg"] = new[] { 0.0, 0.0, 0.0 },
    };

    private static string? CpuModel()
    {
        try
        {
            using var searcher = new ManagementObjectSearcher("SELECT Name FROM Win32_Processor");
            foreach (var item in searcher.Get())
            {
                return item["Name"]?.ToString()?.Trim();
            }
        }
        catch (Exception)
        {
            // WMI can be unavailable; report unknown like the TS agent does
        }
        return null;
    }

    private static Dictionary<string, object?> Memory() => new()
    {
        ["totalBytes"] = PhysicalMemoryBytes(),
        ["freeBytes"] = AvailableMemoryBytes(),
    };

    private static ulong PhysicalMemoryBytes()
    {
        try
        {
            using var searcher = new ManagementObjectSearcher("SELECT TotalPhysicalMemory FROM Win32_ComputerSystem");
            foreach (var item in searcher.Get())
            {
                if (ulong.TryParse(item["TotalPhysicalMemory"]?.ToString(), out var bytes)) return bytes;
            }
        }
        catch (Exception)
        {
            // fall through
        }
        return 0;
    }

    private static ulong AvailableMemoryBytes()
    {
        try
        {
            using var searcher = new ManagementObjectSearcher("SELECT FreePhysicalMemory FROM Win32_OperatingSystem");
            foreach (var item in searcher.Get())
            {
                if (ulong.TryParse(item["FreePhysicalMemory"]?.ToString(), out var kb)) return kb * 1024;
            }
        }
        catch (Exception)
        {
            // fall through
        }
        return 0;
    }

    private static List<Dictionary<string, object?>> Network()
    {
        var list = new List<Dictionary<string, object?>>();
        try
        {
            foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (nic.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
                var mac = string.Join(":", nic.GetPhysicalAddress().GetAddressBytes().Select(b => b.ToString("x2")));
                foreach (var addr in nic.GetIPProperties().UnicastAddresses)
                {
                    list.Add(new Dictionary<string, object?>
                    {
                        ["iface"] = nic.Name,
                        ["address"] = addr.Address.ToString(),
                        ["family"] = addr.Address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork ? "IPv4" : "IPv6",
                        ["internal"] = false,
                        ["mac"] = mac,
                    });
                }
            }
        }
        catch (Exception)
        {
            // partial inventory beats none
        }
        return list;
    }

    private static List<Dictionary<string, object?>> Disks()
    {
        var list = new List<Dictionary<string, object?>>();
        try
        {
            using var searcher = new ManagementObjectSearcher(
                "SELECT DeviceID, VolumeName, Size, FreeSpace FROM Win32_LogicalDisk WHERE DriveType=3");
            foreach (var item in searcher.Get())
            {
                var total = ToLong(item["Size"]);
                var free = ToLong(item["FreeSpace"]);
                var used = Math.Max(0, total - free);
                list.Add(new Dictionary<string, object?>
                {
                    ["mount"] = item["DeviceID"]?.ToString(),
                    ["label"] = item["VolumeName"]?.ToString(),
                    ["totalBytes"] = total,
                    ["usedBytes"] = used,
                    ["freeBytes"] = free,
                    ["usedPercent"] = total > 0 ? Math.Round(used * 100.0 / total, 1) : 0.0,
                });
            }
        }
        catch (Exception)
        {
            // partial inventory beats none
        }
        return list;
    }

    private static long ToLong(object? value) => value switch
    {
        null => 0,
        long l => l,
        ulong u => (long)u,
        _ => long.TryParse(value.ToString(), out var parsed) ? parsed : 0,
    };
}
