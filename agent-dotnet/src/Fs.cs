using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Mrc.Agent;

/// <summary>
/// fs.list / fs.read / fs.write / fs.hash, matching agent/src/fs.ts:
/// entries carry {name,type,size,mtimeMs}, reads are base64 chunks of at most
/// FS_MAX_CHUNK_BYTES with the sha256 only on the final chunk, and writes take
/// base64 and can mkdir first.
/// </summary>
public static class Fs
{
    public static Task<JobOutcome> JobList(JsonElement p, JobContext ctx, CancellationToken ct)
    {
        var target = ReadString(p, "path");
        if (string.IsNullOrEmpty(target)) return Invalid(ctx, "fs.list", "path: Required");
        var limit = ReadInt(p, "limit") ?? 1000;

        if (!Directory.Exists(target) && !File.Exists(target))
            return Task.FromResult(JobOutcome.Failure($"ENOENT: no such file or directory '{target}'"));

        var entries = new List<Dictionary<string, object?>>();
        if (File.Exists(target))
        {
            entries.Add(Entry(target));
        }
        else
        {
            var dirents = Directory.EnumerateFileSystemEntries(target)
                .Select(Path.GetFileName)
                .Where(name => name is not null)
                .Select(name => name!)
                .OrderBy(name => name, StringComparer.Ordinal)
                .ToList();
            var truncated = dirents.Count > limit;
            foreach (var name in dirents.Take(limit))
            {
                var full = Path.Combine(target, name);
                if (File.Exists(full) || Directory.Exists(full)) entries.Add(Entry(full));
            }
            ctx.StdoutJson(new { path = target, entries });
            return Task.FromResult(JobOutcome.Success(new Dictionary<string, object?>
            {
                ["count"] = entries.Count,
                ["truncated"] = truncated,
            }));
        }

        ctx.StdoutJson(new { path = target, entries });
        return Task.FromResult(JobOutcome.Success(new Dictionary<string, object?>
        {
            ["count"] = entries.Count,
            ["truncated"] = false,
        }));
    }

    public static async Task<JobOutcome> JobRead(JsonElement p, JobContext ctx, CancellationToken ct)
    {
        var path = ReadString(p, "path");
        if (string.IsNullOrEmpty(path)) return await Invalid(ctx, "fs.read", "path: Required");
        var offset = ReadInt(p, "offset") ?? 0;
        var length = ReadInt(p, "length") ?? Protocol.FsDefaultChunkBytes;
        if (!File.Exists(path))
            return JobOutcome.Failure($"ENOENT: no such file or directory '{path}'");

        var info = new FileInfo(path);
        var size = info.Length;
        var take = (int)Math.Min(length, Math.Max(0, size - offset));
        var buffer = new byte[Math.Max(0, take)];
        if (take > 0)
        {
            await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            stream.Seek(offset, SeekOrigin.Begin);
            var read = 0;
            while (read < take)
            {
                var n = await stream.ReadAsync(buffer.AsMemory(read, take - read), ct).ConfigureAwait(false);
                if (n <= 0) break;
                read += n;
            }
            if (read != take) buffer = buffer[..read];
        }
        var eof = offset + buffer.Length >= size;
        ctx.Stdout(Convert.ToBase64String(buffer), "base64");
        return JobOutcome.Success(new Dictionary<string, object?>
        {
            ["offset"] = offset,
            ["bytes"] = buffer.Length,
            ["eof"] = eof,
            ["size"] = size,
            ["sha256"] = eof ? await Sha256Async(path, ct).ConfigureAwait(false) : null,
        });
    }

    public static async Task<JobOutcome> JobWrite(JsonElement p, JobContext ctx, CancellationToken ct)
    {
        var path = ReadString(p, "path");
        if (string.IsNullOrEmpty(path)) return await Invalid(ctx, "fs.write", "path: Required");
        var data = ReadString(p, "data") ?? "";
        var append = string.Equals(ReadString(p, "mode") ?? "overwrite", "append", StringComparison.Ordinal);
        var mkdirs = ReadBool(p, "mkdirs");

        byte[] bytes;
        try
        {
            bytes = Convert.FromBase64String(data);
        }
        catch (FormatException)
        {
            return JobOutcome.Failure("invalid base64 payload");
        }
        if (bytes.Length > Protocol.FsMaxChunkBytes)
            return JobOutcome.Failure($"chunk too large: {bytes.Length} bytes (max {Protocol.FsMaxChunkBytes})");

        if (mkdirs)
        {
            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        }
        await using (var stream = new FileStream(path, append ? FileMode.Append : FileMode.Create, FileAccess.Write, FileShare.Read))
        {
            await stream.WriteAsync(bytes, ct).ConfigureAwait(false);
        }
        var sizeAfter = new FileInfo(path).Length;
        return JobOutcome.Success(new Dictionary<string, object?>
        {
            ["bytesWritten"] = bytes.Length,
            ["sizeAfter"] = sizeAfter,
        });
    }

    public static async Task<JobOutcome> JobHash(JsonElement p, JobContext ctx, CancellationToken ct)
    {
        var path = ReadString(p, "path");
        if (string.IsNullOrEmpty(path)) return await Invalid(ctx, "fs.hash", "path: Required");
        if (!File.Exists(path)) return JobOutcome.Failure($"ENOENT: no such file or directory '{path}'");
        return JobOutcome.Success(new Dictionary<string, object?>
        {
            ["sha256"] = await Sha256Async(path, ct).ConfigureAwait(false),
            ["size"] = new FileInfo(path).Length,
        });
    }

    // ------------------------------------------------------------------ helpers

    public static async Task<string> Sha256Async(string path, CancellationToken ct)
    {
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        var hash = await SHA256.HashDataAsync(stream, ct).ConfigureAwait(false);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    private static Dictionary<string, object?> Entry(string path)
    {
        var info = new FileInfo(path);
        var isDir = Directory.Exists(path);
        string type = isDir ? "dir" : "file";
        if (!isDir && info.LinkTarget is not null) type = "symlink";
        return new Dictionary<string, object?>
        {
            ["name"] = Path.GetFileName(path),
            ["type"] = type,
            ["size"] = type == "file" ? info.Length : null,
            ["mtimeMs"] = new DateTimeOffset(info.LastWriteTimeUtc).ToUnixTimeMilliseconds(),
        };
    }

    private static Task<JobOutcome> Invalid(JobContext ctx, string job, string issue) =>
        Task.FromResult(JobOutcome.Failure($"invalid {job} params: {issue}"));

    internal static string? ReadString(JsonElement p, string name) =>
        p.ValueKind == JsonValueKind.Object && p.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString()
            : null;

    internal static int? ReadInt(JsonElement p, string name) =>
        p.ValueKind == JsonValueKind.Object && p.TryGetProperty(name, out var v) && v.TryGetInt32(out var n) ? n : null;

    internal static bool ReadBool(JsonElement p, string name) =>
        p.ValueKind == JsonValueKind.Object && p.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;
}
