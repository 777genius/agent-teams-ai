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
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
// The IAccessible vtable prefix: IUnknown, four IDispatch slots, then
// get_accParent/get_accChildCount/get_accChild/get_accName (oleacc.h).
[ComImport,Guid("618736E0-3C3D-11CF-810C-00AA00389B71"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface TestAccessible {
  [PreserveSig] int GetTypeInfoCount(out uint count);
  [PreserveSig] int GetTypeInfo(uint index,uint locale,out IntPtr info);
  [PreserveSig] int GetIDsOfNames(ref Guid iid,IntPtr names,uint count,uint locale,IntPtr ids);
  [PreserveSig] int Invoke(int id,ref Guid iid,uint locale,ushort flags,IntPtr arguments,IntPtr result,IntPtr exception,IntPtr argumentError);
  [PreserveSig] int Parent(out IntPtr parent);
  [PreserveSig] int ChildCount(out int count);
  [PreserveSig] int Child([MarshalAs(UnmanagedType.Struct)] object id,out IntPtr child);
  [PreserveSig] int Name([MarshalAs(UnmanagedType.Struct)] object id,[MarshalAs(UnmanagedType.BStr)] out string name);
}
public static class TestOtaObserver {
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string file,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle file,StringBuilder path,uint count,uint flags);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
  [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr window,uint objectId,ref Guid iid,out IntPtr result);
  [DllImport("oleacc.dll")] static extern int AccessibleChildren([MarshalAs(UnmanagedType.Interface)] TestAccessible parent,int start,int count,[Out,MarshalAs(UnmanagedType.LPArray,ArraySubType=UnmanagedType.Struct,SizeParamIndex=2)] object[] children,out int obtained);
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
  static void AddName(TestAccessible accessible,object id,List<string> names) {
    string name;
    int result=accessible.Name(id,out name);
    if(result<0) Marshal.ThrowExceptionForHR(result);
    if(!String.IsNullOrWhiteSpace(name)) names.Add(name);
  }
  static void Walk(TestAccessible accessible,List<string> names,int depth,ref int visited) {
    if(depth>64 || ++visited>20000) throw new Exception("Accessibility tree exceeds bounded TEST observer");
    AddName(accessible,0,names);
    int count; Marshal.ThrowExceptionForHR(accessible.ChildCount(out count));
    if(count<0 || count>20000) throw new Exception("Invalid accessibility child count");
    if(count==0) return;
    object[] children=new object[count]; int obtained;
    Marshal.ThrowExceptionForHR(AccessibleChildren(accessible,0,count,children,out obtained));
    for(int index=0;index<obtained;index++) {
      object child=children[index];
      if(child is int) AddName(accessible,child,names);
      else if(child!=null) {
        try { Walk((TestAccessible)child,names,depth+1,ref visited); }
        finally { if(Marshal.IsComObject(child)) Marshal.ReleaseComObject(child); }
      }
    }
  }
  public static string[] WindowNames(long handle,uint expectedPid) {
    IntPtr window=new IntPtr(handle); uint pid;
    GetWindowThreadProcessId(window,out pid);
    if(pid!=expectedPid) throw new Exception("Accessibility HWND ownership changed");
    Guid iid=new Guid("618736E0-3C3D-11CF-810C-00AA00389B71"); IntPtr pointer;
    Marshal.ThrowExceptionForHR(AccessibleObjectFromWindow(window,0xFFFFFFFC,ref iid,out pointer));
    if(pointer==IntPtr.Zero) throw new Exception("Owned native window has no accessibility client");
    object root=Marshal.GetObjectForIUnknown(pointer); Marshal.Release(pointer);
    try { List<string> names=new List<string>(); int visited=0; Walk((TestAccessible)root,names,0,ref visited); return names.ToArray(); }
    finally { Marshal.ReleaseComObject(root); }
  }
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
    if ($owner.Count -ne 1) { throw 'Native window PID identity changed' }
    $result=@([TestOtaObserver]::WindowNames([Convert]::ToInt64($data.hwnd,16),[uint32]$data.owner.pid))
    $again=@(Read-Owned $data.owner.executable | Where-Object { $_.pid -eq $data.owner.pid -and (Test-SameStart $_.start $data.owner.start) })
    if ($again.Count -ne 1) { throw 'Native window identity changed during accessibility read' }
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
        { env, timeout: 20_000, maxBuffer: 4_194_304 }
      );
      pending.child.stdin?.end();
      const result = await pending;
      await writeFile(
        path.join(directory, path.basename(input)),
        JSON.stringify(
          {
            operation,
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
  return {
    watchReadyFile: path.join(root, 'ota-installer-observer.ready'),
    processes: (file: string) => call<WindowsProcess[]>('processes', { file }),
    watchInstaller: (file: string) => call<WindowsProcess[]>('watch-installer', { file }),
    addPendingFirewall: (group: string, name: string, file: string, canonical: string) =>
      call('firewall-add', { group, name, file, canonical }),
    names: (owner: WindowsProcess, hwnd: string) => call<string[]>('names', { owner, hwnd }),
    stop: (owners: WindowsProcess[]) => call<never[]>('stop', { owners }),
  };
}
