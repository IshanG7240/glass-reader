// Glass Reader's window on Windows: a borderless full-screen WebView2 (Microsoft's Edge
// runtime, built into Windows 11) with the global shortcuts and the tray icon.
//
// It is deliberately dumb. windows/reader.js (Node) owns all the logic and drives this
// over stdin/stdout, one JSON object per line:
//   in:  {"c":"show"} {"c":"hide"} {"c":"post","json":"..."} {"c":"balloon","title","text"}
//        {"c":"hotkeys","toggle":"Control+Alt+R","read":"Control+Alt+C"} {"c":"dialog","id":1}
//        {"c":"capture","path":"x.png"} {"c":"quit"}
//   out: {"t":"ready"} {"t":"msg","data":{...from the page...}} {"t":"state","visible":true}
//        {"t":"hotkey","name":"toggle"|"read","visible","focused","snap":{...procs.cs...}}
//        {"t":"tray","item":"show"|"open"|"quit"} {"t":"dialog","id":1,"path":"..."}
//        {"t":"hotkeys","failed":["..."]} {"t":"error","message":"..."}
//
// Compiled by Windows PowerShell 5.1's Add-Type, so this is C# 5: no string
// interpolation, no ?. and no => members.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using System.Web.Script.Serialization;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

public class GlassReaderHost : Form {
  [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk);
  [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr h, int id);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

  const int WM_HOTKEY = 0x0312;
  const int HK_TOGGLE = 1, HK_READ = 2;
  static readonly Color Back = Color.FromArgb(22, 22, 26);

  readonly WebView2 web;
  readonly NotifyIcon tray;
  readonly JavaScriptSerializer json = new JavaScriptSerializer();
  readonly object outLock = new object();
  readonly List<string> pending = new List<string>();
  readonly string url, origin, bridge, dataDir;
  readonly bool debug;
  bool webReady, quitting;

  public GlassReaderHost(string url, string bridge, string dataDir, bool debug) {
    this.url = url;
    this.origin = new Uri(url).GetLeftPart(UriPartial.Authority);
    this.bridge = bridge;
    this.dataDir = dataDir;
    this.debug = debug;
    json.MaxJsonLength = int.MaxValue;

    Text = "Glass Reader";
    FormBorderStyle = FormBorderStyle.None;
    ShowInTaskbar = false;
    StartPosition = FormStartPosition.Manual;
    BackColor = Back;
    Bounds = Screen.PrimaryScreen.Bounds;

    web = new WebView2();
    web.Dock = DockStyle.Fill;
    web.DefaultBackgroundColor = Back;
    Controls.Add(web);

    tray = new NotifyIcon();
    tray.Icon = TrayIcon();
    tray.Text = "Glass Reader";
    var menu = new ContextMenuStrip();
    menu.Items.Add("Show reader", null, delegate { Emit("{\"t\":\"tray\",\"item\":\"show\"}"); });
    menu.Items.Add("Open file…", null, delegate { Emit("{\"t\":\"tray\",\"item\":\"open\"}"); });
    menu.Items.Add(new ToolStripSeparator());
    menu.Items.Add("Quit Glass Reader", null, delegate { Emit("{\"t\":\"tray\",\"item\":\"quit\"}"); });
    tray.ContextMenuStrip = menu;
    tray.MouseClick += delegate(object s, MouseEventArgs e) {
      if (e.Button == MouseButtons.Left) Emit("{\"t\":\"tray\",\"item\":\"show\"}");
    };
    tray.BalloonTipClicked += delegate { Emit("{\"t\":\"tray\",\"item\":\"balloon\"}"); };
    tray.Visible = true;

    VisibleChanged += delegate { Emit("{\"t\":\"state\",\"visible\":" + (Visible ? "true" : "false") + "}"); };
  }

  // A page with lines, drawn in code: light lines on a dark page shows on any taskbar.
  static Icon TrayIcon() {
    var bmp = new Bitmap(16, 16);
    using (var g = Graphics.FromImage(bmp)) {
      g.Clear(Color.Transparent);
      g.FillRectangle(new SolidBrush(Color.FromArgb(48, 48, 52)), 2, 1, 12, 14);
      g.DrawRectangle(Pens.White, 2, 1, 11, 13);
      g.DrawLine(Pens.White, 5, 5, 10, 5);
      g.DrawLine(Pens.White, 5, 8, 10, 8);
      g.DrawLine(Pens.White, 5, 11, 8, 11);
    }
    return Icon.FromHandle(bmp.GetHicon());
  }

  // ---------- start-up ----------

  public void Start() {
    // WebView2 needs its window handles to exist; create them without showing anything.
    Opacity = 0;
    Show();
    Hide();
    Opacity = 1;
    InitWeb();
    var t = new Thread(ReadInput);
    t.IsBackground = true;
    t.Start();
  }

  async void InitWeb() {
    try {
      var env = await CoreWebView2Environment.CreateAsync(null, dataDir);
      await web.EnsureCoreWebView2Async(env);
      var core = web.CoreWebView2;
      core.Settings.IsStatusBarEnabled = false;
      core.Settings.AreDevToolsEnabled = debug;
      core.Settings.AreDefaultContextMenusEnabled = debug;
      core.Settings.IsPasswordAutosaveEnabled = false;
      core.Settings.IsGeneralAutofillEnabled = false;
      await core.AddScriptToExecuteOnDocumentCreatedAsync(bridge);
      core.WebMessageReceived += delegate(object s, CoreWebView2WebMessageReceivedEventArgs e) {
        Emit("{\"t\":\"msg\",\"data\":" + e.WebMessageAsJson + "}");
      };
      // Links open in the browser; the reader never navigates away from itself.
      core.NewWindowRequested += delegate(object s, CoreWebView2NewWindowRequestedEventArgs e) {
        e.Handled = true;
        OpenExternal(e.Uri);
      };
      core.NavigationStarting += delegate(object s, CoreWebView2NavigationStartingEventArgs e) {
        if (e.Uri.StartsWith(origin + "/", StringComparison.Ordinal)) return;
        e.Cancel = true;
        OpenExternal(e.Uri);
      };
      core.Navigate(url);
      webReady = true;
      foreach (var p in pending) core.PostWebMessageAsJson(p);
      pending.Clear();
      Emit("{\"t\":\"ready\"}");
    } catch (Exception ex) {
      Emit("{\"t\":\"error\",\"message\":" + json.Serialize("WebView2 failed to start: " + ex.Message) + "}");
    }
  }

  static void OpenExternal(string uri) {
    if (uri != null && (uri.StartsWith("https://", StringComparison.OrdinalIgnoreCase) || uri.StartsWith("http://", StringComparison.OrdinalIgnoreCase))) {
      try { Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true }); } catch { }
    }
  }

  // ---------- talking to reader.js ----------

  void Emit(string line) {
    lock (outLock) {
      try { Console.Out.WriteLine(line); Console.Out.Flush(); } catch { }
    }
  }

  void ReadInput() {
    string line;
    try {
      while ((line = Console.In.ReadLine()) != null) {
        var l = line;
        if (l.Trim().Length == 0) continue;
        BeginInvoke((MethodInvoker)delegate { OnCommand(l); });
      }
    } catch { }
    // reader.js has gone: so does the window.
    try { BeginInvoke((MethodInvoker)delegate { Quit(); }); } catch { }
  }

  static string Str(Dictionary<string, object> d, string k) {
    object v;
    return d.TryGetValue(k, out v) && v != null ? v.ToString() : "";
  }

  void OnCommand(string line) {
    Dictionary<string, object> m;
    try { m = json.Deserialize<Dictionary<string, object>>(line); } catch { return; }
    switch (Str(m, "c")) {
      case "show": ShowReader(); break;
      case "hide": Hide(); break;
      case "post":
        if (webReady) web.CoreWebView2.PostWebMessageAsJson(Str(m, "json"));
        else pending.Add(Str(m, "json"));
        break;
      case "balloon":
        tray.ShowBalloonTip(15000, Str(m, "title"), Str(m, "text"), ToolTipIcon.Info);
        break;
      case "hotkeys": SetHotkeys(Str(m, "toggle"), Str(m, "read")); break;
      case "dialog": OpenDialog(Str(m, "id")); break;
      case "capture": CapturePage(Str(m, "path")); break;
      case "quit": Quit(); break;
    }
  }

  // ---------- window ----------

  void ShowReader() {
    Bounds = Screen.FromPoint(Cursor.Position).Bounds;
    // Briefly topmost so it comes forward even when a terminal command asked for it;
    // Windows otherwise only flashes a background app in the taskbar.
    TopMost = true;
    Show();
    Activate();
    if (GetForegroundWindow() != Handle) {
      keybd_event(0x12, 0, 0, UIntPtr.Zero); // a tapped Alt lets a background app take the foreground
      keybd_event(0x12, 0, 2, UIntPtr.Zero);
      SetForegroundWindow(Handle);
    }
    web.Focus();
    var t = new System.Windows.Forms.Timer();
    t.Interval = 400;
    t.Tick += delegate { t.Stop(); t.Dispose(); TopMost = false; };
    t.Start();
  }

  protected override void OnFormClosing(FormClosingEventArgs e) {
    if (!quitting && e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; Hide(); return; }
    base.OnFormClosing(e);
  }

  void Quit() {
    if (quitting) return;
    quitting = true;
    UnregisterHotKey(Handle, HK_TOGGLE);
    UnregisterHotKey(Handle, HK_READ);
    tray.Visible = false;
    tray.Dispose();
    Close();
    Application.Exit();
  }

  void OpenDialog(string id) {
    string path = null;
    using (var d = new OpenFileDialog()) {
      d.Title = "Open a document";
      d.Filter = "Documents|*.pdf;*.md;*.markdown;*.txt;*.docx;*.epub;*.html;*.htm|All files|*.*";
      if (d.ShowDialog(this) == DialogResult.OK) path = d.FileName;
    }
    Emit("{\"t\":\"dialog\",\"id\":" + json.Serialize(id) + ",\"path\":" + json.Serialize(path) + "}");
  }

  async void CapturePage(string path) { // GR_DEBUG aid: a screenshot of the page
    if (!webReady || path.Length == 0) return;
    using (var f = File.Create(path)) await web.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, f);
  }

  // ---------- global shortcuts ----------

  // Electron-style accelerators: "Control+Alt+R", "Ctrl+Shift+F9", "Super+R".
  static bool ParseKey(string acc, out uint mods, out uint vk) {
    mods = 0x4000; // MOD_NOREPEAT
    vk = 0;
    foreach (var raw in acc.Split('+')) {
      var p = raw.Trim().ToLowerInvariant();
      if (p == "control" || p == "ctrl" || p == "commandorcontrol" || p == "cmdorctrl") mods |= 2;
      else if (p == "alt") mods |= 1;
      else if (p == "shift") mods |= 4;
      else if (p == "super" || p == "win" || p == "meta") mods |= 8;
      else {
        Keys k;
        if (p.Length == 1 && char.IsDigit(p[0])) p = "D" + p;
        if (!Enum.TryParse(p, true, out k)) return false;
        vk = (uint)k;
      }
    }
    return vk != 0;
  }

  void SetHotkeys(string toggle, string read) {
    UnregisterHotKey(Handle, HK_TOGGLE);
    UnregisterHotKey(Handle, HK_READ);
    var failed = new List<string>();
    var keys = new[] { toggle, read };
    for (int i = 0; i < 2; i++) {
      if (keys[i].Length == 0 || keys[i] == "none") continue;
      uint mods, vk;
      if (!ParseKey(keys[i], out mods, out vk) || !RegisterHotKey(Handle, i + 1, mods, vk)) failed.Add(keys[i]);
    }
    Emit("{\"t\":\"hotkeys\",\"failed\":" + json.Serialize(failed) + "}");
  }

  protected override void WndProc(ref Message m) {
    if (m.Msg == WM_HOTKEY) {
      int id = m.WParam.ToInt32();
      bool focused = Visible && GetForegroundWindow() == Handle;
      string state = ",\"visible\":" + (Visible ? "true" : "false") + ",\"focused\":" + (focused ? "true" : "false");
      if (id == HK_TOGGLE) Emit("{\"t\":\"hotkey\",\"name\":\"toggle\"" + state + "}");
      else if (id == HK_READ) {
        // Look at the focused window now, before the reader takes its place.
        string snap;
        try { snap = GlassReaderProcs.Snapshot(); } catch { snap = "null"; }
        Emit("{\"t\":\"hotkey\",\"name\":\"read\"" + state + ",\"snap\":" + snap + "}");
      }
      return;
    }
    base.WndProc(ref m);
  }
}
