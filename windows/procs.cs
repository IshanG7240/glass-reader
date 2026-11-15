// Which process owns the focused window (and that window's title: in Windows Terminal,
// the active tab's), plus the process table, as one line of JSON. Used by procs.ps1 and host.ps1.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class GlassReaderProcs {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int max);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32W e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32W e);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long create, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct PROCESSENTRY32W {
    public uint dwSize, cntUsage, th32ProcessID; public IntPtr th32DefaultHeapID;
    public uint th32ModuleID, cntThreads, th32ParentProcessID; public int pcPriClassBase; public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }

  static string Esc(string s) {
    var b = new StringBuilder();
    foreach (var c in s) { if (c == '"' || c == '\\') b.Append('\\'); if (c >= ' ') b.Append(c); }
    return b.ToString();
  }

  public static string Snapshot() {
    uint fg = 0;
    var w = GetForegroundWindow();
    var title = new StringBuilder(512);
    if (w != IntPtr.Zero) { GetWindowThreadProcessId(w, out fg); GetWindowTextW(w, title, 512); }
    var sb = new StringBuilder();
    sb.Append("{\"fg\":").Append(fg).Append(",\"title\":\"").Append(Esc(title.ToString())).Append("\",\"procs\":[");
    var snap = CreateToolhelp32Snapshot(2 /* TH32CS_SNAPPROCESS */, 0);
    var e = new PROCESSENTRY32W { dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W)) };
    bool first = true;
    for (bool ok = Process32FirstW(snap, ref e); ok; ok = Process32NextW(snap, ref e)) {
      long start = 0, x, k, u;
      var h = OpenProcess(0x1000 /* QUERY_LIMITED_INFORMATION */, false, e.th32ProcessID);
      if (h != IntPtr.Zero) { GetProcessTimes(h, out start, out x, out k, out u); CloseHandle(h); }
      if (!first) sb.Append(',');
      first = false;
      sb.Append('[').Append(e.th32ProcessID).Append(',').Append(e.th32ParentProcessID)
        .Append(",\"").Append(Esc(e.szExeFile)).Append("\",\"").Append(start).Append("\"]"); // a string: too big for a JS number
    }
    CloseHandle(snap);
    return sb.Append("]}").ToString();
  }
}
