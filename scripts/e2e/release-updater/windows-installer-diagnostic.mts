import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, realpath, writeFile } from 'node:fs/promises';
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
const sourceSha = '395572f9ff2a261cb28224754883a39d2c3c8827';
const pin = {
  id: 595803042,
  name: 'Agent.Teams.AI.Setup.2.17.1-arm64.exe',
  size: 196906862,
  sha256: 'd7bbfe282cba0467f389b24ca3f0cc0404efbbd21c0ce0d09a0e0080c9abfc43',
};
const publicUrl = `https://github.com/${repository}/releases/download/v2.17.1/${pin.name}`;
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
    browser_download_url: string;
  }[];
}
export function checkSource(
  release: SourceRelease,
  tag: { ref: string; object: { type: string; sha: string } }
) {
  assert.equal(release.id, 398386033);
  assert.equal(release.tag_name, 'v2.17.1');
  assert.equal(release.target_commitish, sourceSha);
  assert.equal(release.draft, false);
  assert.equal(release.prerelease, false);
  assert.deepEqual(tag, { ref: 'refs/tags/v2.17.1', object: { type: 'commit', sha: sourceSha } });
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
      browser_download_url: asset.browser_download_url,
    },
    {
      id: pin.id,
      name: pin.name,
      size: pin.size,
      digest: `sha256:${pin.sha256}`,
      browser_download_url: publicUrl,
    }
  );
  return { releaseId: release.id, sourceSha, tag: release.tag_name, ...pin, publicUrl };
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
function Elapsed { return ([DateTimeOffset]::UtcNow-$started).TotalSeconds }
$first=Get-CimInstance Win32_Process -Filter ('ProcessId='+$d.pid)
if ($first -and $first.ExecutablePath -ieq $d.installer) { $o=Read-Owner $first; if ($o -and [DateTimeOffset]::Parse($o.start) -ge $started) { $known[$o.pid]=$o } }
function Save-Owners { [IO.File]::WriteAllText($d.owners+'.tmp',(ConvertTo-Json -InputObject @($known.Values) -Depth 8 -Compress)); [IO.File]::Move($d.owners+'.tmp',$d.owners,$true) }
Save-Owners
while ((Elapsed) -lt 190) {
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
  Save-Owners
  if ($next -lt 3 -and (Elapsed) -ge $samples[$next]) {
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
`;

async function sourceGuard() {
  async function api(route: string) {
    return JSON.parse(
      (
        await execute('gh', ['api', `repos/${repository}/${route}`], {
          timeout: 30_000,
          maxBuffer: 1_048_576,
        })
      ).stdout
    ) as unknown;
  }
  const release = (await api('releases/398386033')) as SourceRelease;
  const ref = (await api('git/ref/tags/v2.17.1')) as {
    ref: string;
    object: { type: string; sha: string };
  };
  return checkSource(release, {
    ref: ref.ref,
    object: { type: ref.object.type, sha: ref.object.sha },
  });
}

async function download(priorInstaller: string) {
  const response = await fetch(publicUrl, { signal: AbortSignal.timeout(120_000) });
  assert(response.ok && response.body);
  const file = await open(priorInstaller, 'wx');
  let size = 0;
  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      assert(size <= pin.size);
      await file.writeFile(value);
    }
  } finally {
    await file.close();
  }
  const actual = await hashFile(priorInstaller);
  assert.equal(actual.size, pin.size);
  assert.equal(actual.sha256, pin.sha256);
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
    scope: 'DIAGNOSTIC ONLY: old 2.17.1 ARM NSIS observer',
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
      signal: AbortSignal.timeout(180_000),
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
      timeoutMs: 180_000,
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
      { env: observerEnv, timeout: 200_000, maxBuffer: 65_536 }
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
