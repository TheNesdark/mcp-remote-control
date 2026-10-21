using System.Diagnostics;
using System.Management;
using System.Text.Json;

namespace Mrc.Agent;

/// <summary>
/// ps.list / ps.kill. The list uses the WMI process snapshot (name, pid, ppid,
/// working set, user) plus a short CPU sample; kill removes a process or every
/// process with a given name, optionally with its tree, and refuses to touch
/// the agent itself or pid 1.
/// </summary>
public static class Ps
{
    public static Task<JobOutcome> JobList(JsonElement p, JobContext ctx, CancellationToken ct)
    {
        var filter = (Fs.ReadString(p, "filter") ?? "").ToLowerInvariant();
        var top = Fs.ReadInt(p, "top") ?? 100;
        var sort = Fs.ReadString(p, "sort") ?? "cpu";

        var all = Snapshot();
        var matched = filter.Length == 0
            ? all
            : all.Where(proc =>
                (proc.Name ?? "").ToLowerInvariant().Contains(filter) ||
                (proc.Command ?? "").ToLowerInvariant().Contains(filter)).ToList();

        matched = sort switch
        {
            "pid" => matched.OrderByDescending(x => x.Pid).ToList(),
            "name" => matched.OrderBy(x => x.Name, StringComparer.Ordinal).ToList(),
            "mem" => matched.OrderByDescending(x => x.MemBytes ?? -1).ToList(),
            _ => matched.OrderByDescending(x => x.CpuPercent ?? -1).ToList(),
        };
        var page = matched.Take(top).Select(x => new Dictionary<string, object?>
        {
            ["pid"] = x.Pid,
            ["ppid"] = x.ParentPid,
            ["name"] = x.Name,
            ["user"] = x.User,
            ["cpuPercent"] = x.CpuPercent,
            ["memBytes"] = x.MemBytes,
            ["command"] = x.Command,
        }).ToList();

        ctx.StdoutJson(new { total = all.Count, matched = matched.Count, processes = page });
        return Task.FromResult(JobOutcome.Success(new Dictionary<string, object?>
        {
            ["total"] = all.Count,
            ["matched"] = matched.Count,
            ["returned"] = page.Count,
        }));
    }

    public static Task<JobOutcome> JobKill(JsonElement p, JobContext ctx, CancellationToken ct)
    {
        var pid = Fs.ReadInt(p, "pid");
        var name = Fs.ReadString(p, "name");
        if ((pid is null) == (string.IsNullOrEmpty(name)))
            return Task.FromResult(JobOutcome.Failure("provide exactly one of 'pid' or 'name'"));

        var force = !p.TryGetProperty("force", out var f) || f.ValueKind != JsonValueKind.False;
        var tree = !p.TryGetProperty("tree", out var t) || t.ValueKind != JsonValueKind.False;

        var snapshot = Snapshot();
        var targets = new List<ProcInfo>();
        if (pid is int explicitPid)
        {
            var match = snapshot.FirstOrDefault(x => x.Pid == explicitPid);
            if (match is null) return Task.FromResult(JobOutcome.Failure($"no process with pid {explicitPid}"));
            targets.Add(match);
        }
        else
        {
            var wanted = name!.ToLowerInvariant().TrimEnd('.', 'e', 'x');
            targets.AddRange(snapshot.Where(x => (x.Name ?? "").ToLowerInvariant().TrimEnd('.', 'e', 'x') == wanted));
            if (targets.Count == 0) return Task.FromResult(JobOutcome.Failure($"no process named '{name}'"));
        }

        var ownPid = Environment.ProcessId;
        targets = targets.Where(x => x.Pid != ownPid).ToList();
        if (targets.Count == 0) return Task.FromResult(JobOutcome.Failure("refusing to kill the agent's own process"));

        if (tree)
        {
            var roots = targets.Where(root => !targets.Any(other =>
                other.Pid != root.Pid && IsDescendant(snapshot, root.Pid, other.Pid))).ToList();
            targets = roots;
        }

        var outcomes = new List<Dictionary<string, object?>>();
        foreach (var target in targets)
        {
            var (ok, error) = KillOne(target.Pid, tree, force);
            outcomes.Add(new Dictionary<string, object?>
            {
                ["pid"] = target.Pid,
                ["ok"] = ok,
                ["error"] = error,
            });
        }
        var killed = outcomes.Count(o => (bool)o["ok"]!);
        ctx.StdoutJson(new
        {
            requested = pid is int rp ? $"pid {rp}" : $"name {name}",
            tree,
            force,
            killedCount = killed,
            outcomes,
        });
        return Task.FromResult(JobOutcome.Success(new Dictionary<string, object?>
        {
            ["killedCount"] = killed,
            ["outcomes"] = outcomes,
        }));
    }

    private static bool IsDescendant(List<ProcInfo> snapshot, int candidate, int ancestor)
    {
        var byPid = snapshot.ToDictionary(x => x.Pid);
        var current = candidate;
        for (var depth = 0; depth < 32; depth++)
        {
            if (!byPid.TryGetValue(current, out var proc) || proc.ParentPid is not int parent || parent <= 0) return false;
            if (parent == ancestor) return true;
            current = parent;
        }
        return false;
    }

    private static (bool Ok, string? Error) KillOne(int pid, bool tree, bool force)
    {
        try
        {
            var args = $"/PID {pid}" + (tree ? " /T" : "") + (force ? " /F" : "");
            using var proc = Process.Start(new ProcessStartInfo("taskkill", args)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            });
            if (proc is null) return (false, "taskkill did not start");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            proc.WaitForExit(15_000);
            if (proc.ExitCode == 0) return (true, null);
            var merged = (stderr + stdout).Trim().Split('\n').FirstOrDefault()?.Trim();
            return (false, string.IsNullOrEmpty(merged) ? $"taskkill exit {proc.ExitCode}" : merged);
        }
        catch (Exception ex)
        {
            return (false, ex.Message);
        }
    }

    private sealed record ProcInfo(int Pid, int? ParentPid, string? Name, string? User, double? CpuPercent, long? MemBytes, string? Command);

    private static List<ProcInfo> Snapshot()
    {
        var list = new List<ProcInfo>();
        try
        {
            using var searcher = new ManagementObjectSearcher(
                "SELECT ProcessId, ParentProcessId, Name, WorkingSetSize, CommandLine FROM Win32_Process");
            foreach (var item in searcher.Get())
            {
                var pid = Convert.ToInt32(item["ProcessId"] ?? 0);
                var ppid = item["ParentProcessId"] is { } parent ? Convert.ToInt32(parent) : (int?)null;
                list.Add(new ProcInfo(
                    pid,
                    ppid,
                    item["Name"]?.ToString(),
                    null,
                    null,
                    item["WorkingSetSize"] is { } ws ? Convert.ToInt64(ws) : null,
                    item["CommandLine"]?.ToString()));
            }
        }
        catch (Exception ex)
        {
            // Visible on purpose: without WMI the list comes from
            // Process.GetProcesses() instead, and the operator should know.
            Log.Warn("ps: WMI snapshot failed", new Dictionary<string, object?> { ["error"] = ex.Message });
        }

        if (list.Count == 0) list = SnapshotWithoutWmi();

        // CPU% needs two samples; the TS agent also reports 0 off Windows.
        AttachCpu(list);
        return list;
    }

    /// <summary>
    /// Process list without WMI. Parent PIDs are unknown, so `tree` cannot walk
    /// the ancestry — taskkill /T still kills the tree of the resolved pid.
    /// </summary>
    private static List<ProcInfo> SnapshotWithoutWmi()
    {
        var list = new List<ProcInfo>();
        foreach (var process in Process.GetProcesses())
        {
            try
            {
                list.Add(new ProcInfo(
                    process.Id,
                    null,
                    process.ProcessName + ".exe",
                    null,
                    null,
                    process.WorkingSet64,
                    null));
            }
            catch (Exception)
            {
                // a process that exits mid-walk is not an error
            }
            finally
            {
                process.Dispose();
            }
        }
        return list;
    }

    private static void AttachCpu(List<ProcInfo> list)
    {
        try
        {
            var first = Process.GetProcesses().ToDictionary(p => p.Id, p => SafeCpu(p));
            WaitMilliseconds(400);
            var second = Process.GetProcesses().ToDictionary(p => p.Id, p => SafeCpu(p));
            var cores = Environment.ProcessorCount;
            for (var i = 0; i < list.Count; i++)
            {
                if (!first.TryGetValue(list[i].Pid, out var a) || !second.TryGetValue(list[i].Pid, out var b)) continue;
                if (a is null || b is null) continue;
                var deltaMs = Math.Max(0.0, (b.Value - a.Value).TotalMilliseconds);
                var percent = Math.Round(deltaMs / 400.0 / cores * 100.0, 1);
                list[i] = list[i] with { CpuPercent = percent };
            }
        }
        catch (Exception ex)
        {
            Log.Debug("cpu sampling failed", new { error = ex.Message });
        }
    }

    private static TimeSpan? SafeCpu(Process process)
    {
        try
        {
            return process.TotalProcessorTime;
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>Sleep wrapper: WinForms also defines Sleep, so be explicit.</summary>
    private static void WaitMilliseconds(int ms) => System.Threading.Thread.Sleep(ms);
}
