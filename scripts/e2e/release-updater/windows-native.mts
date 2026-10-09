import assert from 'node:assert/strict';
import { windowsInstallerLineageSource } from './windows-installer-lineage.mts';
import {
  observeInstallerPs5Control,
  type InstallerLineage,
} from './windows-installer-ps5-diagnostic.mts';
import { testCloudExperiencePreflight } from './windows-cloud-preflight.mts';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  selectedWindowsPowerShell,
  windowsShellCompilerReferences,
  windowsProfileCaptureEnvironment,
  windowsShellTestEnvironment,
} from './windows-powershell.mts';
import { windowsMetadataInventorySource } from './windows-owned-uia-metadata.mts';
import { windowsReadOwnedSource } from './windows-owned-process.mts';
import { absent, releasePhysicalProfile } from './windows-ota-profile.mts';
import { assertNativeRootFocus, windowsUiaSource } from './windows-ota-observer.mts';

import type { ExecFileException } from 'node:child_process';
import type { NativeRootFocus } from './windows-ota-observer.mts';
import type { PhysicalProfile, ProfileOwnership } from './windows-ota-profile.mts';

type NativeMode = 'probe' | 'cleanup';
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
export interface WindowsCaptureRaceProof {
  owner: WindowsProcess;
  hwnd: string;
  focus: Record<string, unknown>;
  diagnostics: string;
}
export class WindowsCaptureBeforePixelsRace extends Error {
  readonly proof: WindowsCaptureRaceProof;
  constructor(proof: WindowsCaptureRaceProof, options?: ErrorOptions) {
    super('Certified owned foreground changed before pixels', options);
    this.proof = proof;
  }
}
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
export function certifyWindowsCaptureRace(
  input: Record<string, unknown>,
  result: Record<string, unknown>,
  progress: string,
  diagnostics: string
): WindowsCaptureRaceProof | null {
  if (
    result.operation !== 'capture' ||
    result.code !== 1 ||
    result.killed !== false ||
    result.signal !== null ||
    typeof result.stderr !== 'string' ||
    !result.stderr.includes(
      'Exception calling "Capture" with "11" argument(s): "Owned foreground changed before pixels"'
    )
  )
    return null;
  if (
    typeof input.pid !== 'number' ||
    !Number.isSafeInteger(input.pid) ||
    input.pid <= 0 ||
    typeof input.start !== 'string' ||
    !input.start ||
    typeof input.executable !== 'string' ||
    typeof input.sid !== 'string' ||
    typeof input.session !== 'number' ||
    typeof input.parent !== 'number' ||
    typeof input.command !== 'string' ||
    input.diagnosticOnly !== false
  )
    return null;
  let frames: Record<string, unknown>[];
  try {
    frames = progress
      .trim()
      .split(/\r?\n/u)
      .map((line) => {
        const frame = object(JSON.parse(line) as unknown);
        if (!frame) throw new Error('Malformed capture progress');
        return frame;
      });
  } catch {
    return null;
  }
  const last = frames.at(-1);
  const focus = object(last?.details);
  if (
    last?.operation !== 'capture' ||
    last.phase !== 'capture-focus' ||
    focus?.synchronizationSucceeded !== true ||
    focus.desiredPid !== input.pid ||
    focus.foregroundPid !== input.pid ||
    typeof focus.desiredHwnd !== 'string' ||
    !/^0*[1-9a-f][0-9a-f]*$/iu.test(focus.desiredHwnd) ||
    focus.foregroundHwnd !== focus.desiredHwnd ||
    focus.desiredThread !== focus.foregroundThread ||
    typeof focus.desiredThread !== 'number' ||
    !Number.isSafeInteger(focus.desiredThread) ||
    focus.desiredThread <= 0
  )
    return null;
  for (const geometry of [focus.ownedGeometry, focus.foregroundGeometry]) {
    const value = object(geometry);
    if (
      value?.pid !== input.pid ||
      value.hwnd !== focus.desiredHwnd ||
      value.thread !== focus.desiredThread
    )
      return null;
  }
  return {
    owner: {
      pid: input.pid,
      start: input.start,
      executable: input.executable,
      sid: input.sid,
      session: input.session,
      parent: input.parent,
      command: input.command,
    },
    hwnd: focus.desiredHwnd,
    focus,
    diagnostics,
  };
}
async function readCaptureRaceProof(
  input: Record<string, unknown>,
  result: Record<string, unknown>,
  progress: string,
  diagnostics: string
) {
  try {
    return certifyWindowsCaptureRace(input, result, await readFile(progress, 'utf8'), diagnostics);
  } catch {
    return null;
  } // Missing/malformed progress never qualifies for retry.
}
function sameWindowsProcess(actual: WindowsProcess | null, expected: WindowsProcess) {
  assert(
    actual?.pid === expected.pid &&
      actual.start === expected.start &&
      actual.executable === expected.executable &&
      actual.sid === expected.sid &&
      actual.session === expected.session &&
      actual.parent === expected.parent &&
      actual.command === expected.command,
    'Capture retry ownership changed'
  );
}
export function certifiedWindowsCaptureRetry<T>(
  owner: WindowsProcess,
  capture: () => Promise<T>,
  readOwner: () => Promise<WindowsProcess | null>,
  persist: (error: WindowsCaptureBeforePixelsRace, failure: number) => Promise<void>,
  deadline: number,
  now: () => number = Date.now
) {
  let failures = 0;
  return async () => {
    for (;;) {
      assert(now() < deadline, 'Native paint deadline exceeded before capture');
      try {
        return await capture();
      } catch (error) {
        if (!(error instanceof WindowsCaptureBeforePixelsRace)) throw error;
        sameWindowsProcess(error.proof.owner, owner);
        await persist(error, ++failures);
        if (failures >= 3 || now() >= deadline) throw error;
        sameWindowsProcess(await readOwner(), owner);
      }
    }
  };
}
export function windowsCaptureRequest(
  owner: WindowsProcess,
  screenshot: string,
  diagnostic?: string
) {
  return { ...owner, screenshot, diagnosticOnly: diagnostic === '1' };
}
export function uniqueWindowsOwners(owners: WindowsProcess[]) {
  const unique = new Map<number, WindowsProcess>();
  for (const owner of owners) {
    assert(Number.isInteger(owner.pid) && owner.pid > 0, 'Invalid TEST PID');
    const previous = unique.get(owner.pid);
    if (previous) {
      assert(
        previous.start === owner.start &&
          previous.sid === owner.sid &&
          previous.session === owner.session &&
          previous.executable === owner.executable,
        'Conflicting TEST PID identity before cleanup'
      );
    } else unique.set(owner.pid, owner);
  }
  return [...unique.values()];
}
export interface CaptionProof {
  pid: number;
  thread: number;
  hwnd: string;
  pointRoot: string;
  pointPid: number;
  pointThread: number;
  hitTest: number;
  sent: number;
  error: number;
  originalTopmost: boolean;
  promoted: boolean;
  restored: boolean;
  restorationError: string | null;
  x: number;
  y: number;
  primaryWidth: number;
  primaryHeight: number;
  rect: [number, number, number, number];
  rectVerified: boolean;
  searchCandidates: number;
  searchElapsedMs: number;
}
export function assertCaptionProof(pid: number, hwnd: string, proof: CaptionProof | null) {
  if (proof === null) return; // Original SetForegroundWindow fast path.
  assert.equal(proof.pid, pid);
  assert.equal(proof.hwnd, hwnd);
  assert.equal(proof.pointRoot, hwnd);
  assert.equal(proof.pointPid, pid);
  assert(Number.isInteger(proof.thread) && proof.thread > 0);
  assert.equal(proof.pointThread, proof.thread);
  assert.equal(proof.hitTest, 2);
  assert.equal(proof.sent, 3);
  assert.equal(proof.restored, true);
  assert.equal(proof.restorationError, null);
  assert(
    [proof.x, proof.y, proof.primaryWidth, proof.primaryHeight, ...proof.rect].every((value) =>
      Number.isInteger(value)
    )
  );
  assert(proof.primaryWidth > 0 && proof.primaryWidth <= 32767);
  assert(proof.primaryHeight > 0 && proof.primaryHeight <= 32767);
  assert(
    proof.x >= 0 && proof.x < proof.primaryWidth && proof.y >= 0 && proof.y < proof.primaryHeight
  );
  const [left, top, right, bottom] = proof.rect;
  assert.equal(proof.rect.length, 4);
  assert(proof.x >= left && proof.x < right && proof.y >= top && proof.y < bottom);
  assert(proof.y < Math.max(0, top) + 64);
  assert.equal(proof.rectVerified, true);
  assert(
    Number.isInteger(proof.searchCandidates) &&
      proof.searchCandidates > 0 &&
      proof.searchCandidates <= 30
  );
  assert(proof.searchElapsedMs >= 0 && proof.searchElapsedMs <= 2000);
}
interface NativeWindow {
  pid: number;
  hwnd: string;
  width: number;
  height: number;
  foreground: boolean;
  screenshot: string;
  caption: CaptionProof | null;
  uiaFocus: NativeRootFocus | null;
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
function Write-TestProgress([string]$phase, [hashtable]$details=$null) {
  $record = @{ operation=$data.operation; phase=$phase; at=[DateTime]::UtcNow.ToString('o') }
  if ($null -ne $details) { $record.details=$details }
  [IO.File]::AppendAllText($progress, (ConvertTo-Json -InputObject $record -Depth 12 -Compress) + [Environment]::NewLine)
}
Write-TestProgress 'after-input-and-shell-validation'
function Get-StartUtcTicks([object]$value) {
  # ConvertFrom-Json can produce DateTime; compare instants without string coercion.
  if ($value -is [DateTimeOffset]) { return $value.UtcDateTime.Ticks }
  if ($value -is [DateTime]) {
    if ($value.Kind -eq [DateTimeKind]::Unspecified) { throw 'Process start must include a time zone' }
    return $value.ToUniversalTime().Ticks
  }
  if ($value -is [string] -and $value -cmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$') {
    return [DateTimeOffset]::Parse($value,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::None).UtcDateTime.Ticks
  }
  throw 'Invalid process start timestamp'
}
function Test-SameStart([object]$actual,[object]$expected) {
  return (Get-StartUtcTicks $actual) -eq (Get-StartUtcTicks $expected)
}
function Test-OwnedPath([string]$file) {
  $full = [IO.Path]::GetFullPath($file)
  if (-not $full.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Path outside TEST root' }
  return $full
}
${windowsReadOwnedSource}
${windowsMetadataInventorySource}
if ($data.operation -eq 'prior-fixture-guard') {
  if (@($data.files).Count -lt 1 -or @($data.files).Count -gt 32 -or $data.registry -isnot [bool]) { throw 'Invalid prior fixture guard request' }
  $rootAttributes=[IO.File]::GetAttributes($root)
  if (($rootAttributes -band [IO.FileAttributes]::ReparsePoint) -or -not ($rootAttributes -band [IO.FileAttributes]::Directory)) { throw 'Fixture root is not an ordinary directory' }
  $files=@(foreach ($file in $data.files) {
    $full=Test-OwnedPath $file; $current=$root; $exists=$true
    $parts=$full.Substring($root.Length+1).Split([IO.Path]::DirectorySeparatorChar)
    if ($parts.Count -gt 24) { throw 'Fixture path depth exceeded' }
    foreach ($part in $parts) {
      $current=[IO.Path]::Combine($current,$part)
      try { $attributes=[IO.File]::GetAttributes($current) } catch {
        if ($_.Exception.InnerException -isnot [IO.FileNotFoundException] -and $_.Exception.InnerException -isnot [IO.DirectoryNotFoundException]) { throw }
        $exists=$false; break
      }
      if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Fixture reparse point rejected' }
    }
    @{ path=$full; exists=$exists }
  })
  $registry=$null
  if ($data.registry) {
    $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry64)
    $app=$null; $uninstall=$null
    try {
      $app=$base.OpenSubKey('Software\dba9559a-8e73-5eee-b6e5-a4142f9e2702')
      $uninstall=$base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall\dba9559a-8e73-5eee-b6e5-a4142f9e2702')
      if (-not $app -or -not $uninstall) { throw 'Actual original NSIS registry metadata unavailable' }
      $registry=@{ installLocation=[string]$app.GetValue('InstallLocation'); uninstallString=[string]$uninstall.GetValue('UninstallString'); quietUninstallString=[string]$uninstall.GetValue('QuietUninstallString'); version=[string]$uninstall.GetValue('DisplayVersion') }
    } finally { if ($app) { $app.Dispose() }; if ($uninstall) { $uninstall.Dispose() }; $base.Dispose() }
  }
  Write-TestProgress 'prior-fixture-guard-complete'
  ConvertTo-Json -InputObject @{ files=$files; registry=$registry } -Depth 8 -Compress
  exit
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
using System.Threading;
using System.Collections.Generic;
using Microsoft.Win32.SafeHandles;
${windowsUiaSource}
public static class TestWindowsNative {
  [DllImport("shell32.dll")] static extern int SHGetKnownFolderPath(ref Guid id, uint flags, IntPtr token, out IntPtr value);
  public static string KnownFolder(string id) {
    Guid folder = new Guid(id); IntPtr value = IntPtr.Zero;
    try {
      int result = SHGetKnownFolderPath(ref folder, 0, IntPtr.Zero, out value);
      if (result != 0) Marshal.ThrowExceptionForHR(result);
      string path = Marshal.PtrToStringUni(value);
      if (String.IsNullOrEmpty(path)) throw new Exception("Known folder is empty");
      return path;
    } finally { if (value != IntPtr.Zero) Marshal.FreeCoTaskMem(value); }
  }
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
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd,StringBuilder value,int count);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, UIntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
  [StructLayout(LayoutKind.Sequential)] public struct Mouse { public int X,Y; public uint Data,Flags,Time; public UIntPtr Extra; }
  [StructLayout(LayoutKind.Sequential)] public struct Input { public uint Type; public Mouse Mouse; }
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd,uint flags);
  [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW",SetLastError=true)] static extern IntPtr GetWindowLongPtr(IntPtr hwnd,int index);
  [DllImport("user32.dll",SetLastError=true)] static extern bool SetWindowPos(IntPtr hwnd,IntPtr after,int x,int y,int width,int height,uint flags);
  [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,Input[] inputs,int size);
  public static object CaptionTrace;
  public static TestOtaObserver.Observation RootFocusTrace;
  public static TestOtaObserver.Observation OwnedMetadataTrace;
  public sealed class OwnedFocusRequired:Exception { public OwnedFocusRequired(string reason):base(reason) {} }
  public static int InputSize() {
    int size=Marshal.SizeOf(typeof(Input));
    if(IntPtr.Size!=8 || size!=40) throw new Exception("Unexpected native INPUT ABI");
    return size;
  }
  static bool Topmost(IntPtr hwnd) {
    Marshal.SetLastPInvokeError(0); IntPtr style=GetWindowLongPtr(hwnd,-20); int error=Marshal.GetLastWin32Error();
    if(style==IntPtr.Zero && error!=0) throw new System.ComponentModel.Win32Exception(error);
    return (style.ToInt64()&8)!=0;
  }
  static object WindowMetrics(IntPtr hwnd) {
    uint pid; uint thread=GetWindowThreadProcessId(hwnd,out pid); Rect r;
    bool valid=GetWindowRect(hwnd,out r); StringBuilder name=new StringBuilder(256);
    int length=GetClassName(hwnd,name,name.Capacity);
    return new { hwnd=hwnd.ToInt64().ToString("x"),pid,thread,className=length>0?name.ToString():null,rect=valid?new int[] {r.Left,r.Top,r.Right,r.Bottom}:null,dpi=GetDpiForWindow(hwnd) };
  }
  static bool SameRect(Rect a,Rect b) { return a.Left==b.Left && a.Top==b.Top && a.Right==b.Right && a.Bottom==b.Bottom; }
  static void SameThread(IntPtr hwnd,uint pid,uint thread,Action validate) {
    validate(); if(OwnedThread(hwnd,pid)!=thread) throw new Exception("Owned HWND thread changed");
  }
  public sealed class CaptionPoint { public string Root="0"; public uint Pid,Thread; public ulong HitTest; }
  static bool OwnedCaption(IntPtr hwnd,uint pid,uint thread,Point point,out CaptionPoint proof,uint timeout=500) {
    IntPtr hit=WindowFromPoint(point); uint hitPid;
    uint hitThread=GetWindowThreadProcessId(hit,out hitPid);
    IntPtr root=GetAncestor(hit,2);
    proof=new CaptionPoint { Root=root.ToInt64().ToString("x"),Pid=hitPid,Thread=hitThread };
    if(root!=hwnd || hitPid!=pid || hitThread!=thread) return false;
    UIntPtr result; long packed=((long)(ushort)point.Y<<16)|(ushort)point.X;
    if(SendMessageTimeout(hwnd,0x84,UIntPtr.Zero,new IntPtr(packed),0x22,timeout,out result)==IntPtr.Zero) throw new Exception("Caption hit-test unavailable");
    proof.HitTest=result.ToUInt64(); return proof.HitTest==2;
  }
  static bool FindCaption(IntPtr hwnd,uint pid,uint thread,Rect r,long deadline,ref int candidates,out Point point,out CaptionPoint proof,out bool occluded) {
    point=new Point(); proof=new CaptionPoint(); occluded=false;
    foreach(int offset in new int[] {8,16,24,32,48}) {
    int y=Math.Max(0,r.Top)+offset;
    foreach(int x in new int[] { (r.Left+r.Right)/2,r.Left+(r.Right-r.Left)/4,r.Right-(r.Right-r.Left)/4 }) {
      if(x<0 || x>=GetSystemMetrics(0) || y<0 || y>=GetSystemMetrics(1) || x<r.Left || x>=r.Right || y<r.Top || y>=r.Bottom) continue;
      long remaining=deadline-Environment.TickCount64;
      if(remaining<=0 || ++candidates>30) throw new Exception("Owned caption search budget exceeded");
      point=new Point { X=x,Y=y };
      if(OwnedCaption(hwnd,pid,thread,point,out proof,(uint)Math.Min(50,remaining))) return true;
      if(proof.Root!=hwnd.ToInt64().ToString("x")) occluded=true;
    }
    }
    return false;
  }
  static void CaptionClick(IntPtr hwnd,uint pid,uint thread,Action validate,Action progress) {
    SameThread(hwnd,pid,thread,validate); Rect r;
    if(!GetWindowRect(hwnd,out r)) throw new Exception("Owned window disappeared");
    Point point=new Point(); object before=WindowMetrics(hwnd);
    int width=GetSystemMetrics(0),height=GetSystemMetrics(1);
    if(width<=0 || height<=0 || width>32767 || height>32767 || r.Right<=r.Left || r.Bottom<=r.Top) throw new Exception("Caption outside bounded screen");
    bool original=Topmost(hwnd),promoted=false,restored=false; uint sent=0; int error=0;
    string restorationError=null; CaptionPoint proof=new CaptionPoint(); bool occluded;
    long searchStart=Environment.TickCount64,searchElapsedMs=-1; int searchCandidates=0; bool rectVerified=false;
    CaptionTrace=new { pid,thread,hwnd=hwnd.ToInt64().ToString("x"),originalTopmost=original,promoted,sent,restored,before,foreground=WindowMetrics(GetForegroundWindow()),phase="before-effects" };
    progress();
    try {
      SameThread(hwnd,pid,thread,validate);
      if(!FindCaption(hwnd,pid,thread,r,searchStart+2000,ref searchCandidates,out point,out proof,out occluded)) {
        if(original || !occluded) throw new OwnedFocusRequired("No accessible owned HTCAPTION point");
        SameThread(hwnd,pid,thread,validate); promoted=true;
        if(!SetWindowPos(hwnd,new IntPtr(-1),0,0,0,0,0x213) || !Topmost(hwnd)) throw new Exception("Owned TOPMOST promotion failed");
        SameThread(hwnd,pid,thread,validate);
        if(!GetWindowRect(hwnd,out r)) throw new Exception("Owned rectangle unavailable after promotion");
      }
      SameThread(hwnd,pid,thread,validate);
      if(!FindCaption(hwnd,pid,thread,r,searchStart+2000,ref searchCandidates,out point,out proof,out occluded)) throw new OwnedFocusRequired("Owned caption occluded or no HTCAPTION point");
      searchElapsedMs=Environment.TickCount64-searchStart;
      Input[] inputs=new Input[] {
        new Input { Mouse=new Mouse { X=(int)((long)point.X*65536/width)+1,Y=(int)((long)point.Y*65536/height)+1,Flags=0x8001 } },
        new Input { Mouse=new Mouse { Flags=2 } }, new Input { Mouse=new Mouse { Flags=4 } }
      };
      SameThread(hwnd,pid,thread,validate);
      Rect fresh; rectVerified=GetWindowRect(hwnd,out fresh) && SameRect(r,fresh);
      if(!rectVerified || point.X<fresh.Left || point.X>=fresh.Right || point.Y<fresh.Top || point.Y>=Math.Min(fresh.Bottom,Math.Max(0,fresh.Top)+64)) throw new Exception("Owned selected caption rectangle changed");
      if(width!=GetSystemMetrics(0) || height!=GetSystemMetrics(1) || point.X<0 || point.X>=width || point.Y<0 || point.Y>=height) throw new Exception("Selected caption outside unchanged primary screen");
      if(!OwnedCaption(hwnd,pid,thread,point,out proof)) throw new Exception("Selected caption changed before input");
      Marshal.SetLastPInvokeError(0); sent=SendInput(3,inputs,InputSize()); error=Marshal.GetLastWin32Error();
      if(sent!=3) throw new Exception("Caption input incomplete or blocked; UIPI cause is unknown");
      SameThread(hwnd,pid,thread,validate);
      if(!OwnedCaption(hwnd,pid,thread,point,out proof)) throw new Exception("Caption ownership changed after input");
      UIntPtr ignored;
      if(SendMessageTimeout(hwnd,0,UIntPtr.Zero,IntPtr.Zero,0x22,500,out ignored)==IntPtr.Zero || GetForegroundWindow()!=hwnd) throw new Exception("Caption click did not activate owned HWND");
    } finally {
      try {
        SameThread(hwnd,pid,thread,validate);
        if(promoted && !SetWindowPos(hwnd,new IntPtr(-2),0,0,0,0,0x213)) throw new Exception("Owned TOPMOST restoration failed");
        SameThread(hwnd,pid,thread,validate); restored=Topmost(hwnd)==original;
        if(!restored) throw new Exception("Owned TOPMOST restoration uncertain");
      } catch(Exception cleanup) { restorationError=cleanup.Message; }
      if(searchElapsedMs<0) searchElapsedMs=Environment.TickCount64-searchStart;
      CaptionTrace=new { pid,thread,hwnd=hwnd.ToInt64().ToString("x"),x=point.X,y=point.Y,pointRoot=proof.Root,pointPid=proof.Pid,pointThread=proof.Thread,hitTest=proof.HitTest,primaryWidth=width,primaryHeight=height,rect=new int[] {r.Left,r.Top,r.Right,r.Bottom},rectVerified,searchCandidates,searchElapsedMs,before,after=WindowMetrics(hwnd),foreground=WindowMetrics(GetForegroundWindow()),originalTopmost=original,promoted,sent,error,restored,restorationError };
      if(restorationError!=null) throw new Exception(restorationError);
    }
  }
  public static object[] FocusTrace;
  static uint OwnedThread(IntPtr hwnd, uint expectedPid) {
    uint pid; uint thread=GetWindowThreadProcessId(hwnd, out pid);
    if (thread == 0 || pid != expectedPid) throw new Exception("HWND owner changed");
    return thread;
  }
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
  public static int[] Capture(IntPtr hwnd, uint expectedPid, string file, Action validate, Action progress, string executable, string sid, int session, long cimTicks,bool diagnosticOnly,Func<TestOtaObserver.FocusRequest[]> inventory) {
    CaptionTrace=null; RootFocusTrace=null; OwnedMetadataTrace=null; validate();
    uint thread=OwnedThread(hwnd,expectedPid);
    if(diagnosticOnly) {
      SameThread(hwnd,expectedPid,thread,validate);
      try { OwnedMetadataTrace=TestOtaObserver.FocusMetadata(hwnd.ToInt64(),expectedPid,thread,executable,sid,session,cimTicks,inventory); }
      catch(Exception error) { OwnedMetadataTrace=new TestOtaObserver.Observation { Error=error.Message,HResult=error.HResult }; }
      throw new OwnedFocusRequired("Metadata-only diagnostic cannot qualify native capture");
    }
    ShowWindow(hwnd, 9);
    if (OwnedThread(hwnd,expectedPid) != thread) throw new Exception("HWND thread changed");
    bool accepted=SetForegroundWindow(hwnd), synchronized=false;
    if (accepted) {
      if (OwnedThread(hwnd,expectedPid) != thread) throw new Exception("HWND thread changed");
      // WM_NULL waits for this owned window's asynchronous activation, without joining input queues.
      UIntPtr ignored; synchronized=SendMessageTimeout(hwnd,0,UIntPtr.Zero,IntPtr.Zero,0x22,500,out ignored) != IntPtr.Zero;
    }
    IntPtr foreground=GetForegroundWindow(); uint foregroundPid;
    uint foregroundThread=GetWindowThreadProcessId(foreground,out foregroundPid);
    FocusTrace=new object[] { hwnd.ToInt64().ToString("x"), expectedPid, thread, foreground.ToInt64().ToString("x"), foregroundPid, foregroundThread, GetCurrentThreadId(), accepted, synchronized, WindowMetrics(foreground), WindowMetrics(hwnd) };
    if (OwnedThread(hwnd,expectedPid) != thread) throw new Exception("HWND thread changed");
    if ((accepted && !synchronized) || foreground != hwnd) {
      try { CaptionClick(hwnd,expectedPid,thread,validate,progress); }
      catch(OwnedFocusRequired) {
        SameThread(hwnd,expectedPid,thread,validate);
        RootFocusTrace=new TestOtaObserver.Observation { RootHwnd=hwnd.ToInt64().ToString("x"),RootPid=expectedPid,RootThread=thread };
        try {
          RootFocusTrace=TestOtaObserver.Focus(hwnd.ToInt64(),expectedPid,thread,executable,sid,session,cimTicks);
          if(RootFocusTrace.Error!=null) throw new Exception(RootFocusTrace.Error);
        } catch(Exception error) { if(RootFocusTrace.Error==null) { RootFocusTrace.Error=error.Message; RootFocusTrace.HResult=error.HResult; } throw; }
        SameThread(hwnd,expectedPid,thread,validate);
      }
      if(GetForegroundWindow()!=hwnd) throw new Exception("Owned foreground changed after caption fallback");
    }
    SameThread(hwnd,expectedPid,thread,validate);
    Rect r; if (!GetWindowRect(hwnd, out r)) throw new Exception("Window disappeared");
    // Copy actual desktop pixels belonging to this visible foreground HWND.
    int left=Math.Max(0,r.Left), top=Math.Max(0,r.Top);
    int width=Math.Min(r.Right,GetSystemMetrics(0))-left, height=Math.Min(r.Bottom,GetSystemMetrics(1))-top;
    if (width < 300 || height < 200) throw new Exception("Owned window has insufficient visible screen area");
    if(GetForegroundWindow()!=hwnd) throw new Exception("Owned foreground changed before pixels");
    using (Bitmap image = new Bitmap(width,height)) {
      using (Graphics graphics = Graphics.FromImage(image)) graphics.CopyFromScreen(left,top,0,0,new Size(width,height));
      image.Save(file,ImageFormat.Png);
    }
    SameThread(hwnd,expectedPid,thread,validate);
    if(GetForegroundWindow()!=hwnd) throw new Exception("Owned foreground changed during pixels");
    return new int[] { (int)expectedPid, width, height };
  }
}
'@ -ReferencedAssemblies $compilerReferences
Write-TestProgress 'after-native-compile'
Write-TestProgress 'operation-entry'
$result = $null
switch ($data.operation) {
  'compile' { $uia=[TestOtaObserver]::Compile(); $result=@{ uia=$uia; inputSize=[TestWindowsNative]::InputSize(); pointerSize=[IntPtr]::Size } }
  'profile' {
    foreach($registry in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
      if (Test-Path -LiteralPath $registry) {
        $installed=@(Get-ChildItem -LiteralPath $registry | Get-ItemProperty | Where-Object { $_.DisplayName -match '^Agent Teams AI(?:$|\s)' })
        if ($installed.Count) { throw 'Disposable OS profile already has an Agent Teams AI installation' }
      }
    }
    # Native token-based Known Folders avoid PS7/.NET environment-first shortcuts.
    $result=@{ home=[TestWindowsNative]::KnownFolder('5E6C858F-0E22-4760-9AFE-EA3317B67173'); roaming=[TestWindowsNative]::KnownFolder('3EB685DB-65F9-4CF6-A03A-E3EF65729F3D'); local=[TestWindowsNative]::KnownFolder('F1B32785-6FBA-4FCF-9D55-7B8E7F157091') }
  }
  'session' {
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    $principal=New-Object Security.Principal.WindowsPrincipal($identity)
    $result=@{ station=[TestWindowsNative]::ObjectName([TestWindowsNative]::GetProcessWindowStation()); desktop=[TestWindowsNative]::ObjectName([TestWindowsNative]::GetThreadDesktop([TestWindowsNative]::GetCurrentThreadId())); session=(Get-Process -Id $PID).SessionId; sid=$identity.User.Value; administrator=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
  }
  'processes' { $result=@(Read-Owned $data.executable) }
${windowsInstallerLineageSource}
  'capture' {
    if ($data.diagnosticOnly -isnot [bool]) { throw 'Explicit Boolean diagnostic mode required' }
    $validate=[Action] {
      $process=@(Read-Owned $data.executable | Where-Object { $_.pid -eq $data.pid -and (Test-SameStart $_.start $data.start) -and $_.sid -eq $data.sid -and $_.session -eq $data.session })
      if ($process.Count -ne 1) { throw 'Owned process identity changed during native capture' }
    }
    $validate.Invoke()
    $handle=[TestWindowsNative]::VisibleWindow($data.pid)
    if ($handle -eq [IntPtr]::Zero) { $result=$null; break }
    $file=Test-OwnedPath $data.screenshot
    $inventory=[Func[TestOtaObserver+FocusRequest[]]] { Get-MetadataOwners }
    $attemptProgress=[Action] { Write-TestProgress 'caption-before-effects' @{ trace=[TestWindowsNative]::CaptionTrace } }
    try { $pixels=[TestWindowsNative]::Capture($handle,$data.pid,$file,$validate,$attemptProgress,$data.executable,$data.sid,$data.session,(Get-StartUtcTicks $data.start),$data.diagnosticOnly,$inventory) }
    finally {
      Write-TestProgress 'caption-attempt' @{ trace=[TestWindowsNative]::CaptionTrace }
      Write-TestProgress 'capture-uia-focus' @{ observation=[TestWindowsNative]::RootFocusTrace }
      if ($null -ne [TestWindowsNative]::OwnedMetadataTrace) { Write-TestProgress 'capture-owned-uia-metadata' @{ observation=[TestWindowsNative]::OwnedMetadataTrace } }
      $focus=[TestWindowsNative]::FocusTrace
      if ($null -ne $focus) { Write-TestProgress 'capture-focus' @{ desiredHwnd=$focus[0]; desiredPid=$focus[1]; desiredThread=$focus[2]; foregroundHwnd=$focus[3]; foregroundPid=$focus[4]; foregroundThread=$focus[5]; callerThread=$focus[6]; setForegroundAccepted=$focus[7]; synchronizationSucceeded=$focus[8]; foregroundGeometry=$focus[9]; ownedGeometry=$focus[10] } }
    }
    if ($null -eq $pixels) { Write-TestProgress 'capture-foreground-pending'; $result=$null; break }
    if ($pixels[0] -ne $data.pid) { throw 'HWND owner changed' }
    $result=@{ pid=$pixels[0]; hwnd=$handle.ToInt64().ToString('x'); width=$pixels[1]; height=$pixels[2]; foreground=$true; screenshot=$file; caption=[TestWindowsNative]::CaptionTrace; uiaFocus=[TestWindowsNative]::RootFocusTrace }
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
      if (-not (Test-SameStart $current.start $owner.start) -or $current.sid -ne $owner.sid) { throw 'PID identity changed before cleanup' }
      try { Stop-Process -Id $owner.pid -Force }
      catch { if (@(Read-Owned $owner.executable | Where-Object { $_.pid -eq $owner.pid }).Count) { throw } }
    }
  }
  $result=@()
}
ConvertTo-Json -InputObject $result -Depth 12 -Compress
`;

export async function windowsNative(root: string, evidence: string, purpose: NativeMode = 'probe') {
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
    let childPid: number | undefined;
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
        {
          env: operation === 'profile' ? windowsProfileCaptureEnvironment(env) : env,
          timeout: operation === 'compile' || operation === 'firewall-add' ? 60_000 : 20_000,
          windowsHide: true,
          maxBuffer: 2_097_152,
        }
      );
      childPid = pending.child.pid;
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
        childPid,
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
      if (operation === 'capture') {
        const proof = await readCaptureRaceProof(values, record, progress, resultFile);
        if (proof) throw new WindowsCaptureBeforePixelsRace(proof, { cause: error });
      }
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
        { operation, childPid, shell, script, input, elapsedMs: Date.now() - startedAt, ...result },
        null,
        2
      )
    );
    return JSON.parse(result.stdout.trim()) as T;
  }
  await call('compile');
  await testCloudExperiencePreflight(root, evidence, shell, compilerReferences, env, purpose);
  return {
    priorFixtureGuard: (files: string[], registry: boolean) =>
      call<{
        files: { path: string; exists: boolean }[];
        registry: null | {
          installLocation: string;
          uninstallString: string;
          quietUninstallString: string;
          version: string;
        };
      }>('prior-fixture-guard', { files, registry }),
    physicalProfile: () => call<PhysicalProfile>('profile'),
    session: () => call<DesktopSession>('session'),
    processes: (executable: string) => call<WindowsProcess[]>('processes', { executable }),
    installerLineage: async (
      owner: Omit<WindowsProcess, 'command'>,
      spawnEnv?: NodeJS.ProcessEnv
    ) => {
      const lineage = await call<InstallerLineage>('installer-lineage', { owner });
      return {
        ...lineage,
        diagnostic: spawnEnv
          ? await observeInstallerPs5Control(lineage, shell.systemRoot, root, spawnEnv)
          : null,
      };
    },
    capture: async (owner: WindowsProcess, screenshot: string) => {
      const window = await call<NativeWindow | null>(
        'capture',
        windowsCaptureRequest(owner, screenshot, process.env.TEST_WINDOWS_OWNED_UIA_DIAGNOSTIC)
      );
      if (window?.uiaFocus) {
        assert(window.caption);
        assertNativeRootFocus(owner, window.hwnd, window.caption, window.uiaFocus);
      }
      return window;
    },
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
    stop: (owners: WindowsProcess[]) =>
      call<never[]>('stop', { owners: uniqueWindowsOwners(owners) }),
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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  process.argv.includes('--cleanup')
) {
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
    profileFile?: string;
    fixtureDecoder?: string;
  };
  assert(/^TEST-updater-windows-[a-f0-9-]+$/.test(owned.firewallGroup));
  assert(owned.firewallNames.every((name) => name.startsWith(`${owned.firewallGroup}-`)));
  const native = await windowsNative(owned.root, path.dirname(path.resolve(file)), 'cleanup');
  const files = [owned.executable, owned.priorInstaller, owned.targetInstaller];
  if (owned.fixtureDecoder) {
    assert.equal(owned.fixtureDecoder, path.join(owned.root, 'prior-fixture', '7za.exe'));
    files.push(owned.fixtureDecoder);
  }
  for (const executable of files) {
    await native.stop(await native.processes(executable));
    assert.equal(
      (await native.processes(executable)).length,
      0,
      'Owned process still active; keep Firewall containment'
    );
  }
  assert.deepEqual(await native.removeFirewall(owned.firewallGroup, owned.firewallNames), []);
  if (owned.profileFile && !(await absent(owned.profileFile))) {
    assert.equal(path.basename(owned.profileFile), 'profile-ownership.json');
    assert.equal(path.dirname(path.resolve(owned.profileFile)), path.dirname(path.resolve(file)));
    const profile = JSON.parse(await readFile(owned.profileFile, 'utf8')) as ProfileOwnership;
    assert.equal(profile.root, owned.root);
    await releasePhysicalProfile(profile);
  }
}
