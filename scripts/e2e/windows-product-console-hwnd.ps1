param(
  [Parameter(Mandatory=$true)][string]$ReadyPath,
  [Parameter(Mandatory=$true)][string]$StopPath,
  [Parameter(Mandatory=$true)][string]$EvidencePath,
  [Parameter(Mandatory=$true)][int]$MainPid
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class OwnedWinConsoleObserver {
  public sealed class Window {
    public string Hwnd;
    public int Pid;
    public string ClassName;
  }
  private delegate bool EnumWindowsCallback(IntPtr hwnd, IntPtr param);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr param);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  public static int ForegroundPid() {
    uint pid;
    GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    return unchecked((int)pid);
  }
  public static Window[] VisibleConsoleWindows() {
    var found = new List<Window>();
    EnumWindows((hwnd, param) => {
      if (!IsWindowVisible(hwnd)) return true;
      var name = new StringBuilder(256);
      GetClassName(hwnd, name, name.Capacity);
      string cls = name.ToString();
      if (!String.Equals(cls, "ConsoleWindowClass", StringComparison.OrdinalIgnoreCase) &&
          cls.IndexOf("CASCADIA_HOSTING", StringComparison.OrdinalIgnoreCase) < 0)
        return true;
      uint pid;
      GetWindowThreadProcessId(hwnd, out pid);
      found.Add(new Window {
        Hwnd = hwnd.ToInt64().ToString("x"),
        Pid = unchecked((int)pid),
        ClassName = cls,
      });
      return true;
    }, IntPtr.Zero);
    return found.ToArray();
  }
}
'@
$baseline = @([OwnedWinConsoleObserver]::VisibleConsoleWindows() | ForEach-Object { $_.Hwnd })
$seen = [System.Collections.Generic.List[object]]::new()
$unique = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$samples = 0
$focusChanges = 0
$foregroundInitiallyMain = ([OwnedWinConsoleObserver]::ForegroundPid() -eq $MainPid)
$clock = [System.Diagnostics.Stopwatch]::StartNew()
[System.IO.File]::WriteAllText($ReadyPath, 'ready')
while (-not [System.IO.File]::Exists($StopPath) -and $clock.ElapsedMilliseconds -lt 600000) {
  $samples += 1
  if ([OwnedWinConsoleObserver]::ForegroundPid() -ne $MainPid) { $focusChanges += 1 }
  foreach ($window in [OwnedWinConsoleObserver]::VisibleConsoleWindows()) {
    if ($baseline -contains $window.Hwnd) { continue }
    if ($unique.Add($window.Hwnd)) {
      $seen.Add(@{
        hwnd = $window.Hwnd
        pid = $window.Pid
        className = $window.ClassName
        elapsedMs = $clock.ElapsedMilliseconds
      })
    }
  }
  [System.Threading.Thread]::Sleep(20)
}
$complete = [System.IO.File]::Exists($StopPath)
$receipt = @{
  schemaVersion = 1
  actualNativeHwndEnumerated = ($samples -gt 0)
  sampleCount = $samples
  elapsedMs = $clock.ElapsedMilliseconds
  baselineVisibleConsoleCount = $baseline.Count
  unexpectedNewConsoleWindows = @($seen.ToArray())
  foregroundInitiallyMain = $foregroundInitiallyMain
  foregroundOtherPidSamples = $focusChanges
  completedByOwnedStop = $complete
}
$json = ConvertTo-Json -InputObject $receipt -Depth 5
[System.IO.File]::WriteAllText($EvidencePath, $json, [System.Text.UTF8Encoding]::new($false))
if (!$complete -or $samples -lt 5 -or !$foregroundInitiallyMain -or
    $focusChanges -gt 0 -or $seen.Count -gt 0) { exit 1 }
