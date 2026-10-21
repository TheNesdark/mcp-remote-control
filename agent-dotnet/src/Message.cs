using System.Text.Json;
using System.Windows.Forms;

namespace Mrc.Agent;

/// <summary>
/// message: a system notice on the interactive desktop.
///
/// It must not be a child process. The exec runner puts everything it starts in
/// a job object with KILL_ON_JOB_CLOSE, so a message box launched from
/// PowerShell dies the instant the job finishes and the user never sees it
/// (that is how `agent_message` used to work). This box is shown by a thread of
/// the agent, which outlives the job: the job answers immediately and the box
/// stays on screen until the user closes it.
/// </summary>
public static class Message
{
    public static Task<JobOutcome> Job(JsonElement p, JobContext ctx, CancellationToken ct)
    {
        var text = (Fs.ReadString(p, "text") ?? "").Trim();
        if (text.Length == 0) return Task.FromResult(JobOutcome.Failure("text: Required"));

        var title = (Fs.ReadString(p, "title") ?? "").Trim();
        if (title.Length == 0) title = "Remote control";
        var style = Fs.ReadString(p, "style") ?? "info";
        var buttons = Fs.ReadString(p, "buttons") ?? "ok";

        var thread = new Thread(() =>
        {
            try
            {
                MessageBox.Show(text, title, Buttons(buttons), Icon(style));
            }
            catch (Exception ex)
            {
                Log.Warn("message: the box could not be shown", new Dictionary<string, object?> { ["error"] = ex.Message });
            }
        })
        {
            IsBackground = true,
            Name = "mrc-message",
        };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();

        Log.Info("message shown", new Dictionary<string, object?> { ["title"] = title, ["style"] = style });

        return Task.FromResult(JobOutcome.Success(new Dictionary<string, object?>
        {
            ["shown"] = true,
            ["title"] = title,
            ["style"] = style,
            ["buttons"] = buttons,
        }));
    }

    private static MessageBoxButtons Buttons(string buttons) => buttons switch
    {
        "okcancel" => MessageBoxButtons.OKCancel,
        "yesno" => MessageBoxButtons.YesNo,
        "yesnocancel" => MessageBoxButtons.YesNoCancel,
        _ => MessageBoxButtons.OK,
    };

    private static MessageBoxIcon Icon(string style) => style switch
    {
        "warning" => MessageBoxIcon.Warning,
        "error" => MessageBoxIcon.Error,
        "question" => MessageBoxIcon.Question,
        _ => MessageBoxIcon.Information,
    };
}
