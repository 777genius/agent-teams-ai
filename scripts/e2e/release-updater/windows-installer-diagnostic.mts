import assert from 'node:assert/strict';
import path from 'node:path';
import type { WindowsProcess } from './windows-native.mts';

export function assertInstallerDiagnostic(env: NodeJS.ProcessEnv, arch: string, mode: string) {
  assert.equal(env.GITHUB_ACTIONS, 'true');
  assert.equal(env.GITHUB_REPOSITORY, '777genius/agent-teams-ai');
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(env.GITHUB_JOB, 'windows-ota');
  assert.equal(arch, 'arm64');
  assert.equal(mode, 'warm');
}

export function diagnosticRequested(
  args: string[],
  env: NodeJS.ProcessEnv,
  arch: string,
  mode: string
) {
  const requested = args.includes('--installer-diagnostic');
  if (requested) assertInstallerDiagnostic(env, arch, mode);
  return requested;
}
export function assertDiagnosticInput(requested: boolean, inputDigest: string) {
  if (requested)
    assert.equal(inputDigest, '66dae8c8ce3ebd607408d19c29ba7c01041d1e72a0406de5e57ba7e677cf0839');
}
export async function captureInstallerDiagnostic(values: {
  root: string;
  environment: NodeJS.ProcessEnv | undefined;
  parent: WindowsProcess;
  owner: () => WindowsProcess | undefined;
  snapshot: (owner: WindowsProcess) => Promise<InstallerDiagnosticSnapshot>;
  save: (receipt: unknown) => Promise<void>;
}) {
  assert(values.environment?.SystemRoot);
  const systemRoot = values.environment.SystemRoot;
  const snapshots: unknown[] = [];
  const receipt = {
    qualifying: false,
    snapshots,
    childEnvironment: 'unknown',
    parentEnvironmentProvenance:
      'Harness app launch environment; actual NSIS/PS5 child environment not read',
    parentEnvironment: Object.fromEntries(
      [
        'SystemRoot',
        'WINDIR',
        'SystemDrive',
        'PATH',
        'HOME',
        'USERPROFILE',
        'APPDATA',
        'LOCALAPPDATA',
        'TEMP',
        'TMP',
        'ComSpec',
        'ProgramFiles',
        'PSModulePath',
        'PATHEXT',
      ].map((key) => [key, values.environment?.[key] ?? null])
    ),
  };
  for (const delay of [30_000, 150_000, 420_000]) {
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
    const owner = values.owner();
    try {
      assert(owner, 'No owned pending installer observed');
      assert.equal(owner.parent, values.parent.pid);
      assert(new Date(owner.start).getTime() >= new Date(values.parent.start).getTime());
      for (const flag of [/\s--updated(?:\s|$)/u, /\s\/S(?:\s|$)/u, /\s--force-run(?:\s|$)/u])
        assert(flag.test(owner.command));
      const snapshot = await values.snapshot(owner);
      snapshot.descendants = snapshot.descendants.map((child) => ({
        ...child,
        producerFormat: child.format,
        ...installerCommand(child.executable, child.command, systemRoot, values.root),
      }));
      snapshots.push(snapshot);
    } catch (error) {
      snapshots.push({ error: String(error), owner, qualifying: false });
    }
    await values.save(receipt);
  }
  return receipt;
}

export function installerCommandRules(root: string) {
  assert(path.win32.basename(root).startsWith('TEST-updater-windows-'));
  const install = path.win32.join(root, 'install');
  const selection = `Get-CimInstance -ClassName Win32_Process | ? {$_.Path -and $_.Path.StartsWith('${install}', 'CurrentCultureIgnoreCase')}`;
  return [
    {
      stage: 'IS_POWERSHELL_AVAILABLE/Get-Command',
      body: '-C "if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"',
    },
    {
      stage: 'IS_POWERSHELL_AVAILABLE/Get-ExecutionPolicy',
      body: '-C "if ((Get-ExecutionPolicy -Scope Process) -eq \'Restricted\') { exit 1 } else { exit 0 }"',
    },
    {
      stage: 'FIND_PROCESS',
      body: `-C "if ((${selection}).Count -gt 0) { exit 0 } else { exit 1 }"`,
    },
    ...['', '-Force'].map((force) => ({
      stage: 'KILL_PROCESS',
      body: `-C "${selection} | % { Stop-Process -Id $_.ProcessId ${force} }"`,
    })),
  ];
}

export function installerCommand(
  executable: string,
  command: string,
  systemRoot: string,
  root: string
) {
  assert(path.win32.isAbsolute(root));
  const paths = ['System32', 'SysWOW64'].map((directory) =>
    path.win32
      .join(systemRoot, directory, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      .toLowerCase()
  );
  const ps = paths.includes(executable.toLowerCase());
  const prefix = /^(?:"([^"\r\n]+)"|([^"\s]+))[ \t]+(-[^\r\n]*)(?![\s\S])/u.exec(command);
  const token = prefix?.[1] ?? prefix?.[2] ?? '';
  const commandBody = prefix?.[3]?.replace(/^-NoProfile -NonInteractive /u, '') ?? '';
  const knownExecutableToken = paths.includes(token.toLowerCase());
  const rule = installerCommandRules(root).find((item) => item.body === commandBody);
  const stage = ps && knownExecutableToken && rule ? rule.stage : 'unrecognized-redacted';
  const architecture = ps ? 'native' : 'unknown';
  return {
    stage,
    format: {
      quotedExecutableToken: Boolean(prefix?.[1]),
      knownExecutableToken,
      matchesActualImage: token.toLowerCase() === executable.toLowerCase(),
      approvedBody: Boolean(rule),
    },
    command: stage === 'unrecognized-redacted' ? '[redacted]' : command,
    architecture: /\\SysWOW64\\/iu.test(executable) && ps ? 'x86' : architecture,
    executable,
    stopEligible: false as const,
  };
}

export interface InstallerDiagnosticSnapshot {
  qualifying: false;
  descendants: {
    executable: string;
    command: string;
    machine: number | null;
    format?: ReturnType<typeof installerCommand>['format'];
    pid: number;
    parent: number;
    start: string;
    sid: string;
    session: number;
    stopEligible: false;
  }[];
  registry: unknown[];
  files: unknown[];
}

// Runs only inside the selected PS7 observer; all process observations are read-only.
export const installerDiagnosticScript = String.raw`
function Read-InstallerDiagnostic {
  $identityError=$null; $roots=@(); $parents=@(); $nodes=@()
  try {
    $roots=@(Read-Owned $data.file | Where-Object { $_.pid -eq $data.owner.pid -and (Test-SameStart $_.start $data.owner.start) })
    if ($roots.Count -ne 1 -or $roots[0].sid -ne $data.owner.sid -or $roots[0].session -ne $data.owner.session) { throw 'Diagnostic pending installer identity unavailable' }
    $parents=@($roots[0])
  } catch { $identityError=$_.Exception.Message }
  $all=if($parents.Count){@(Get-CimInstance Win32_Process)}else{@()}
  for($depth=0; $depth -lt 3 -and $parents.Count; $depth++) {
    $next=@()
    foreach($parent in $parents) {
      foreach($child in @($all | Where-Object { $_.ParentProcessId -eq $parent.pid })) {
        if($nodes.Count -ge 16) { throw 'Diagnostic descendant bound exceeded' }
        $sid=Invoke-CimMethod -InputObject $child -MethodName GetOwnerSid
        if($sid.ReturnValue -ne 0 -or $sid.Sid -ne $roots[0].sid -or $child.SessionId -ne $roots[0].session -or $child.CreationDate.ToUniversalTime() -lt [DateTime]$parent.start) { throw 'Diagnostic descendant identity unavailable' }
        $command='[redacted]'
        $ps=@([IO.Path]::Combine($env:SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),[IO.Path]::Combine($env:SystemRoot,'SysWOW64','WindowsPowerShell','v1.0','powershell.exe'))
        $parsed=[regex]::Match([string]$child.CommandLine,'^(?:"([^"\r\n]+)"|([^"\s]+))[ \t]+(-[^\r\n]*)(?![\s\S])')
        $token=if($parsed.Groups[1].Success){$parsed.Groups[1].Value}else{$parsed.Groups[2].Value}
        $body=$parsed.Groups[3].Value -creplace '^-NoProfile -NonInteractive ',''
        $knownToken=@($ps | Where-Object { [string]::Equals($_,$token,[StringComparison]::OrdinalIgnoreCase) }).Count -eq 1
        $knownImage=@($ps | Where-Object { [string]::Equals($_,$child.ExecutablePath,[StringComparison]::OrdinalIgnoreCase) }).Count -eq 1
        $approvedBody=@($data.commands | Where-Object { $_.body -ceq $body }).Count -eq 1
        $format=@{quotedExecutableToken=$parsed.Groups[1].Success;knownExecutableToken=$knownToken;matchesActualImage=[string]::Equals($token,$child.ExecutablePath,[StringComparison]::OrdinalIgnoreCase);approvedBody=$approvedBody}
        if($knownImage -and $knownToken -and $approvedBody) { $command=$child.CommandLine }
        $machine=$null
        if($ps -contains $child.ExecutablePath) {
          $bytes=[IO.File]::ReadAllBytes($child.ExecutablePath); $offset=[BitConverter]::ToInt32($bytes,60)
          if($offset -lt 64 -or $offset+6 -gt $bytes.Length -or [BitConverter]::ToUInt32($bytes,$offset) -ne 17744) { throw 'Diagnostic PE header invalid' }
          $machine=[BitConverter]::ToUInt16($bytes,$offset+4)
        }
        $node=@{format=$format;machine=$machine;pid=[int]$child.ProcessId;parent=[int]$child.ParentProcessId;start=$child.CreationDate.ToUniversalTime().ToString('o');sid=$sid.Sid;session=[int]$child.SessionId;executable=$child.ExecutablePath;command=$command;stopEligible=$false}
        $nodes+=,$node; $next+=,$node
      }
    }
    $parents=$next
  }
  $registry=@()
  foreach($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryHive]::LocalMachine)) {
    foreach($view in @([Microsoft.Win32.RegistryView]::Registry32,[Microsoft.Win32.RegistryView]::Registry64)) {
      $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view)
      try {
        foreach($subkey in @('Software\dba9559a-8e73-5eee-b6e5-a4142f9e2702','Software\Microsoft\Windows\CurrentVersion\Uninstall\dba9559a-8e73-5eee-b6e5-a4142f9e2702')) {
          $key=$base.OpenSubKey($subkey)
          try { $registry+=@{hive=$hive.ToString();view=$view.ToString();key=$subkey;exists=($null -ne $key);InstallLocation=if($key){$key.GetValue('InstallLocation')}else{$null};DisplayVersion=if($key){$key.GetValue('DisplayVersion')}else{$null};UninstallString=if($key){$key.GetValue('UninstallString')}else{$null}} } finally {if($key){$key.Dispose()}}
        }
      } finally {$base.Dispose()}
    }
  }
  $files=@()
  foreach($relative in @('install\AgentTeamsAI.exe','install\Uninstall AgentTeamsAI.exe','install\resources\app.asar')) {
    $file=[IO.Path]::Combine($data.root,$relative); $exists=[IO.File]::Exists($file)
    $item=@{file=$file;exists=$exists;version=$null;productVersion=$null;size=$null;error=$null}
    try { if($exists){$version=[Diagnostics.FileVersionInfo]::GetVersionInfo($file); $item.version=$version.FileVersion; $item.productVersion=$version.ProductVersion; $item.size=(Get-Item -LiteralPath $file).Length} } catch {$item.error=$_.Exception.Message}
    $files+=,$item
  }
  $after=@(); try { $after=@(Read-Owned $data.file | Where-Object { $_.pid -eq $data.owner.pid -and (Test-SameStart $_.start $data.owner.start) }) } catch { $identityError=$_.Exception.Message }
  return @{qualifying=$false;at=[DateTime]::UtcNow.ToString('o');root=$data.owner;rootObserved=($roots.Count -eq 1);rootAliveAfter=($after.Count -eq 1);identityError=$identityError;descendants=$nodes;registry=$registry;files=$files;childEnvironment='unknown; not read'}
}
`;
