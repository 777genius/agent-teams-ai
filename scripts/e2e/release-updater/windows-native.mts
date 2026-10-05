import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  selectedWindowsPowerShell,
  windowsShellCompilerReferences,
  windowsShellTestEnvironment,
} from './windows-powershell.mts';

import type { ExecFileException } from 'node:child_process';

const execute = promisify(execFile);
export interface WindowsProcess {
  pid: number;
  parent: number;
  executable: string;
  command: string;
  start: string;
  session: number;
  sid: string;
}
interface NativeWindow {
  pid: number;
  hwnd: string;
  width: number;
  height: number;
  foreground: boolean;
  screenshot: string;
}
interface DesktopSession {
  station: string;
  desktop: string;
  session: number;
  sid: string;
  administrator: boolean;
}
interface FirewallRule {
  name: string;
  enabled: string;
  direction: string;
  action: string;
  program: string;
  remote: string[];
}

// OS calls are intentionally limited to this disposable test's exact paths,
// PIDs and Firewall rule group. There are no project, runtime or login actions.
const powershell = String.raw`
param([Parameter(Mandatory=$true)][string]$InputFile, [Parameter(Mandatory=$true)][string]$TrustedModulePath)
[IO.File]::AppendAllText($InputFile + '.progress.jsonl', '{"phase":"script-entry"}' + [Environment]::NewLine)
[Environment]::SetEnvironmentVariable('PSModulePath', $TrustedModulePath, 'Process')
$ErrorActionPreference = 'Stop'
$data = Get-Content -LiteralPath $InputFile -Raw | ConvertFrom-Json
if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) { throw 'Explicit PowerShell 7 required' }
if ($PSVersionTable.PSVersion.ToString() -ne $data.shell.version -or $PSHOME -ne $data.shell.psHome -or [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName -ne $data.shell.executable) { throw 'Selected shell identity changed' }
$root = [IO.Path]::GetFullPath($data.root)
if ((Split-Path -Leaf $root) -notlike 'TEST-updater-windows-*') { throw 'Not a TEST root' }
if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($InputFile)) -ne $root) { throw 'Input outside TEST root' }
$progress = $InputFile + '.progress.jsonl'
function Write-TestProgress([string]$phase) {
  $record = @{ operation=$data.operation; phase=$phase; at=[DateTime]::UtcNow.ToString('o') }
  [IO.File]::AppendAllText($progress, (ConvertTo-Json -InputObject $record -Compress) + [Environment]::NewLine)
}
Write-TestProgress 'after-input-and-shell-validation'
function Test-OwnedPath([string]$file) {
  $full = [IO.Path]::GetFullPath($file)
  if (-not $full.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Path outside TEST root' }
  return $full
}
function Read-Owned([string]$file) {
  $full = Test-OwnedPath $file
  $items = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $full })
  return @($items | ForEach-Object {
    $owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid
    if ($owner.ReturnValue -ne 0) { throw 'Cannot verify TEST process owner' }
    @{ pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; executable=$_.ExecutablePath; command=$_.CommandLine; start=$_.CreationDate.ToUniversalTime().ToString('o'); session=[int]$_.SessionId; sid=$owner.Sid }
  })
}
Write-TestProgress 'before-system-drawing'
$drawingRuntimeNames = @('System.Drawing.Common.dll', 'System.Private.Windows.Core.dll', 'System.Private.Windows.GdiPlus.dll')
$compilerReferences = [string[]]@($data.compilerReferences.assemblies | ForEach-Object {
  $file = [IO.Path]::GetFullPath($_.file)
  $directory = [IO.Path]::GetDirectoryName($file)
  $installedDrawingRuntime = ($directory -eq $PSHOME) -and ($drawingRuntimeNames -contains [IO.Path]::GetFileName($file))
  if (($directory -ne [IO.Path]::Combine($PSHOME, 'ref')) -and -not $installedDrawingRuntime) { throw 'Compiler reference outside selected PSHOME' }
  return $file
})
if ($compilerReferences.Count -lt 4 -or $data.compilerReferences.drawingCommon -ne [IO.Path]::Combine($PSHOME, 'System.Drawing.Common.dll')) { throw 'Installed compiler reference set required' }
Add-Type -LiteralPath $data.compilerReferences.drawingCommon
if ([Drawing.Bitmap].Assembly.Location -ne $data.compilerReferences.drawingCommon) { throw 'Drawing implementation outside selected PSHOME' }
Write-TestProgress 'after-system-drawing'
Write-TestProgress 'before-native-compile'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Drawing;
using System.Drawing.Imaging;
public static class TestWindowsNative {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr param);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint id);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetUserObjectInformation(IntPtr obj, int index, StringBuilder text, uint length, out uint needed);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr param);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  public static string ObjectName(IntPtr obj) {
    StringBuilder result = new StringBuilder(256); uint needed;
    if (!GetUserObjectInformation(obj, 2, result, 512, out needed)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    return result.ToString();
  }
  public static IntPtr VisibleWindow(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((hwnd, param) => {
      uint owner; GetWindowThreadProcessId(hwnd, out owner); Rect r;
      if (owner == pid && IsWindowVisible(hwnd) && GetWindowRect(hwnd, out r) && r.Right-r.Left >= 300 && r.Bottom-r.Top >= 200) { found=hwnd; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static int[] Capture(IntPtr hwnd, string file) {
    ShowWindow(hwnd, 9); SetForegroundWindow(hwnd);
    if (GetForegroundWindow() != hwnd) throw new Exception("Owned native window is not foreground on interactive desktop");
    Rect r; if (!GetWindowRect(hwnd, out r)) throw new Exception("Window disappeared");
    uint pid; GetWindowThreadProcessId(hwnd, out pid);
    // Copy actual desktop pixels belonging to this visible foreground HWND.
    int left=Math.Max(0,r.Left), top=Math.Max(0,r.Top);
    int width=Math.Min(r.Right,GetSystemMetrics(0))-left, height=Math.Min(r.Bottom,GetSystemMetrics(1))-top;
    if (width < 300 || height < 200) throw new Exception("Owned window has insufficient visible screen area");
    using (Bitmap image = new Bitmap(width,height)) {
      using (Graphics graphics = Graphics.FromImage(image)) graphics.CopyFromScreen(left,top,0,0,new Size(width,height));
      image.Save(file,ImageFormat.Png);
    }
    return new int[] { (int)pid, width, height };
  }
}
'@ -ReferencedAssemblies $compilerReferences
Write-TestProgress 'after-native-compile'
Write-TestProgress 'operation-entry'
$result = $null
switch ($data.operation) {
  'session' {
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    $principal=New-Object Security.Principal.WindowsPrincipal($identity)
    $result=@{ station=[TestWindowsNative]::ObjectName([TestWindowsNative]::GetProcessWindowStation()); desktop=[TestWindowsNative]::ObjectName([TestWindowsNative]::GetThreadDesktop([TestWindowsNative]::GetCurrentThreadId())); session=(Get-Process -Id $PID).SessionId; sid=$identity.User.Value; administrator=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
  }
  'processes' { $result=@(Read-Owned $data.executable) }
  'capture' {
    $process=@(Read-Owned $data.executable) | Where-Object { $_.pid -eq $data.pid -and $_.start -eq $data.start }
    if (@($process).Count -ne 1) { throw 'Owned PID changed before native capture' }
    $handle=[TestWindowsNative]::VisibleWindow($data.pid)
    if ($handle -eq [IntPtr]::Zero) { $result=$null; break }
    $file=Test-OwnedPath $data.screenshot
    $pixels=[TestWindowsNative]::Capture($handle,$file)
    if ($pixels[0] -ne $data.pid) { throw 'HWND owner changed' }
    $result=@{ pid=$pixels[0]; hwnd=$handle.ToInt64().ToString('x'); width=$pixels[1]; height=$pixels[2]; foreground=$true; screenshot=$file }
  }
  'signature' {
    $file=Test-OwnedPath $data.file
    $signature=Get-AuthenticodeSignature -LiteralPath $file
    $version=[Diagnostics.FileVersionInfo]::GetVersionInfo($file)
    $result=@{ status=$signature.Status.ToString(); statusMessage=$signature.StatusMessage; subject=$signature.SignerCertificate.Subject; thumbprint=$signature.SignerCertificate.Thumbprint; fileVersion=$version.FileVersion; productVersion=$version.ProductVersion }
  }
  'firewall-add' {
    $file=Test-OwnedPath $data.executable
    if ($data.group -notmatch '^TEST-updater-windows-[a-f0-9-]+$') { throw 'Not owned Firewall group' }
    if (@(Get-NetFirewallProfile | Where-Object { -not $_.Enabled }).Count) { throw 'Firewall profiles must already be enabled' }
    if (Get-NetFirewallRule -Name $data.name -ErrorAction SilentlyContinue) { throw 'Firewall name already exists' }
    New-NetFirewallRule -Name $data.name -DisplayName $data.name -Group $data.group -Direction Outbound -Action Block -Program $file -Profile Any -RemoteAddress @('0.0.0.0-126.255.255.255','128.0.0.0-255.255.255.255','::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff') | Out-Null
    $data.operation='firewall-read'
  }
}
if ($data.operation -eq 'firewall-read') {
  $rules=@(Get-NetFirewallRule -PolicyStore ActiveStore -Group $data.group -ErrorAction SilentlyContinue)
  $result=@($rules | ForEach-Object { @{ name=$_.Name; enabled=$_.Enabled.ToString(); direction=$_.Direction.ToString(); action=$_.Action.ToString(); program=($_ | Get-NetFirewallApplicationFilter).Program; remote=@(($_ | Get-NetFirewallAddressFilter).RemoteAddress) } })
}
if ($data.operation -eq 'firewall-remove') {
  foreach ($name in $data.names) {
    $rule=Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue
    if ($rule) {
      if ($rule.Group -ne $data.group) { throw 'Firewall ownership changed' }
      $rule | Remove-NetFirewallRule
    }
  }
  $result=@(Get-NetFirewallRule -Group $data.group -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
}
if ($data.operation -eq 'stop') {
  foreach ($owner in $data.owners) {
    $current=@(Read-Owned $owner.executable) | Where-Object { $_.pid -eq $owner.pid }
    if (@($current).Count) {
      if ($current.start -ne $owner.start -or $current.sid -ne $owner.sid) { throw 'PID identity changed before cleanup' }
      try { Stop-Process -Id $owner.pid -Force }
      catch { if (@(Read-Owned $owner.executable | Where-Object { $_.pid -eq $owner.pid }).Count) { throw } }
    }
  }
  $result=@()
}
ConvertTo-Json -InputObject $result -Depth 12 -Compress
`;

export async function windowsNative(root: string, evidence: string) {
  assert.equal(process.platform, 'win32');
  assert(path.basename(root).startsWith('TEST-updater-windows-'));
  const shell = await selectedWindowsPowerShell();
  const compilerReferences = await windowsShellCompilerReferences(shell);
  const executable = shell.executable;
  const script = path.join(root, 'native.ps1');
  await writeFile(script, powershell);
  await mkdir(evidence, { recursive: true });
  const diagnostics = await mkdtemp(path.join(evidence, 'native-diagnostics-'));
  await copyFile(script, path.join(diagnostics, 'native.ps1'));
  await writeFile(path.join(diagnostics, 'selected-shell.json'), JSON.stringify(shell, null, 2));
  await writeFile(
    path.join(diagnostics, 'compiler-references.json'),
    JSON.stringify(compilerReferences, null, 2)
  );
  const env = await windowsShellTestEnvironment(root, shell);
  let sequence = 0;
  async function call<T>(operation: string, values: Record<string, unknown> = {}): Promise<T> {
    const commandSequence = ++sequence;
    const input = path.join(root, `native-${commandSequence}.json`);
    await writeFile(
      input,
      JSON.stringify({ root, operation, ...values, shell, compilerReferences })
    );
    await copyFile(input, path.join(diagnostics, path.basename(input)));
    const progress = `${input}.progress.jsonl`;
    await writeFile(progress, '');
    const resultFile = path.join(diagnostics, `native-${commandSequence}.result.json`);
    const startedAt = Date.now();
    let result: { stdout: string; stderr: string };
    try {
      const pending = execute(
        executable,
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
          '-InputFile',
          input,
          '-TrustedModulePath',
          shell.modules.join(path.delimiter),
        ],
        { env, timeout: 20_000, maxBuffer: 2_097_152 }
      );
      // Input is passed via -InputFile. Close the unused pipe before awaiting completion.
      pending.child.stdin?.end();
      result = await pending;
    } catch (error) {
      const failure =
        error instanceof Error
          ? (error as ExecFileException & { stdout?: string; stderr?: string })
          : undefined;
      const record = {
        operation,
        shell,
        script,
        input,
        elapsedMs: Date.now() - startedAt,
        code: failure?.code ?? null,
        killed: failure?.killed ?? null,
        signal: failure?.signal ?? null,
        stdout: failure?.stdout ?? null,
        stderr: failure?.stderr ?? null,
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      };
      await writeFile(resultFile, JSON.stringify(record, null, 2));
      throw new Error(
        `Native Windows ${operation} failed; diagnostics: ${resultFile}; ${JSON.stringify({ elapsedMs: record.elapsedMs, code: record.code, killed: record.killed, signal: record.signal })}`,
        { cause: error }
      );
    } finally {
      try {
        await copyFile(progress, path.join(diagnostics, path.basename(progress)));
      } catch (error) {
        await writeFile(
          path.join(diagnostics, `native-${commandSequence}.progress-copy-error.json`),
          JSON.stringify({ operation, progress, error: String(error) }, null, 2)
        );
      }
    }
    await writeFile(
      resultFile,
      JSON.stringify(
        { operation, shell, script, input, elapsedMs: Date.now() - startedAt, ...result },
        null,
        2
      )
    );
    return JSON.parse(result.stdout.trim()) as T;
  }
  return {
    session: () => call<DesktopSession>('session'),
    processes: (executable: string) => call<WindowsProcess[]>('processes', { executable }),
    capture: (owner: WindowsProcess, screenshot: string) =>
      call<NativeWindow | null>('capture', { ...owner, screenshot }),
    signature: (file: string) =>
      call<{
        status: string;
        fileVersion: string;
        productVersion: string;
        subject?: string;
        thumbprint?: string;
      }>('signature', { file }),
    addFirewall: (group: string, name: string, executable: string) =>
      call<FirewallRule[]>('firewall-add', { group, name, executable }),
    firewall: (group: string) => call<FirewallRule[]>('firewall-read', { group }),
    removeFirewall: (group: string, names: string[]) =>
      call<string[]>('firewall-remove', { group, names }),
    stop: (owners: WindowsProcess[]) => call<never[]>('stop', { owners }),
  };
}

export async function readPeArchitecture(file: string) {
  const handle = await open(file, 'r');
  try {
    const dos = Buffer.alloc(64);
    assert.equal((await handle.read(dos, 0, dos.length, 0)).bytesRead, dos.length);
    assert.equal(dos.subarray(0, 2).toString(), 'MZ');
    const pe = Buffer.alloc(6);
    assert.equal((await handle.read(pe, 0, pe.length, dos.readUInt32LE(60))).bytesRead, pe.length);
    assert.equal(pe.subarray(0, 4).toString('hex'), '50450000');
    const machine = pe.readUInt16LE(4);
    assert([0x14c, 0x8664, 0xaa64].includes(machine), 'Unsupported Windows PE machine');
    let architecture = 'x86';
    if (machine === 0xaa64) architecture = 'arm64';
    else if (machine === 0x8664) architecture = 'x64';
    return { machine, architecture };
  } finally {
    await handle.close();
  }
}

if (process.argv.includes('--cleanup')) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  const index = process.argv.indexOf('--cleanup');
  const file = process.argv[index + 1];
  assert(file);
  const owned = JSON.parse(await readFile(file, 'utf8')) as {
    root: string;
    executable: string;
    priorInstaller: string;
    targetInstaller: string;
    firewallGroup: string;
    firewallNames: string[];
  };
  assert(/^TEST-updater-windows-[a-f0-9-]+$/.test(owned.firewallGroup));
  assert(owned.firewallNames.every((name) => name.startsWith(`${owned.firewallGroup}-`)));
  const native = await windowsNative(owned.root, path.dirname(path.resolve(file)));
  const files = [owned.executable, owned.priorInstaller, owned.targetInstaller];
  for (const executable of files) {
    await native.stop(await native.processes(executable));
    assert.equal(
      (await native.processes(executable)).length,
      0,
      'Owned process still active; keep Firewall containment'
    );
  }
  assert.deepEqual(await native.removeFirewall(owned.firewallGroup, owned.firewallNames), []);
}
