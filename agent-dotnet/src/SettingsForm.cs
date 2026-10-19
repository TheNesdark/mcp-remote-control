using System.Drawing;
using System.Windows.Forms;

namespace Mrc.Agent;

/// <summary>
/// The tray's "Ajustes" form: name, server and token of this agent, the same
/// three things the first-run dialog asked for. Saving rewrites agent.json
/// (token protected with DPAPI) and asks for a restart, because the connection
/// is bound to the old values.
/// </summary>
public sealed class SettingsForm : Form
{
    private readonly TextBox _name = new();
    private readonly TextBox _server = new();
    private readonly TextBox _token = new();
    private readonly Label _hint = new();

    public SettingsForm()
    {
        Text = "rc-agent · Ajustes";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(460, 260);
        Font = new Font("Segoe UI", 9F);
        Padding = new Padding(14);

        var current = Settings.Current;

        AddLabel("Nombre del equipo", 16, 22);
        Configure(_name, current.Name, 16, 46);
        _name.MaxLength = 32;

        AddLabel("Servidor del hub (ws://ip:puerto)", 16, 84);
        Configure(_server, current.ServerUrl, 16, 108);

        AddLabel("Token", 16, 146);
        Configure(_token, string.Empty, 16, 170);
        _token.UseSystemPasswordChar = true;

        _hint.Text = "Token: dejalo vacio para conservar el actual. Los cambios se aplican al reiniciar.";
        _hint.AutoSize = true;
        _hint.ForeColor = Color.DimGray;
        _hint.Location = new Point(16, 212);
        Controls.Add(_hint);

        var save = new Button { Text = "Guardar y reiniciar", Location = new Point(240, 202), Size = new Size(130, 30) };
        var cancel = new Button { Text = "Cancelar", Location = new Point(376, 202), Size = new Size(70, 30) };
        save.Click += (_, _) => Save();
        cancel.Click += (_, _) => { DialogResult = DialogResult.Cancel; Close(); };
        Controls.Add(save);
        Controls.Add(cancel);
        AcceptButton = save;
        CancelButton = cancel;
    }

    private void AddLabel(string text, int x, int y)
    {
        var label = new Label { Text = text, AutoSize = true, Location = new Point(x, y) };
        Controls.Add(label);
    }

    private void Configure(TextBox box, string value, int x, int y)
    {
        box.Text = value;
        box.Location = new Point(x, y);
        box.Size = new Size(428, 23);
        Controls.Add(box);
    }

    private void Save()
    {
        var name = _name.Text.Trim();
        var server = _server.Text.Trim();
        var token = _token.Text;

        if (name.Length == 0)
        {
            MessageBox.Show("El nombre no puede estar vacio.", "rc-agent", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        if (!server.StartsWith("ws://", StringComparison.OrdinalIgnoreCase) &&
            !server.StartsWith("wss://", StringComparison.OrdinalIgnoreCase))
        {
            MessageBox.Show("El servidor debe empezar por ws:// o wss://", "rc-agent", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        var file = Settings.ReadConfigFile();
        file.Name = name;
        file.Server = server;
        if (token.Length > 0)
        {
            file.TokenProtected = Dpapi.Protect(token);
            file.Token = null;
        }
        // An empty token keeps the stored one: it is DPAPI-protected and
        // showing it in clear text would be a downgrade for no reason.
        Settings.Save(file);
        Log.Info("settings changed from the tray", new { name, server });

        // The autostart entry (HKCU Run key) carries the settings on its
        // command line, and those win over the config file on every logon.
        // Rewrite it with the new ones.
        var exe = Environment.ProcessPath ?? "";
        if (exe.Length > 0) Autostart.SetCommand(exe, name, server, token);

        DialogResult = DialogResult.OK;
        Close();
        // From the tray the agent is already running, so it restarts to pick
        // the new values up; on the first run the caller reloads them itself.
        var restarts = RestartRequested;
        MessageBox.Show(
            restarts is null
                ? "Ajustes guardados."
                : "Ajustes guardados. El agente se reiniciara para aplicarlos.",
            "rc-agent",
            MessageBoxButtons.OK,
            MessageBoxIcon.Information);
        restarts?.Invoke();
    }

    /// <summary>Raised after the settings were written: the agent restarts itself.</summary>
    public static event Action? RestartRequested;
}
