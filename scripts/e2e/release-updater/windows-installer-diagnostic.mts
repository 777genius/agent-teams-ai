import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { hashFile } from './inputs.mts';
import { windowsNative } from './windows-native.mts';
import {
  appEnvironment,
  absent,
  ownPhysicalProfile,
  releasePhysicalProfile,
} from './windows-ota-profile.mts';
import {
  inheritedWindowsEnvironment,
  selectedWindowsPowerShell,
  windowsShellTestEnvironment,
} from './windows-powershell.mts';

import type { WindowsProcess } from './windows-native.mts';
import type { ProfileOwnership } from './windows-ota-profile.mts';

const execute = promisify(execFile);
const repository = '777genius/agent-teams-ai';
const sourceSha = '36c48514bce010d50d5b74660d2c2ab5a00d233b';
const sourceTagSha = '27fcfeeb10b9ab0fc781a7bdcf65fd70aa631c5c';
const pin = {
  id: 616289950,
  name: 'Agent.Teams.AI.Setup.2.17.5-arm64.exe',
  size: 218412277,
  sha256: '8df843439e8120612804d8ee00667af546c9b7839c2b080083a30e2874e1ebfb',
};
const assetRoute = `repos/${repository}/releases/assets/${pin.id}`;
const assetApiUrl = `https://api.github.com/${assetRoute}`;
interface SourceRelease {
  id: number;
  tag_name: string;
  target_commitish: string;
  draft: boolean;
  prerelease: boolean;
  assets: {
    id: number;
    name: string;
    size: number;
    digest: string;
    state: string;
    url: string;
  }[];
}
export function checkSource(
  release: SourceRelease,
  tag: { ref: string; object: { type: string; sha: string } },
  annotated: { tag: string; object: { type: string; sha: string } }
) {
  assert.equal(release.id, 404985707);
  assert.equal(release.tag_name, 'v2.17.5');
  assert.equal(release.target_commitish, sourceSha);
  assert.equal(release.draft, true);
  assert.equal(release.prerelease, false);
  assert.deepEqual(tag, { ref: 'refs/tags/v2.17.5', object: { type: 'tag', sha: sourceTagSha } });
  assert.deepEqual(annotated, { tag: 'v2.17.5', object: { type: 'commit', sha: sourceSha } });
  const assets = release.assets.filter((asset) => asset.name === pin.name);
  assert.equal(assets.length, 1);
  const asset = assets[0];
  assert(asset);
  assert.deepEqual(
    {
      id: asset.id,
      name: asset.name,
      size: asset.size,
      digest: asset.digest,
      state: asset.state,
      url: asset.url,
    },
    {
      id: pin.id,
      name: pin.name,
      size: pin.size,
      digest: `sha256:${pin.sha256}`,
      state: 'uploaded',
      url: assetApiUrl,
    }
  );
  return {
    releaseId: release.id,
    sourceSha,
    tagObjectSha: sourceTagSha,
    tag: release.tag_name,
    draft: true,
    ...pin,
    assetApiUrl,
  };
}
export function checkOwner(
  root: string,
  owner: WindowsProcess,
  session: { sid: string; session: number },
  expected?: WindowsProcess
) {
  const relative = path.win32.relative(root, owner.executable);
  assert(
    relative && !relative.startsWith('..') && !path.win32.isAbsolute(relative),
    'Foreign executable'
  );
  assert(Number.isSafeInteger(owner.pid) && owner.pid > 0);
  assert.equal(owner.sid, session.sid);
  assert.equal(owner.session, session.session);
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/u.test(owner.start));
  if (expected) assert.deepEqual(owner, expected, 'PID identity changed');
}

export function checkTree(
  root: string,
  owners: WindowsProcess[],
  session: { sid: string; session: number },
  installerPid: number,
  installer: string
) {
  assert(owners.length > 0 && owners.length <= 32, 'Installer identity was not observed');
  const byPid = new Map(owners.map((owner) => [owner.pid, owner]));
  assert.equal(byPid.size, owners.length, 'Duplicate/reused PID');
  const first = byPid.get(installerPid);
  assert(first);
  assert.equal(first.executable.toLowerCase(), installer.toLowerCase());
  for (const owner of owners) {
    checkOwner(root, owner, session);
    const visited = new Set<number>();
    let current = owner;
    while (current.pid !== installerPid) {
      assert(!visited.has(current.pid), 'Cyclic parent chain');
      visited.add(current.pid);
      const parent = byPid.get(current.parent);
      assert(parent, 'Foreign parent chain');
      assert(current.start >= parent.start, 'Child predates parent');
      current = parent;
    }
  }
  return first;
}

interface SystemPowerShellOwner extends WindowsProcess {
  parentBefore: WindowsProcess;
  parentAfter: WindowsProcess;
  parentNativeStart: string;
  parentNativeStartAfter: string;
  sha256: string;
  size: number;
  peMachine: number;
  signature: string;
  microsoftSigner: boolean;
  handleVerified: boolean;
  alive: boolean;
}
interface SystemPowerShellReport {
  finished: boolean;
  owners: SystemPowerShellOwner[];
  rejected: number;
  rejectedReasons: string[];
  limitReached: boolean;
  documents: string;
  profileMetadataStatus: 'not-requested' | 'available' | 'unavailable';
  documentsHResult: string | null;
  profiles: { path: string; exists: boolean; size: number | null; reparse: boolean }[];
}
export function checkSystemPowerShellReport(
  root: string,
  roots: WindowsProcess[],
  report: SystemPowerShellReport,
  session: { sid: string; session: number },
  systemRoot: string
) {
  assert.equal(report.finished, true);
  assert.equal(typeof report.limitReached, 'boolean');
  assert(report.owners.length <= 8 && report.profiles.length <= 4);
  assert(Number.isSafeInteger(report.rejected) && report.rejected >= 0 && report.rejected <= 8);
  const allowed = ['System32', 'SysWOW64'].map((dir) =>
    path.win32.join(systemRoot, dir, 'WindowsPowerShell', 'v1.0', 'powershell.exe').toLowerCase()
  );
  const byPid = new Map([...roots, ...report.owners].map((owner) => [owner.pid, owner]));
  assert.equal(byPid.size, roots.length + report.owners.length, 'Duplicate/reused system PID');
  const parentTimeMatches = (parent: WindowsProcess, nativeStart: string) =>
    (roots.includes(parent) ? nativeStart.replace(/\dZ$/u, '0Z') : nativeStart) === parent.start;
  for (const owner of report.owners) {
    assert(Number.isSafeInteger(owner.pid) && owner.pid > 0);
    assert.equal(typeof owner.alive, 'boolean');
    assert(allowed.includes(owner.executable.toLowerCase()), 'Unexpected system PowerShell path');
    assert.equal(owner.command, '');
    assert.equal(owner.sid, session.sid);
    assert.equal(owner.session, session.session);
    assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/u.test(owner.start));
    assert.equal(owner.signature, 'Valid');
    assert.equal(owner.microsoftSigner, true);
    assert.equal(owner.handleVerified, true);
    assert(/^[a-f\d]{64}$/u.test(owner.sha256) && owner.size > 0);
    assert(
      Number.isSafeInteger(owner.peMachine) && owner.peMachine > 0 && owner.peMachine <= 65535
    );
    const parent = byPid.get(owner.parent);
    assert(parent, 'Missing registered parent');
    assert.deepEqual(owner.parentBefore, owner.parentAfter, 'Parent changed during validation');
    for (const key of [
      'pid',
      'parent',
      'executable',
      'command',
      'start',
      'sid',
      'session',
    ] as const)
      assert.equal(owner.parentBefore[key], parent[key]);
    assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/u.test(owner.parentNativeStart));
    assert.equal(owner.parentNativeStart, owner.parentNativeStartAfter, 'Parent handle changed');
    assert(parentTimeMatches(parent, owner.parentNativeStart), 'Parent handle creation mismatch');
    assert(owner.start >= owner.parentNativeStart, 'System child predates native parent');
    const seen = new Set([owner.pid]);
    let ancestor = parent;
    while (!roots.includes(ancestor)) {
      assert(!seen.has(ancestor.pid), 'System ancestry cycle');
      seen.add(ancestor.pid);
      const next = byPid.get(ancestor.parent);
      assert(next, 'Missing system intermediary');
      ancestor = next;
    }
    checkOwner(root, ancestor, session);
  }
  assert(['not-requested', 'available', 'unavailable'].includes(report.profileMetadataStatus));
  const withoutMetadata = () => {
    assert(report.documentsHResult === null || /^0x[a-f\d]{8}$/u.test(report.documentsHResult));
    assert.equal(report.documents, '');
    assert.deepEqual(report.profiles, []);
    if (report.profileMetadataStatus === 'not-requested') assert.equal(report.owners.length, 0);
    return (
      report.profileMetadataStatus === 'unavailable' || report.rejected > 0 || report.limitReached
    );
  };
  if (report.profileMetadataStatus !== 'available') return withoutMetadata();
  assert.equal(report.documentsHResult, '0x00000000');
  const profileHomes = report.owners.map((owner) => path.win32.dirname(owner.executable));
  assert.equal(path.win32.isAbsolute(report.documents), true);
  assert.equal(path.win32.normalize(report.documents), report.documents);
  const profilePaths = [
    ...profileHomes,
    path.win32.join(report.documents, 'WindowsPowerShell'),
  ].flatMap((home) =>
    ['profile.ps1', 'Microsoft.PowerShell_profile.ps1'].map((name) =>
      path.win32.join(home, name).toLowerCase()
    )
  );
  assert.equal(
    new Set(report.profiles.map((item) => item.path.toLowerCase())).size,
    report.profiles.length
  );
  for (const item of report.profiles) {
    assert(profilePaths.includes(item.path.toLowerCase()), 'Unexpected profile inventory path');
    assert.equal(item.reparse, false, 'Profile reparse point');
    assert.equal(typeof item.exists, 'boolean');
    assert(item.exists ? Number.isSafeInteger(item.size) && item.size! >= 0 : item.size === null);
  }
  return report.owners.some((owner) => owner.alive) || report.rejected > 0 || report.limitReached;
}

// Queries are filtered by a recorded PID or its parent ID. Unrelated processes,
// windows, screenshots, command lines and inherited environment are never emitted.
const observer = String.raw`
param([string]$InputFile)
$ErrorActionPreference='Stop'
$d=Get-Content -LiteralPath $InputFile -Raw | ConvertFrom-Json
if ($PSHOME -ne $d.psHome -or [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName -ne $d.shell) { throw 'Selected shell changed' }
$root=[IO.Path]::GetFullPath($d.root)
if ((Split-Path -Leaf $root) -notlike 'TEST-updater-windows-*' -or [IO.Path]::GetDirectoryName($InputFile) -ne $root) { throw 'Foreign observer root' }
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class InstallerWindows {
  delegate bool Callback(IntPtr hwnd,IntPtr value);
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback cb,IntPtr value);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr hwnd,Callback cb,IntPtr value);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr hwnd,uint msg,IntPtr length,StringBuilder text,uint flags,uint timeout,out IntPtr result);
  public static bool? Responsive(uint pid) {
    bool? answer=null;
    EnumWindows((h,v)=>{ uint p; GetWindowThreadProcessId(h,out p); if(p==pid && IsWindowVisible(h)) { IntPtr r; answer=SendMessageTimeout(h,0,IntPtr.Zero,new StringBuilder(1),2,100,out r)!=IntPtr.Zero; return false; } return true; },IntPtr.Zero);
    return answer;
  }
  public static string[] Text(uint pid) {
    var rows=new List<string>();
    Callback read=(h,v)=>{ uint p; GetWindowThreadProcessId(h,out p); if(p==pid && rows.Count<16) { var b=new StringBuilder(512); IntPtr result; SendMessageTimeout(h,13,new IntPtr(512),b,2,50,out result); GetWindowThreadProcessId(h,out p); if(p==pid) rows.Add(h.ToInt64().ToString("x")+" "+b.ToString()); } return rows.Count<16; };
    EnumWindows((h,v)=>{ uint p; GetWindowThreadProcessId(h,out p); if(p==pid && IsWindowVisible(h)) { read(h,v); EnumChildWindows(h,read,IntPtr.Zero); } return rows.Count<16; },IntPtr.Zero);
    return rows.ToArray();
  }
}
public sealed class InstallerProcessHandle : IDisposable {
  IntPtr handle;
  public int Pid { get; private set; }
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr h,out long creation,out long exit,out long kernel,out long user);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr h,uint flags,StringBuilder image,ref int size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h,uint milliseconds);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr h,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,out int session,int size,out int returned);
  [DllImport("shell32.dll")] static extern int SHGetKnownFolderPath(ref Guid id,uint flags,IntPtr token,out IntPtr value);
  public InstallerProcessHandle(int pid) { Pid=pid; handle=OpenProcess(0x101000,false,pid); if(handle==IntPtr.Zero) throw new System.ComponentModel.Win32Exception(); }
  public bool Alive { get { uint result=WaitForSingleObject(handle,0); if(result!=0 && result!=258) throw new System.ComponentModel.Win32Exception(); return result==258; } }
  public string[] Identity() {
    long creation,exit,kernel,user; int size=32768; var image=new StringBuilder(size); IntPtr token;
    if(!GetProcessTimes(handle,out creation,out exit,out kernel,out user) || !QueryFullProcessImageName(handle,0,image,ref size) || !OpenProcessToken(handle,8,out token)) throw new System.ComponentModel.Win32Exception();
    try { int session,returned; if(!GetTokenInformation(token,12,out session,4,out returned)) throw new System.ComponentModel.Win32Exception();
      using(var identity=new System.Security.Principal.WindowsIdentity(token)) return new[]{DateTime.FromFileTimeUtc(creation).ToString("o"),image.ToString(),identity.User.Value,session.ToString(System.Globalization.CultureInfo.InvariantCulture)};
    } finally { CloseHandle(token); }
  }
  public static bool CimCreation(string native,string cim) { return native.Substring(0,native.Length-2)+"0Z"==cim; }
  public bool Matches(string start,string image,string sid,int session,bool cimPrecision) { var now=Identity(); return (cimPrecision ? CimCreation(now[0],start) : now[0]==start) && String.Equals(now[1],image,StringComparison.OrdinalIgnoreCase) && now[2]==sid && now[3]==session.ToString(System.Globalization.CultureInfo.InvariantCulture); }
  public static string[] Documents() {
    var id=new Guid("FDD39AD0-238F-46AF-ADB4-6C85480369C7"); IntPtr value;
    int result=SHGetKnownFolderPath(ref id,0,IntPtr.Zero,out value);
    try { return new[]{"0x"+result.ToString("x8",System.Globalization.CultureInfo.InvariantCulture),result==0 ? Marshal.PtrToStringUni(value) : ""}; } finally { if(value!=IntPtr.Zero) Marshal.FreeCoTaskMem(value); }
  }
  public void Dispose() { if(handle!=IntPtr.Zero) { CloseHandle(handle); handle=IntPtr.Zero; } }
}
'@
function Read-Owner($p) {
  if (-not $p.ExecutablePath) { return $null }
  $file=[IO.Path]::GetFullPath($p.ExecutablePath)
  if (-not $file.StartsWith($root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { return $null }
  $sid=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid
  if ($sid.ReturnValue -ne 0 -or $sid.Sid -ne $d.sid -or $p.SessionId -ne $d.session) { return $null }
  return @{ pid=[int]$p.ProcessId; parent=[int]$p.ParentProcessId; executable=$file; command=''; start=$p.CreationDate.ToUniversalTime().ToString('o'); sid=$sid.Sid; session=[int]$p.SessionId }
}
function Current($owner) {
  $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$owner.pid)
  if (-not $p) { return $null }
  $now=Read-Owner $p
  if (-not $now -or $now.start -cne $owner.start -or $now.executable -ine $owner.executable -or $now.parent -ne $owner.parent) { return $null }
  return $now
}
$known=@{}; $started=[DateTimeOffset]::FromUnixTimeMilliseconds([long]$d.startedMs); $next=0; $samples=@(30,90,150)
$system=@{}; $handles=@{}; $rejected=@{}; $limitReached=$false; $profiles=@(); $documents=''; $profileMetadataStatus='not-requested'; $documentsHResult=$null
$allowed=@('System32','SysWOW64' | ForEach-Object { Join-Path $d.systemRoot ($_+'\WindowsPowerShell\v1.0\powershell.exe') })
function Assert-NoReparse([string]$file) {
  if ([IO.Path]::GetFullPath($file) -cne $file) { throw 'Noncanonical path' }
  $p=$file; $count=0
  while ($p) {
    if (++$count -gt 32) { throw 'Path ancestry limit' }
    if ((Test-Path -LiteralPath $p) -and ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Reparse path' }
    $p=[IO.Path]::GetDirectoryName($p)
  }
}
function Same-Handle($h,$owner,[bool]$native=$false) { return $h.Matches($owner.start,$owner.executable,$owner.sid,$owner.session,(-not ($native -or $system.ContainsKey($owner.pid)))) }
function Parent-Now($parent) {
  if ($system.ContainsKey($parent.pid)) { if ($handles[$parent.pid].Alive -and (Same-Handle $handles[$parent.pid] $parent)) { return @{pid=$parent.pid; parent=$parent.parent; executable=$parent.executable; command=''; start=$parent.start; sid=$parent.sid; session=$parent.session} }; return $null }
  return (Current $parent)
}
function Register-System($p,$parent) {
  if ($system.ContainsKey([int]$p.ProcessId)) { if (-not [InstallerProcessHandle]::CimCreation($system[[int]$p.ProcessId].start,$p.CreationDate.ToUniversalTime().ToString('o'))) { $script:limitReached=$true }; return }
  $child=$null; $parentHandle=$null; $reason='parent identity'
  try {
    $before=Parent-Now $parent; if (-not $before) { throw 'Parent unavailable' }
    $parentHandle=[InstallerProcessHandle]::new($parent.pid)
    if (-not $parentHandle.Alive -or -not (Same-Handle $parentHandle $before)) { throw 'Parent handle changed' }
    $parentNativeStart=$parentHandle.Identity()[0]
    $reason='path or limit'; if ($allowed -inotcontains $p.ExecutablePath) { throw 'Non-whitelisted child' }; if ($system.Count -ge 8) { $script:limitReached=$true; throw 'System child limit' }
    $reason='child handle identity'; $child=[InstallerProcessHandle]::new([int]$p.ProcessId); $id=$child.Identity()
    if (-not $child.Alive -or -not [InstallerProcessHandle]::CimCreation($id[0],$p.CreationDate.ToUniversalTime().ToString('o')) -or $id[1] -ine $p.ExecutablePath -or $id[2] -ne $d.sid -or [int]$id[3] -ne $d.session) { throw 'Child handle identity changed' }
    $reason='path or ancestry'; if ($allowed -inotcontains $id[1]) { throw 'Non-whitelisted child' }
    if ([DateTimeOffset]::Parse($id[0]) -lt [DateTimeOffset]::Parse($parentNativeStart)) { throw 'Child predates parent' }
    Assert-NoReparse $id[1]
    $reason='Microsoft signature or image'; $signature=Get-AuthenticodeSignature -LiteralPath $id[1]
    $microsoft=$signature.SignerCertificate.Subject -match '(?:^|,\s*)O=Microsoft Corporation(?:,|$)'
    if ($signature.Status.ToString() -ne 'Valid' -or -not $microsoft) { throw 'Unverified Microsoft signature' }
    $hash=(Get-FileHash -LiteralPath $id[1] -Algorithm SHA256).Hash.ToLowerInvariant(); $size=(Get-Item -LiteralPath $id[1]).Length
    $file=[IO.File]::OpenRead($id[1]); $reader=[IO.BinaryReader]::new($file)
    try { if ($reader.ReadUInt16() -ne 0x5a4d) { throw 'Invalid DOS image' }; $file.Position=60; $pe=$reader.ReadUInt32(); if ($pe -gt $size-6) { throw 'Invalid PE offset' }; $file.Position=$pe; if ($reader.ReadUInt32() -ne 0x4550) { throw 'Invalid PE image' }; $machine=$reader.ReadUInt16() } finally { $reader.Dispose() }
    $after=Parent-Now $parent
    $parentNativeStartAfter=$parentHandle.Identity()[0]; if ($parentNativeStartAfter -cne $parentNativeStart) { throw 'Parent handle creation changed' }
    $reason='parent changed'; if (-not $after -or -not $parentHandle.Alive -or -not (Same-Handle $parentHandle $after)) { throw 'Parent changed during validation' }
    foreach ($key in @('pid','parent','executable','command','start','sid','session')) { if ($before[$key] -cne $after[$key]) { throw 'Parent changed during validation' } }
    $owner=@{pid=[int]$p.ProcessId; parent=[int]$p.ParentProcessId; executable=$id[1]; command=''; start=$id[0]; sid=$id[2]; session=[int]$id[3]; parentBefore=$before; parentAfter=$after; parentNativeStart=$parentNativeStart; parentNativeStartAfter=$parentNativeStartAfter; sha256=$hash; size=$size; peMachine=$machine; signature='Valid'; microsoftSigner=$true; handleVerified=$true; alive=$true}
    if (-not (Same-Handle $child $owner $true) -or -not $child.Alive) { throw 'Child exited during validation' }
    $reason='system child limit'; if ($system.Count -ge 8) { $script:limitReached=$true; throw 'System child limit' }
    $system[$owner.pid]=$owner; $handles[$owner.pid]=$child; $child=$null
    if ($system.Count -eq 1) {
      try {
      $lookup=[InstallerProcessHandle]::Documents(); $script:documentsHResult=$lookup[0]
      if ($documentsHResult -ne '0x00000000') { throw 'Optional Documents unavailable' }
      $script:documents=$lookup[1]; $psHome=[IO.Path]::GetDirectoryName($id[1]); Assert-NoReparse $documents
      $script:profiles=@(foreach ($home in @($psHome,(Join-Path $documents 'WindowsPowerShell'))) { foreach ($name in @('profile.ps1','Microsoft.PowerShell_profile.ps1')) {
        $profile=Join-Path $home $name; Assert-NoReparse $profile; $exists=Test-Path -LiteralPath $profile; $length=$null
        if ($exists) { $item=Get-Item -LiteralPath $profile -Force; if ($item.PSIsContainer) { throw 'Profile is not a file' }; $length=$item.Length }
        @{path=$profile; exists=[bool]$exists; size=$length; reparse=$false}
      } })
      $script:profileMetadataStatus='available'
      } catch { $script:documents=''; $script:profiles=@(); $script:profileMetadataStatus='unavailable' }
    }
  } catch { if ($rejected.Count -lt 8) { $rejected[[int]$p.ProcessId]=$reason } else { $script:limitReached=$true } }
  finally { if ($child) { $child.Dispose() }; if ($parentHandle) { $parentHandle.Dispose() } }
}
function Save-System([bool]$finished,[int]$sample=0) {
  $rows=@(foreach ($owner in @($system.Values | Sort-Object start,pid)) { $alive=$handles[$owner.pid].Alive; if ($alive -and -not (Same-Handle $handles[$owner.pid] $owner)) { throw 'Retained system identity changed' }; $owner.alive=$alive; $owner.lifetimeSeconds=([DateTimeOffset]::UtcNow-[DateTimeOffset]::Parse($owner.start)).TotalSeconds; $owner })
  $json=ConvertTo-Json -InputObject @{finished=$finished; owners=$rows; rejected=$rejected.Count; rejectedReasons=@($rejected.Values | Sort-Object -Unique); limitReached=$limitReached; profiles=$profiles; documents=$documents; profileMetadataStatus=$profileMetadataStatus; documentsHResult=$documentsHResult} -Depth 12
  [IO.File]::WriteAllText((Join-Path $d.evidence 'installer-system-powershell.json'),$json)
  if ($sample) { [IO.File]::WriteAllText((Join-Path $d.evidence ('installer-system-powershell-'+$sample+'.json')),$json) }
}
function Elapsed { return ([DateTimeOffset]::UtcNow-$started).TotalSeconds }
$first=Get-CimInstance Win32_Process -Filter ('ProcessId='+$d.pid)
if ($first -and $first.ExecutablePath -ieq $d.installer) { $o=Read-Owner $first; if ($o -and [DateTimeOffset]::Parse($o.start) -ge $started) { $known[$o.pid]=$o } }
function Save-Owners { [IO.File]::WriteAllText($d.owners+'.tmp',(ConvertTo-Json -InputObject @($known.Values) -Depth 8 -Compress)); [IO.File]::Move($d.owners+'.tmp',$d.owners,$true) }
Save-Owners
try {
while ((Elapsed) -lt 490) {
  foreach ($parent in @($known.Values)) {
    if (-not (Current $parent)) { continue }
    foreach ($p in @(Get-CimInstance Win32_Process -Filter ('ParentProcessId='+$parent.pid))) {
      $o=Read-Owner $p
      if ($o -and [DateTimeOffset]::Parse($o.start) -ge [DateTimeOffset]::Parse($parent.start) -and (Current $parent)) {
        if ($known.ContainsKey($o.pid) -and $known[$o.pid].start -cne $o.start) { throw 'Owned PID reused' }
        if ($known.Count -ge 32 -and -not $known.ContainsKey($o.pid)) { throw 'Owned tree limit exceeded' }
        $known[$o.pid]=$o
      }
    }
  }
  foreach ($parent in (@($known.Values)+@($system.Values))) {
    if (-not (Parent-Now $parent)) { continue }
    foreach ($p in @(Get-CimInstance Win32_Process -Filter ('ParentProcessId='+$parent.pid) -Property ProcessId,ParentProcessId,ExecutablePath,CreationDate,SessionId)) {
      if ($known.ContainsKey([int]$p.ProcessId)) { continue }
      Register-System $p $parent
    }
  }
  Save-Owners
  if ($next -lt 3 -and (Elapsed) -ge $samples[$next]) {
    Save-System $false $samples[$next]
    $rows=@(foreach ($owner in @($known.Values)) {
      $now=Current $owner
      if (-not $now) { @{ owner=$owner; exited=$true }; continue }
      try {
      $p=[Diagnostics.Process]::GetProcessById($owner.pid)
      $text=@([InstallerWindows]::Text($owner.pid)); $wait=@()
      try { $wait=@($p.Threads | Select-Object -First 32 | ForEach-Object { @{ state=$_.ThreadState.ToString(); wait=$(if ($_.ThreadState -eq 'Wait') { $_.WaitReason.ToString() } else { $null }) } }) } catch { $wait=@(@{ error='Owned thread wait unavailable' }) }
      if (Current $owner) { @{ owner=$owner; exited=$p.WaitForExit(0); responding=[InstallerWindows]::Responsive($owner.pid); windows=$text; threads=$wait } }
      } catch { @{ owner=$owner; observationError='Owned process exited during observation' } }
    })
    $files=@(); $directories=[Collections.Generic.Queue[string]]::new(); $directories.Enqueue($d.install); $count=0
    while ($directories.Count -and $count -lt 128) {
      foreach ($f in @(Get-ChildItem -LiteralPath ($directories.Dequeue()) | Select-Object -First (128-$count))) {
        $count++; if ($f.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Install reparse point' }
        if ($f.PSIsContainer) { $directories.Enqueue($f.FullName) } else { $files+=@{ path=$f.FullName.Substring($d.install.Length+1); size=$f.Length } }
      }
    }
    [IO.File]::WriteAllText((Join-Path $d.evidence ('installer-'+$samples[$next]+'.json')),(ConvertTo-Json -InputObject @{ requestedSeconds=$samples[$next]; elapsedSeconds=(Elapsed); processes=$rows; partialInstall=$files; partialInstallTruncated=($count -ge 128) } -Depth 12))
    $next++
  }
  if ([IO.File]::Exists($d.stop)) { break }
  Start-Sleep -Milliseconds 500
}
Save-Owners
} finally {
  try { Save-System $true } finally { foreach ($h in $handles.Values) { $h.Dispose() } }
}
`;

async function sourceGuard() {
  async function api(route: string, paginate = false) {
    return JSON.parse(
      (
        await execute(
          'gh',
          ['api', `repos/${repository}/${route}`, ...(paginate ? ['--paginate', '--slurp'] : [])],
          {
            timeout: 30_000,
            maxBuffer: 1_048_576,
          }
        )
      ).stdout
    ) as unknown;
  }
  const release = (await api('releases/404985707')) as SourceRelease;
  release.assets = (
    (await api('releases/404985707/assets', true)) as SourceRelease['assets'][]
  ).flat();
  const ref = (await api('git/ref/tags/v2.17.5')) as {
    ref: string;
    object: { type: string; sha: string };
  };
  const annotated = (await api(`git/tags/${sourceTagSha}`)) as {
    tag: string;
    object: { type: string; sha: string };
  };
  return checkSource(
    release,
    { ref: ref.ref, object: { type: ref.object.type, sha: ref.object.sha } },
    { tag: annotated.tag, object: { type: annotated.object.type, sha: annotated.object.sha } }
  );
}

async function download(priorInstaller: string) {
  const staging = await mkdtemp(path.join(os.tmpdir(), 'TEST-windows-arm-draft-input-'));
  const transferred = path.join(staging, pin.name);
  try {
    const shell = await selectedWindowsPowerShell();
    const lookupEnv = await windowsShellTestEnvironment(path.dirname(priorInstaller), shell);
    lookupEnv.PATH = inheritedWindowsEnvironment('PATH');
    const command = await execute(
      shell.executable,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(Get-Command gh -CommandType Application -ErrorAction Stop).Source',
      ],
      { env: lookupEnv, timeout: 20_000, maxBuffer: 16_384 }
    );
    const ghExecutable = await realpath(command.stdout.trim());
    assert.equal(
      ghExecutable.toLowerCase(),
      path.join(shell.programFiles, 'GitHub CLI', 'gh.exe').toLowerCase(),
      'Unexpected installed GitHub CLI path'
    );
    const file = await open(transferred, 'wx');
    try {
      const transfer = spawn(
        ghExecutable,
        ['api', assetRoute, '--header', 'Accept: application/octet-stream'],
        {
          stdio: ['ignore', file.fd, 'ignore'],
          signal: AbortSignal.timeout(120_000),
        }
      );
      const code = await new Promise<number | null>((resolve, reject) => {
        transfer.once('error', reject);
        transfer.once('exit', resolve);
      });
      assert.equal(code, 0, 'Authenticated draft asset transfer failed');
    } finally {
      await file.close();
    }
    await copyFile(transferred, priorInstaller, constants.COPYFILE_EXCL);
    const actual = await hashFile(priorInstaller);
    assert.equal(actual.size, pin.size);
    assert.equal(actual.sha256, pin.sha256);
  } finally {
    await rm(transferred, { force: true });
    await rmdir(staging);
  }
}

async function cleanup(
  root: string,
  native: Awaited<ReturnType<typeof windowsNative>>,
  output: string,
  evidence: Record<string, unknown>,
  firewallGroup: string,
  firewallNames: string[],
  profile: ProfileOwnership | undefined,
  pendingObserver: Promise<unknown> | undefined
) {
  const ownersFile = path.join(output, 'installer-owners.json');
  let owners = (await absent(ownersFile))
    ? []
    : (JSON.parse(await readFile(ownersFile, 'utf8')) as WindowsProcess[]);
  const session = evidence.desktopSession as { sid: string; session: number };
  if (owners.length) {
    const installer = evidence.installer as { pid: number };
    evidence.installerIdentity = checkTree(
      root,
      owners,
      session,
      installer.pid,
      path.join(root, 'prior.Setup.exe')
    );
  }
  const previous = new Map(owners.map((owner) => [owner.pid, owner]));
  // Stop parents first while the observer can still retain late descendants.
  await native.stop(owners.toSorted((a, b) => a.start.localeCompare(b.start)));
  await writeFile(path.join(root, 'observer-stop'), 'stop');
  await pendingObserver;
  owners = (await absent(ownersFile))
    ? []
    : (JSON.parse(await readFile(ownersFile, 'utf8')) as WindowsProcess[]);
  if (owners.length) {
    const installer = evidence.installer as { pid: number };
    evidence.installerIdentity = checkTree(
      root,
      owners,
      session,
      installer.pid,
      path.join(root, 'prior.Setup.exe')
    );
  }
  for (const owner of owners) checkOwner(root, owner, session, previous.get(owner.pid));
  await native.stop(owners.toSorted((a, b) => a.start.localeCompare(b.start)));
  const systemReportFile = path.join(output, 'installer-system-powershell.json');
  let unresolved = Boolean(pendingObserver);
  if (!(await absent(systemReportFile))) {
    const report = JSON.parse(await readFile(systemReportFile, 'utf8')) as SystemPowerShellReport;
    const systemRoot = inheritedWindowsEnvironment('SystemRoot');
    assert(systemRoot);
    unresolved = checkSystemPowerShellReport(root, owners, report, session, systemRoot);
    evidence.systemPowerShell = report;
  }
  const failedObservation = () =>
    Boolean(evidence.observerError) || Boolean(evidence.installer && !owners.length);
  unresolved = [unresolved, failedObservation()].some(Boolean);
  for (const file of [
    path.join(root, 'prior.Setup.exe'),
    path.join(root, 'install', 'AgentTeamsAI.exe'),
    ...new Set(owners.map((owner) => owner.executable)),
  ]) {
    await native.stop(await native.processes(file));
    assert.equal(
      (await native.processes(file)).length,
      0,
      'Keep containment while owned process active'
    );
  }
  if (unresolved) {
    evidence.cleanup = 'TEST-root owners stopped; firewall rules and profile links retained';
    evidence.systemPowerShellUnresolved = true;
    evidence.vmTeardownReliedOn = true;
    process.exitCode = 1;
    return;
  }
  if (firewallNames.length)
    assert.deepEqual(await native.removeFirewall(firewallGroup, firewallNames), []);
  if (!profile && !(await absent(path.join(output, 'profile-ownership.json'))))
    profile = JSON.parse(
      await readFile(path.join(output, 'profile-ownership.json'), 'utf8')
    ) as ProfileOwnership;
  if (profile) await releasePhysicalProfile(profile);
  evidence.cleanup =
    'Owned process identities stopped; exact firewall rules and physical profile links released';
  if (evidence.observerError) process.exitCode = 1;
  if (evidence.installer && !owners.length) {
    evidence.observerError = 'Installer identity unavailable';
    process.exitCode = 1;
  }
}

async function run() {
  const output = path.resolve(process.argv[process.argv.indexOf('--evidence') + 1] ?? '');
  assert(process.argv.includes('--evidence') && path.basename(output).startsWith('TEST-'));
  await mkdir(output, { recursive: true });
  const evidence: Record<string, unknown> = {
    scope: 'DIAGNOSTIC ONLY: fresh target 2.17.5 ARM NSIS observer',
    qualifying: false,
    fullOtaProved: false,
    diagnosticHead: process.env.GITHUB_SHA,
    testedSourceSha: sourceSha,
    startedAt: new Date().toISOString(),
  };
  let profile: ProfileOwnership | undefined;
  let root: string | undefined;
  let native: Awaited<ReturnType<typeof windowsNative>> | undefined;
  let firewallGroup = '';
  const firewallNames: string[] = [];
  let pendingObserver: Promise<unknown> | undefined;
  try {
    assert.equal(process.platform, 'win32');
    assert.equal(process.arch, 'arm64');
    assert.equal(process.env.GITHUB_ACTIONS, 'true');
    assert.equal(process.env.GITHUB_REPOSITORY, repository);
    assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch');
    assert(/^[a-f\d]{40}$/u.test(process.env.DIAGNOSTIC_SHA ?? ''));
    assert.equal(
      process.env.GITHUB_SHA,
      process.env.DIAGNOSTIC_SHA,
      'Actual diagnostic head required'
    );
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-updater-windows-')));
    const install = path.join(root, 'install');
    await mkdir(install);
    const priorInstaller = path.join(root, 'prior.Setup.exe');
    const executable = path.join(install, 'AgentTeamsAI.exe');
    native = await windowsNative(root, output);
    const physical = await native.physicalProfile();
    evidence.physicalProfile = physical;
    profile = await ownPhysicalProfile(root, physical, output);
    const session = await native.session();
    evidence.desktopSession = session;
    assert.equal(session.station.toLowerCase(), 'winsta0');
    assert.equal(session.desktop.toLowerCase(), 'default');
    evidence.source = await sourceGuard();
    await download(priorInstaller);
    evidence.signature = await native.signature(priorInstaller);
    firewallGroup = `TEST-updater-windows-${randomUUID()}`;
    for (const [index, program] of [executable, priorInstaller].entries()) {
      const name = `${firewallGroup}-${index}`;
      firewallNames.push(name);
      await native.addFirewall(firewallGroup, name, program);
    }
    const rules = await native.firewall(firewallGroup);
    evidence.firewall = rules;
    assert.equal(rules.length, 2);
    for (const rule of rules) {
      assert(firewallNames.includes(rule.name));
      assert.equal(rule.enabled, 'True');
      assert.equal(rule.action, 'Block');
      assert.equal(rule.direction, 'Outbound');
      assert(
        [executable, priorInstaller].some(
          (program) => program.toLowerCase() === rule.program.toLowerCase()
        )
      );
      assert.equal(rule.remote.length, 3);
    }
    const shell = await selectedWindowsPowerShell();
    const observerEnv = await windowsShellTestEnvironment(root, shell);
    const script = path.join(root, 'installer-observer.ps1');
    await writeFile(script, observer);
    await writeFile(path.join(output, 'installer-observer.ps1'), observer);
    const systemRoot = inheritedWindowsEnvironment('SystemRoot');
    assert(systemRoot);
    const env = appEnvironment(physical, root, systemRoot);
    const log = createWriteStream(path.join(output, 'installer.log'));
    let logError: Error | undefined;
    log.on('error', (error) => {
      logError = error;
    });
    evidence.sourceBeforeLaunch = await sourceGuard();
    const startedAt = new Date().toISOString();
    const setup = spawn(priorInstaller, ['/S', `/D=${install}`], {
      cwd: root,
      env,
      windowsVerbatimArguments: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: AbortSignal.timeout(480_000),
    });
    const completed = new Promise<number | null>((resolve, reject) => {
      setup.once('error', reject);
      setup.once('exit', resolve);
    });
    // Attach the rejection handler immediately: timeout must not become unhandled.
    const outcome = completed.then(
      (code) => ({ code }),
      (error: unknown) => ({ error: String(error) })
    );
    evidence.installer = {
      pid: setup.pid,
      arguments: ['/S', `/D=${install}`],
      spawnedAt: startedAt,
      timeoutMs: 480_000,
      root,
      install,
    };
    assert(setup.pid);
    let logBytes = 0;
    for (const stream of [setup.stdout, setup.stderr])
      stream?.on('data', (chunk: Buffer) => {
        const bytes = chunk.subarray(0, Math.max(0, 262_144 - logBytes));
        logBytes += bytes.length;
        if (bytes.length) log.write(bytes);
      });
    const input = path.join(root, 'installer-observer.json');
    await writeFile(
      input,
      JSON.stringify({
        root,
        install,
        installer: priorInstaller,
        pid: setup.pid,
        startedMs: Date.parse(startedAt),
        sid: session.sid,
        session: session.session,
        shell: shell.executable,
        psHome: shell.psHome,
        systemRoot,
        evidence: output,
        owners: path.join(output, 'installer-owners.json'),
        stop: path.join(root, 'observer-stop'),
      })
    );
    const observed = execute(
      shell.executable,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        '-InputFile',
        input,
      ],
      { env: observerEnv, timeout: 500_000, maxBuffer: 65_536 }
    );
    observed.child.stdin?.end();
    pendingObserver = observed.then(
      (result) => {
        evidence.observer = result;
      },
      (error: unknown) => {
        evidence.observerError = String(error);
      }
    );
    evidence.result = await outcome;
    evidence.installerElapsedMs = Date.now() - Date.parse(startedAt);
    await new Promise<void>((resolve) => log.end(resolve));
    if (logError) throw logError;
    assert(
      !('error' in (evidence.result as object)),
      'Installer failed; nonqualifying diagnostic evidence retained'
    );
    assert.equal(
      (evidence.result as { code: number | null }).code,
      0,
      'Installer returned nonzero status'
    );
    assert(!evidence.observerError, 'Native observer failed');
  } catch (error) {
    evidence.error = String(error);
    process.exitCode = 1;
  } finally {
    try {
      if (root && native)
        await cleanup(
          root,
          native,
          output,
          evidence,
          firewallGroup,
          firewallNames,
          profile,
          pendingObserver
        );
    } catch (error) {
      evidence.cleanupError = String(error);
      process.exitCode = 1;
    }
    await writeFile(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await run();
