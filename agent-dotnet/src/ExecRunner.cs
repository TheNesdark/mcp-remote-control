using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace Mrc.Agent;

/// <summary>
/// exec: runs a command in cmd.exe / powershell (or sh on POSIX for dev) with
/// stdin/env/cwd, streams stdout+stderr as job.output chunks and reports
/// {ok, exitCode, durationMs} or {ok:false, error} on timeout/cancel. The
/// process tree is killed through a Job Object on Windows so grandchildren
/// (a script that spawned a server) die with the root.
/// </summary>
public sealed class ExecRunner : IJobCanceller
{
    private readonly JobRequestMsg _msg;
    private readonly JobManager _manager;
    private Process? _process;
    private string? _killReason;

    public ExecRunner(JobRequestMsg msg, JobManager manager)
    {
        _msg = msg;
        _manager = manager;
    }

    public void Cancel() => RequestKill("cancelled");

    private void RequestKill(string reason)
    {
        Interlocked.CompareExchange(ref _killReason, reason, null);
        KillTree();
    }

    public async Task<JobOutcome> RunAsync()
    {
        var p = _msg.Params;
        var command = ReadString(p, "command");
        if (string.IsNullOrEmpty(command)) return JobOutcome.Failure("invalid exec params: command: Required");

        var shell = ReadString(p, "shell") ?? "native";
        var cwd = ReadString(p, "cwd");
        var stdin = ReadString(p, "stdin");
        var env = ReadEnv(p);

        var (file, args) = BuildCommand(shell, command);
        var psi = new ProcessStartInfo
        {
            FileName = file,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            WorkingDirectory = ResolveWorkingDirectory(cwd),
        };
        foreach (var arg in args) psi.ArgumentList.Add(arg);
        foreach (var (key, value) in env) psi.Environment[key] = value;

        try
        {
            _process = Process.Start(psi);
        }
        catch (Exception ex)
        {
            return JobOutcome.Failure($"failed to start command: {ex.Message}");
        }
        if (_process is null) return JobOutcome.Failure("failed to start command: no process");

        using var jobObject = WindowsJobObject.Attach(_process);
        var timeoutMs = Math.Min(_msg.TimeoutMs, Protocol.MaxExecTimeoutMs);
        using var timeoutCts = new CancellationTokenSource(timeoutMs);
        timeoutCts.Token.Register(() => RequestKill($"timed out after {timeoutMs}ms"));

        try
        {
            if (stdin is not null)
            {
                await _process.StandardInput.WriteAsync(stdin.AsMemory(), timeoutCts.Token).ConfigureAwait(false);
            }
            _process.StandardInput.Close();
        }
        catch (Exception)
        {
            // the command may never read stdin
        }

        // stdout and stderr stream independently, each with its own seq.
        var stdout = PumpAsync(_process.StandardOutput, "stdout");
        var stderr = PumpAsync(_process.StandardError, "stderr");
        await Task.WhenAll(stdout, stderr).ConfigureAwait(false);
        await _process.WaitForExitAsync(CancellationToken.None).ConfigureAwait(false);

        var exitCode = _process.ExitCode;
        var reason = Volatile.Read(ref _killReason);
        if (reason is not null)
            return JobOutcome.Failure(reason, exitCode);
        return new JobOutcome { Ok = exitCode == 0, ExitCode = exitCode };
    }

    private async Task PumpAsync(StreamReader reader, string streamName)
    {
        var buffer = new char[8192];
        var seq = 0;
        while (true)
        {
            int read;
            try
            {
                read = await reader.ReadAsync(buffer).ConfigureAwait(false);
            }
            catch (Exception)
            {
                break;
            }
            if (read <= 0) break;
            _manager.EmitOutput(new JobOutputMsg
            {
                JobId = _msg.JobId,
                Stream = streamName,
                Seq = seq++,
                Data = new string(buffer, 0, read),
                Encoding = "utf8",
            });
        }
    }

    private void KillTree()
    {
        var proc = _process;
        if (proc is null) return;
        try
        {
            if (proc.HasExited) return;
        }
        catch (InvalidOperationException)
        {
            return;
        }
        ProcessTree.Kill(proc.Id);
    }

    private static (string File, List<string> Args) BuildCommand(string shell, string command)
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return shell switch
            {
                "powershell" => ("powershell.exe", new List<string>
                {
                    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command,
                }),
                _ => ("cmd.exe", new List<string> { "/d", "/s", "/c", command }),
            };
        }
        return ("sh", new List<string> { "-c", command });
    }

    private static string ResolveWorkingDirectory(string? cwd)
    {
        if (!string.IsNullOrEmpty(cwd)) return cwd;
        var current = Directory.GetCurrentDirectory();
        // UNC cwd breaks cmd.exe; fall back to the system dir like the TS agent.
        if (current.StartsWith(@"\\", StringComparison.Ordinal))
            return Environment.GetEnvironmentVariable("SystemRoot") ?? @"C:\Windows";
        return current;
    }

    private static string? ReadString(JsonElement p, string name) =>
        p.ValueKind == JsonValueKind.Object && p.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString()
            : null;

    private static Dictionary<string, string> ReadEnv(JsonElement p)
    {
        var env = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (p.ValueKind != JsonValueKind.Object || !p.TryGetProperty("env", out var e) || e.ValueKind != JsonValueKind.Object)
            return env;
        foreach (var prop in e.EnumerateObject())
        {
            if (prop.Value.ValueKind == JsonValueKind.String)
                env[prop.Name] = prop.Value.GetString() ?? "";
        }
        return env;
    }
}

/// <summary>Windows Job Object wrapper: closing the handle kills the whole tree.</summary>
internal static class WindowsJobObject
{
    private const uint JobObjectLimitKillOnJobClose = 0x2000;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr attrs, string? name);

    [DllImport("kernel32.dll")]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll")]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    /// <summary>Returns a disposable job handle, or a no-op one off Windows.</summary>
    public static IDisposable Attach(Process process)
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return new NoopJob();

        var job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return new NoopJob();

        var info = new ExtendedLimitInformation();
        info.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
        var size = Marshal.SizeOf<ExtendedLimitInformation>();
        var ptr = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(info, ptr, false);
            if (!SetInformationJobObject(job, 9 /* ExtendedLimitInformation */, ptr, (uint)size))
            {
                CloseHandle(job);
                return new NoopJob();
            }
        }
        finally
        {
            Marshal.FreeHGlobal(ptr);
        }

        try
        {
            if (!AssignProcessToJobObject(job, process.Handle))
            {
                CloseHandle(job);
                return new NoopJob();
            }
        }
        catch (Exception)
        {
            CloseHandle(job);
            return new NoopJob();
        }
        return new JobHandle(job);
    }

    private sealed class JobHandle(IntPtr job) : IDisposable
    {
        public void Dispose() => CloseHandle(job);
    }

    private sealed class NoopJob : IDisposable
    {
        public void Dispose()
        {
        }
    }
}

/// <summary>Fallback tree kill (Job Objects are preferred; this is the belt-and-braces).</summary>
internal static class ProcessTree
{
    public static void Kill(int pid)
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            try
            {
                using var kill = Process.Start(new ProcessStartInfo("kill", $"-9 -{pid}") { UseShellExecute = false });
                kill?.WaitForExit(2000);
            }
            catch (Exception)
            {
                // best effort
            }
            return;
        }
        try
        {
            using var taskkill = Process.Start(new ProcessStartInfo("taskkill", $"/PID {pid} /T /F")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            });
            taskkill?.WaitForExit(15_000);
        }
        catch (Exception)
        {
            // best effort
        }
    }
}
