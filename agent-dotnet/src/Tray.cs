using System.Windows.Forms;
using System.Drawing;

namespace Mrc.Agent;

/// <summary>
/// Tray icon (native NotifyIcon, no PowerShell helper like the TS agent used):
/// pause/resume, reconnect, open logs, toggle autostart and exit.
/// </summary>
public sealed class Tray : IDisposable
{
    private readonly AgentConnection _connection;
    private readonly SynchronizationContext? _context;
    private NotifyIcon? _icon;
    private ToolStripMenuItem? _pauseItem;
    private ToolStripMenuItem? _autostartItem;
    private bool _paused;

    public Tray(AgentConnection connection)
    {
        _connection = connection;
        _context = SynchronizationContext.Current;
    }

    public event Action? OnExitRequested;

    public void Start()
    {
        if (_context is not null)
        {
            _context.Post(_ => Build(), null);
        }
        else
        {
            Build();
        }
    }

    private void Build()
    {
        var menu = new ContextMenuStrip();
        _pauseItem = new ToolStripMenuItem("Pausar", null, (_, _) => TogglePause());
        menu.Items.Add(_pauseItem);
        menu.Items.Add(new ToolStripMenuItem("Reconectar", null, (_, _) => _connection.ReconnectNow()));
        menu.Items.Add(new ToolStripMenuItem("Abrir logs", null, (_, _) => OpenLogs()));
        menu.Items.Add(new ToolStripSeparator());
        _autostartItem = new ToolStripMenuItem("Iniciar con Windows", null, (_, _) => ToggleAutostart())
        {
            CheckOnClick = false,
        };
        menu.Items.Add(_autostartItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("Salir", null, (_, _) => OnExitRequested?.Invoke()));

        _icon = new NotifyIcon
        {
            Icon = SystemIcons.Application,
            Text = $"rc-agent · {Settings.Current.Name}",
            ContextMenuStrip = menu,
            Visible = true,
        };
        _icon.DoubleClick += (_, _) => TogglePause();
        Refresh();
    }

    private void TogglePause()
    {
        _paused = !_paused;
        _connection.SetPaused(_paused);
        Refresh();
    }

    private void ToggleAutostart()
    {
        try
        {
            Autostart.SetEnabled(!Autostart.IsEnabled());
        }
        catch (Exception ex)
        {
            Log.Error("autostart toggle failed", new { error = ex.Message });
        }
        Refresh();
    }

    private void OpenLogs()
    {
        var dir = Path.GetDirectoryName(Settings.Current.LogFile ?? Settings.DefaultLogFile()) ?? Settings.DataDir();
        try
        {
            Directory.CreateDirectory(dir);
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("explorer", $"\"{dir}\"") { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            Log.Error("could not open the log folder", new { dir, error = ex.Message });
        }
    }

    public void Refresh()
    {
        if (_icon is null) return;
        _icon.Text = $"rc-agent · {Settings.Current.Name} · {(_connection.Connected ? "conectado" : "desconectado")}";
        if (_pauseItem is not null) _pauseItem.Text = _paused ? "Reanudar" : "Pausar";
        if (_autostartItem is not null) _autostartItem.Checked = Autostart.IsEnabled();
    }

    public void Dispose()
    {
        if (_icon is null) return;
        _icon.Visible = false;
        _icon.Dispose();
        _icon = null;
    }
}
