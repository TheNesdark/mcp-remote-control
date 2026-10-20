using System.Text.Json;

namespace Mrc.Agent;

public sealed class JobContext
{
    public JobContext(string jobId, Action<JobOutputMsg> emitOutput)
    {
        JobId = jobId;
        _emitOutput = emitOutput;
    }

    private readonly Action<JobOutputMsg> _emitOutput;
    private readonly object _gate = new();
    private int _seq;

    public string JobId { get; }

    /// <summary>Next sequence number for this job (short jobs share one counter).</summary>
    public int NextSeq()
    {
        lock (_gate) return _seq++;
    }

    public void Stdout(string data, string encoding = "utf8") =>
        _emitOutput(new JobOutputMsg { JobId = JobId, Stream = "stdout", Seq = NextSeq(), Data = data, Encoding = encoding });

    public void Stderr(string data, string encoding = "utf8") =>
        _emitOutput(new JobOutputMsg { JobId = JobId, Stream = "stderr", Seq = NextSeq(), Data = data, Encoding = encoding });

    public void StdoutJson(object payload) => Stdout(Json.Serialize(payload));
}

public delegate Task<JobOutcome> JobHandler(JsonElement parameters, JobContext ctx, CancellationToken ct);

/// <summary>The `meta` object of a job.result (null keys are dropped when serialized).</summary>
public sealed class JobOutcome
{
    public bool Ok { get; init; } = true;
    public Dictionary<string, object?>? Meta { get; init; }
    public int? ExitCode { get; init; }
    public string? Error { get; init; }

    public static JobOutcome Success(Dictionary<string, object?>? meta = null) => new() { Ok = true, Meta = meta };
    public static JobOutcome Failure(string error, int? exitCode = null, Dictionary<string, object?>? meta = null) =>
        new() { Ok = false, Error = error, ExitCode = exitCode, Meta = meta };
}

/// <summary>
/// Dispatches job.request frames and tracks running jobs so a late job.cancel
/// reaches the process kill. exec is the only streaming, concurrency-limited
/// job; everything else is a short job (one meta out).
/// </summary>
public sealed class JobManager
{
    private const int DefaultMaxConcurrent = 4;

    private readonly Dictionary<string, JobHandler> _short = new(StringComparer.Ordinal);
    private readonly Dictionary<string, IJobCanceller> _running = new(StringComparer.Ordinal);
    private readonly object _gate = new();
    private readonly Action<string, object?> _log;
    private readonly int _maxConcurrent;

    public JobManager(int maxConcurrent = DefaultMaxConcurrent, Action<string, object?>? log = null)
    {
        _maxConcurrent = maxConcurrent;
        _log = log ?? ((msg, fields) => Log.Info(msg, fields));
        RegisterBuiltIns();
    }

    public event Action<JobOutputMsg>? OnOutput;
    public event Action<JobResultMsg>? OnResult;

    public void Register(string jobType, JobHandler handler) => _short[jobType] = handler;

    private void RegisterBuiltIns()
    {
        Register("info", SysInfo.Job);
        Register("fs.list", Fs.JobList);
        Register("fs.read", Fs.JobRead);
        Register("fs.write", Fs.JobWrite);
        Register("fs.hash", Fs.JobHash);
        Register("ps.list", Ps.JobList);
        Register("ps.kill", Ps.JobKill);
        Register("screenshot", Screenshot.JobCapture);
        Register("restart", Restart.JobRestart);
        Register("cua", Cua.JobCall);
        Register("browser", BrowserCdp.JobCall);
        Register("record", Record.JobRecord);
        Register("record.status", Record.JobStatus);
        Register("diagnose", Diagnose.Job);
    }

    public void HandleRequest(JobRequestMsg msg)
    {
        if (msg.JobType == "exec")
        {
            lock (_gate)
            {
                if (_running.Count >= _maxConcurrent)
                {
                    SendResult(msg.JobId, JobOutcome.Failure(
                        $"agent is busy ({_running.Count} jobs running, max {_maxConcurrent})"), 0);
                    return;
                }
            }
            _ = HandleExecAsync(msg);
            return;
        }

        if (!_short.TryGetValue(msg.JobType, out var handler))
        {
            SendResult(msg.JobId, JobOutcome.Failure($"unsupported job type '{msg.JobType}'"), 0);
            return;
        }
        _ = HandleShortAsync(msg, handler);
    }

    private async Task HandleShortAsync(JobRequestMsg msg, JobHandler handler)
    {
        var startedAt = Environment.TickCount64;
        var ctx = new JobContext(msg.JobId, emit => OnOutput?.Invoke(emit));
        using var cts = new CancellationTokenSource(Math.Max(1, msg.TimeoutMs));
        try
        {
            var outcome = await handler(msg.Params, ctx, cts.Token).ConfigureAwait(false);
            SendResult(msg.JobId, outcome, Environment.TickCount64 - startedAt);
        }
        catch (OperationCanceledException)
        {
            SendResult(msg.JobId, JobOutcome.Failure($"job timed out after {msg.TimeoutMs}ms"), Environment.TickCount64 - startedAt);
        }
        catch (Exception ex)
        {
            SendResult(msg.JobId, JobOutcome.Failure(ex.Message), Environment.TickCount64 - startedAt);
        }
    }

    private async Task HandleExecAsync(JobRequestMsg msg)
    {
        var startedAt = Environment.TickCount64;
        var runner = new ExecRunner(msg, this);
        lock (_gate) _running[msg.JobId] = runner;
        try
        {
            var outcome = await runner.RunAsync().ConfigureAwait(false);
            SendResult(msg.JobId, outcome, Environment.TickCount64 - startedAt);
        }
        catch (Exception ex)
        {
            SendResult(msg.JobId, JobOutcome.Failure(ex.Message), Environment.TickCount64 - startedAt);
        }
        finally
        {
            lock (_gate) _running.Remove(msg.JobId);
        }
    }

    public void HandleCancel(string jobId)
    {
        IJobCanceller? runner;
        lock (_gate) _running.TryGetValue(jobId, out runner);
        if (runner is null) return;
        _log("job cancel requested", new { jobId });
        runner.Cancel();
    }

    public void CancelAll()
    {
        List<IJobCanceller> runners;
        lock (_gate)
        {
            runners = _running.Values.ToList();
            _running.Clear();
        }
        foreach (var runner in runners) runner.Cancel();
    }

    internal void EmitOutput(JobOutputMsg msg) => OnOutput?.Invoke(msg);

    private void SendResult(string jobId, JobOutcome outcome, long durationMs)
    {
        OnResult?.Invoke(new JobResultMsg
        {
            JobId = jobId,
            Ok = outcome.Ok,
            ExitCode = outcome.ExitCode,
            DurationMs = durationMs,
            Error = outcome.Ok ? null : outcome.Error,
            Meta = outcome.Meta,
        });
    }
}

public interface IJobCanceller
{
    void Cancel();
}
