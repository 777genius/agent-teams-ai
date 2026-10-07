import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  selectedWindowsPowerShell,
  windowsShellCompilerReferences,
  windowsShellTestEnvironment,
} from './windows-powershell.mts';

import type { WindowsProcess } from './windows-native.mts';

export interface NativeNames {
  Names: string[];
  Error: string | null;
  HResult: number;
  Visited: number;
  RootChildren: number;
  MaxDepth: number;
  Characters: number;
  ProcessIds: number[];
  RootHwnd: string;
  RootPid: number;
  RootThread: number;
}
export function assertNativeNames(ownerPid: number, hwnd: string, observation: NativeNames) {
  assert.equal(observation.Error, null, observation.Error ?? 'Native UIA error');
  assert.equal(observation.HResult, 0);
  assert.equal(observation.RootPid, ownerPid);
  assert.equal(observation.RootHwnd, hwnd);
  assert(Number.isInteger(observation.RootThread) && observation.RootThread > 0);
  assert(
    Number.isInteger(observation.Visited) &&
      observation.Visited > 0 &&
      observation.Visited <= 20_000
  );
  assert(
    Number.isInteger(observation.MaxDepth) &&
      observation.MaxDepth >= 0 &&
      observation.MaxDepth <= 64
  );
  assert(observation.RootChildren >= 0 && observation.RootChildren < observation.Visited);
  assert(observation.Characters >= 0 && observation.Characters <= 1_000_000);
  assert(observation.Names.length <= observation.Visited);
  assert(observation.Names.every((name) => typeof name === 'string' && name.length <= 4096));
  assert(observation.ProcessIds.length <= observation.Visited);
  assert(observation.ProcessIds.every((pid) => Number.isInteger(pid) && pid > 0));
}
const execute = promisify(execFile);
const script = String.raw`
param([string]$InputFile,[string]$TrustedModulePath)
$ErrorActionPreference='Stop'
[Environment]::SetEnvironmentVariable('PSModulePath',$TrustedModulePath,'Process')
$data=ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($InputFile))
if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.ToString() -ne $data.shell.version -or $PSHOME -ne $data.shell.psHome -or [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName -ne $data.shell.executable) { throw 'Selected installed PS7 identity changed' }
$refs=[string[]]@($data.references.assemblies | Where-Object { [IO.Path]::GetDirectoryName($_.file) -eq [IO.Path]::Combine($PSHOME,'ref') } | ForEach-Object { $_.file })
if ($refs.Count -lt 4) { throw 'Installed PSHOME references required' }
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Threading;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
// Exact IUnknown prefixes from Microsoft's UIAutomationClient.h; unused slots are never called.
[ComImport,Guid("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface TestAutomation {
  void CompareElements(); void CompareRuntimeIds(); void GetRootElement();
  [PreserveSig] int ElementFromHandle(IntPtr hwnd,out TestElement element);
  void ElementFromPoint(); void GetFocusedElement(); void GetRootElementBuildCache();
  void ElementFromHandleBuildCache(); void ElementFromPointBuildCache(); void GetFocusedElementBuildCache();
  void CreateTreeWalker(); void ControlViewWalker(); void ContentViewWalker();
  [PreserveSig] int RawViewWalker(out TestWalker walker);
}
[ComImport,Guid("d22108aa-8ac5-49a5-837b-37bbb3d7591e"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface TestElement {
  void SetFocus(); void GetRuntimeId(); void FindFirst(); void FindAll();
  void FindFirstBuildCache(); void FindAllBuildCache(); void BuildUpdatedCache();
  [PreserveSig] int GetCurrentPropertyValue(int id,[MarshalAs(UnmanagedType.Struct)] out object value);
}
[ComImport,Guid("4042c624-389c-4afc-a630-9df854a541fc"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface TestWalker {
  void GetParentElement();
  [PreserveSig] int FirstChild(TestElement element,out TestElement child);
  void GetLastChildElement();
  [PreserveSig] int NextSibling(TestElement element,out TestElement sibling);
}
public static class TestOtaObserver {
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string file,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle file,StringBuilder path,uint count,uint flags);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window,uint flags);
  [DllImport("ole32.dll")] static extern int CoInitializeEx(IntPtr reserved,uint flags);
  [DllImport("ole32.dll")] static extern void CoUninitialize();
  public static string Canonical(string file) {
    using(SafeFileHandle handle=CreateFile(file,0,7,IntPtr.Zero,3,0x02000000,IntPtr.Zero)) {
      if(handle.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      StringBuilder result=new StringBuilder(32768);
      uint size=GetFinalPathNameByHandle(handle,result,(uint)result.Capacity,0);
      if(size==0 || size>=result.Capacity) throw new Exception("Cannot resolve actual installed file");
      string value=result.ToString();
      if(value.StartsWith(@"\\?\")) value=value.Substring(4);
      if(value.StartsWith("UNC",StringComparison.OrdinalIgnoreCase)) throw new Exception("TEST files must be local");
      return value;
    }
  }
  public sealed class Observation {
    public string[] Names=new string[0]; public string Error;
    public int HResult,Visited,RootChildren,MaxDepth,Characters;
    public int[] ProcessIds=new int[0]; public string RootHwnd; public uint RootPid,RootThread;
  }
  static object Property(TestElement element,int id) {
    object value; Marshal.ThrowExceptionForHR(element.GetCurrentPropertyValue(id,out value)); return value;
  }
  static IntPtr ElementHandle(TestElement element) {
    return new IntPtr(unchecked((long)(uint)Convert.ToInt32(Property(element,30020))));
  }
  static void RootOwner(IntPtr hwnd,uint pid,uint thread) {
    uint actual; uint current=GetWindowThreadProcessId(hwnd,out actual);
    if(actual!=pid || current==0 || (thread!=0 && current!=thread)) throw new Exception("Native UIA HWND identity changed");
  }
  static void Walk(TestElement element,TestWalker walker,IntPtr window,List<string> names,HashSet<int> pids,Observation result,int depth) {
    if(depth>64 || ++result.Visited>20000) throw new Exception("Native UIA subtree exceeds observer bounds");
    result.MaxDepth=Math.Max(result.MaxDepth,depth);
    IntPtr handle=ElementHandle(element);
    if(handle!=IntPtr.Zero && GetAncestor(handle,2)!=window) throw new Exception("Native UIA element outside owned HWND root");
    pids.Add(Convert.ToInt32(Property(element,30002)));
    string name=Property(element,30005) as string;
    if(name!=null) {
      result.Characters+=name.Length;
      if(name.Length>4096 || result.Characters>1000000) throw new Exception("Native UIA name budget exceeded");
      if(!String.IsNullOrWhiteSpace(name)) names.Add(name);
    }
    TestElement child=null;
    try {
      Marshal.ThrowExceptionForHR(walker.FirstChild(element,out child));
      while(child!=null) {
        if(depth==0) result.RootChildren++;
        Walk(child,walker,window,names,pids,result,depth+1);
        TestElement next=null;
        try { Marshal.ThrowExceptionForHR(walker.NextSibling(child,out next)); }
        catch { if(next!=null) Marshal.ReleaseComObject(next); throw; }
        Marshal.ReleaseComObject(child); child=next;
      }
    } finally { if(child!=null) Marshal.ReleaseComObject(child); }
  }
  static void Release(object value,Observation result) {
    if(value==null) return;
    try { Marshal.ReleaseComObject(value); }
    catch(Exception error) { if(result.Error==null) { result.Error=error.Message; result.HResult=error.HResult; } }
  }
  static Observation Observe(IntPtr window,uint pid,bool compileOnly) {
    Observation result=new Observation { RootHwnd=window.ToInt64().ToString("x"),RootPid=pid };
    Exception failure=null;
    Thread worker=new Thread(()=> {
      TestAutomation automation=null; TestWalker walker=null; TestElement root=null;
      bool initialized=false; List<string> names=new List<string>(); HashSet<int> pids=new HashSet<int>();
      try {
        Marshal.ThrowExceptionForHR(CoInitializeEx(IntPtr.Zero,0)); initialized=true;
        automation=(TestAutomation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("ff48dba4-60ef-4201-aa87-54103eef594e"),true));
        Marshal.ThrowExceptionForHR(automation.RawViewWalker(out walker));
        if(walker==null) throw new Exception("Native UIA RawViewWalker unavailable");
        if(!compileOnly) {
          uint actual; result.RootThread=GetWindowThreadProcessId(window,out actual);
          RootOwner(window,pid,result.RootThread);
          Marshal.ThrowExceptionForHR(automation.ElementFromHandle(window,out root));
          if(root==null || ElementHandle(root)!=window || Convert.ToInt32(Property(root,30002))!=pid) throw new Exception("Native UIA root HWND/PID mismatch");
          Walk(root,walker,window,names,pids,result,0);
          if(ElementHandle(root)!=window || Convert.ToInt32(Property(root,30002))!=pid) throw new Exception("Native UIA root changed after traversal");
          RootOwner(window,pid,result.RootThread);
        }
      } catch(Exception error) { failure=error; result.Error=error.Message; result.HResult=error.HResult; }
      finally {
        result.Names=names.ToArray(); result.ProcessIds=new List<int>(pids).ToArray();
        Release(root,result); Release(walker,result); Release(automation,result);
        if(initialized) CoUninitialize();
      }
    });
    worker.IsBackground=true; worker.SetApartmentState(ApartmentState.MTA); worker.Start();
    if(!worker.Join(15000)) throw new Exception("Native UIA MTA observation exceeded15seconds");
    if(compileOnly && result.Error!=null) throw new Exception(result.Error,failure);
    return result;
  }
  public static Observation Compile() { return Observe(IntPtr.Zero,0,true); }
  public static Observation WindowNames(long handle,uint pid) { return Observe(new IntPtr(handle),pid,false); }
}
'@ -ReferencedAssemblies $refs
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
function Test-Canonical([string]$file) {
  $full=[TestOtaObserver]::Canonical($file)
  $prefix=[IO.Path]::GetFullPath($data.root)+[IO.Path]::DirectorySeparatorChar
  if (-not $full.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) { throw 'File outside owned TEST root' }
  return $full
}
function Read-Owned([string]$file) {
  $expected=Test-Canonical $file
  $items=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and [IO.Path]::GetFileName($_.ExecutablePath) -eq [IO.Path]::GetFileName($expected) })
  return @($items | ForEach-Object {
    $actual=Test-Canonical $_.ExecutablePath
    if ($actual -eq $expected) {
      $owner=Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid
      if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -or $_.SessionId -ne (Get-Process -Id $PID).SessionId) { throw 'TEST process owner/session mismatch' }
      @{ pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; executable=$actual; actualExecutable=$_.ExecutablePath; command=$_.CommandLine; start=$_.CreationDate.ToUniversalTime().ToString('o'); session=[int]$_.SessionId; sid=$owner.Sid }
    }
  })
}
switch ($data.operation) {
  'compile' { $result=[TestOtaObserver]::Compile() }
  'processes' { $result=@(Read-Owned $data.file) }
  'watch-installer' {
    $result=@(); $deadline=[DateTime]::UtcNow.AddSeconds(5)
    [IO.File]::WriteAllText([IO.Path]::Combine($data.root,'ota-installer-observer.ready'),[DateTime]::UtcNow.ToString('o'))
    while ([DateTime]::UtcNow -lt $deadline) {
      $result+=@(Read-Owned $data.file)
      [Threading.Thread]::Sleep(100)
    }
  }
  'firewall-add' {
    $canonical=Test-Canonical $data.file
    if ($data.group -notmatch '^TEST-updater-windows-[a-f0-9-]+$' -or -not $data.name.StartsWith($data.group+'-',[StringComparison]::Ordinal)) { throw 'Not an owned Firewall rule' }
    if ($canonical -ne $data.canonical) { throw 'Pending installer canonical identity changed' }
    if (@(Get-NetFirewallProfile | Where-Object { -not $_.Enabled }).Count -or (Get-NetFirewallRule -Name $data.name -ErrorAction SilentlyContinue)) { throw 'Firewall containment prerequisite failed' }
    New-NetFirewallRule -Name $data.name -DisplayName $data.name -Group $data.group -Direction Outbound -Action Block -Program $data.file -Profile Any -RemoteAddress @('0.0.0.0-126.255.255.255','128.0.0.0-255.255.255.255','::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff') | Out-Null
    $result=@{ program=$data.file; canonical=$canonical; name=$data.name }
  }
  'names' {
    $owner=@(Read-Owned $data.owner.executable | Where-Object { $_.pid -eq $data.owner.pid -and (Test-SameStart $_.start $data.owner.start) })
    if ($owner.Count -ne 1 -or $owner[0].sid -ne $data.owner.sid -or $owner[0].session -ne $data.owner.session) { throw 'Native window PID identity changed' }
    $result=[TestOtaObserver]::WindowNames([Convert]::ToInt64($data.hwnd,16),[uint32]$data.owner.pid)
    $again=@(Read-Owned $data.owner.executable | Where-Object { $_.pid -eq $data.owner.pid -and (Test-SameStart $_.start $data.owner.start) })
    if ($again.Count -ne 1 -or $again[0].sid -ne $data.owner.sid -or $again[0].session -ne $data.owner.session) { throw 'Native window identity changed during accessibility read' }
  }
  'stop' {
    foreach($owner in $data.owners) {
      $current=@(Read-Owned $owner.executable | Where-Object { $_.pid -eq $owner.pid })
      if ($current.Count -eq 0) { continue }
      if ($current.Count -ne 1 -or -not (Test-SameStart $current[0].start $owner.start) -or $current[0].sid -ne $owner.sid -or $current[0].session -ne $owner.session) { throw 'Refuse changed TEST PID identity' }
      Stop-Process -Id $owner.pid -Force -ErrorAction Stop
    }
    $result=@()
  }
  default { throw 'Unknown TEST observer operation' }
}
ConvertTo-Json -InputObject $result -Depth 12 -Compress
`;

export async function windowsOtaObserver(root: string, evidence: string) {
  assert.equal(process.platform, 'win32');
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert(path.basename(root).startsWith('TEST-updater-windows-'));
  const shell = await selectedWindowsPowerShell();
  const references = await windowsShellCompilerReferences(shell);
  const env = await windowsShellTestEnvironment(root, shell);
  const filename = path.join(root, 'ota-observer.ps1');
  const directory = await mkdtemp(path.join(evidence, 'ota-native-observer-'));
  await writeFile(filename, script);
  await writeFile(path.join(directory, 'native-source.ps1'), script);
  await writeFile(
    path.join(directory, 'compiler-references.json'),
    JSON.stringify(references, null, 2)
  );
  let sequence = 0;
  async function call<T>(operation: string, values: Record<string, unknown> = {}): Promise<T> {
    const input = path.join(root, `ota-native-${++sequence}.json`);
    await writeFile(input, JSON.stringify({ root, shell, references, operation, ...values }));
    const startedAt = Date.now();
    let childPid: number | undefined;
    try {
      const pending = execute(
        shell.executable,
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          filename,
          '-InputFile',
          input,
          '-TrustedModulePath',
          shell.modules.join(path.delimiter),
        ],
        { env, timeout: 20_000, windowsHide: true, maxBuffer: 4_194_304 }
      );
      childPid = pending.child.pid;
      pending.child.stdin?.end();
      const result = await pending;
      await writeFile(
        path.join(directory, path.basename(input)),
        JSON.stringify(
          {
            operation,
            childPid,
            input: JSON.parse(await readFile(input, 'utf8')) as unknown,
            elapsedMs: Date.now() - startedAt,
            ...result,
          },
          null,
          2
        )
      );
      return JSON.parse(result.stdout.trim()) as T;
    } catch (error) {
      const failure =
        error instanceof Error
          ? (error as Error & {
              stdout?: string;
              stderr?: string;
              code?: number | string;
              signal?: string;
              killed?: boolean;
            })
          : undefined;
      await writeFile(
        path.join(directory, path.basename(input)),
        JSON.stringify(
          {
            operation,
            childPid,
            error: String(error),
            stdout: failure?.stdout,
            stderr: failure?.stderr,
            code: failure?.code,
            signal: failure?.signal,
            killed: failure?.killed,
            elapsedMs: Date.now() - startedAt,
          },
          null,
          2
        )
      );
      throw error;
    }
  }
  await call('compile');
  return {
    watchReadyFile: path.join(root, 'ota-installer-observer.ready'),
    processes: (file: string) => call<WindowsProcess[]>('processes', { file }),
    watchInstaller: (file: string) => call<WindowsProcess[]>('watch-installer', { file }),
    addPendingFirewall: (group: string, name: string, file: string, canonical: string) =>
      call('firewall-add', { group, name, file, canonical }),
    names: (owner: WindowsProcess, hwnd: string) => call<NativeNames>('names', { owner, hwnd }),
    stop: (owners: WindowsProcess[]) => call<never[]>('stop', { owners }),
  };
}
