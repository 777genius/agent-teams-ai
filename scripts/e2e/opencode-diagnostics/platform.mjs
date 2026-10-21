import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { existsSync } from 'node:fs';
import path from 'node:path';

const windows = process.platform === 'win32';
function powershell(script, timeout = 30000) {
  return execFileSync(
    path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32/WindowsPowerShell/v1.0/powershell.exe'
    ),
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(`$ErrorActionPreference='Stop'; ${script}`, 'utf16le').toString('base64'),
    ],
    { encoding: 'utf8', windowsHide: true, timeout }
  );
}
export function parseWindowsProcesses(output) {
  const parsed = JSON.parse(output.replace(/^\uFEFF/, '').trim() || '[]');
  return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => {
    assert(
      Number.isInteger(p.pid) && Number.isInteger(p.parent) && p.birth,
      'Invalid OS process identity'
    );
    return {
      pid: p.pid,
      parent: p.parent,
      birth: p.birth,
      ...(p.executable ? { executable: p.executable } : {}),
    };
  });
}
export function parseUnixProcesses(output) {
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      assert(m, 'Invalid ps output');
      return { pid: Number(m[1]), parent: Number(m[2]), birth: m[3].trim() };
    });
}
export function processes() {
  if (windows)
    return parseWindowsProcesses(
      powershell(
        "@(Get-CimInstance Win32_Process | Where-Object CreationDate | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; birth=$_.CreationDate.ToUniversalTime().ToString('o'); executable=$_.ExecutablePath} }) | ConvertTo-Json -Compress"
      )
    );
  return parseUnixProcesses(
    execFileSync('ps', ['-eo', 'pid=,ppid=,lstart='], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
    })
  );
}

// Proof-only history. It never authorizes access or signals to any process.
export function mergeProofIdentities(...groups) {
  const result = [];
  for (const group of groups) {
    assert(Array.isArray(group), 'Missing cleanup proof identity history');
    for (const row of group) {
      assert(
        Number.isInteger(row?.pid) && row.pid > 0 && typeof row.birth === 'string' && row.birth,
        'Invalid cleanup proof identity'
      );
      if (!result.some((entry) => entry.pid === row.pid && entry.birth === row.birth))
        result.push({ ...row });
      assert(result.length <= 500, 'Cleanup proof identity bound exceeded');
    }
  }
  return result;
}

export function parseWindowsProcessCensus(output) {
  const value = JSON.parse(output.replace(/^\uFEFF/, '').trim());
  assert(
    value?.schemaVersion === 1 &&
      value.complete === true &&
      Array.isArray(value.processes) &&
      Array.isArray(value.ports) &&
      value.ports.includes(9222) &&
      value.ports.length <= 32 &&
      value.ports.every((port) => Number.isInteger(port) && port > 0 && port <= 65535) &&
      Array.isArray(value.listeners),
    'Incomplete Windows process census'
  );
  assert(value.processes.length <= 65536, 'Windows process census bound exceeded');
  const seen = new Set();
  for (const row of value.processes) {
    assert(
      Number.isInteger(row?.pid) &&
        row.pid >= 0 &&
        !seen.has(row.pid) &&
        Number.isInteger(row.parent) &&
        row.parent >= 0 &&
        (row.birth === null || typeof row.birth === 'string'),
      'Invalid Windows process census row'
    );
    seen.add(row.pid);
  }
  for (const row of value.listeners)
    assert(
      Number.isInteger(row?.pid) && row.pid > 0 && value.ports.includes(row.port),
      'Invalid Windows listener census row'
    );
  return value;
}

// Unlike processes(), this census must retain PIDs whose birth is unreadable.
// A failed CIM enumeration cannot produce the complete envelope below.
export function windowsProcessCensus(ports = [9222], timeoutMs = 30000) {
  assert(windows, 'Windows process census requires Windows');
  assert(
    Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000,
    'Invalid census deadline'
  );
  assert(
    Array.isArray(ports) &&
      ports.includes(9222) &&
      ports.length <= 32 &&
      ports.every((port) => Number.isInteger(port) && port > 0 && port <= 65535),
    'Invalid cleanup proof ports'
  );
  const selectedPorts = [...new Set(ports)].sort((a, b) => a - b);
  const startedAt = Date.now();
  const value = parseWindowsProcessCensus(
    powershell(
      `
    $ports = @(${selectedPorts.join(',')});
    $rows = @(Get-CimInstance Win32_Process | ForEach-Object {
      $birth = $null;
      if ($null -ne $_.CreationDate) {
        try { $birth = $_.CreationDate.ToUniversalTime().ToString('o') } catch { }
      }
      [pscustomobject]@{pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; birth=$birth}
    });
    $tcp = @(Get-NetTCPConnection -State Listen | Where-Object { $ports -contains [int]$_.LocalPort } | ForEach-Object {
      [pscustomobject]@{pid=[int]$_.OwningProcess; port=[int]$_.LocalPort}
    });
    @{schemaVersion=1; complete=$true; processes=$rows; ports=$ports; listeners=$tcp} | ConvertTo-Json -Depth 4 -Compress
  `,
      timeoutMs
    )
  );
  assert.deepEqual(value.ports, selectedPorts, 'Cleanup proof port selection changed');
  return { ...value, startedAt, completedAt: Date.now() };
}

function preciseWindowsBirth(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value.slice(0, 23) + 'Z'
  );
}

// A complete PID census can prove absence. A filtered identity list cannot.
export function windowsProofDrainSnapshot(identities, census) {
  const expected = mergeProofIdentities(identities);
  assert(expected.length > 0, 'Empty cleanup proof identity union');
  parseWindowsProcessCensus(JSON.stringify(census));
  const rows = expected.map((identity) => {
    const current = census.processes.find((row) => row.pid === identity.pid);
    const state = !preciseWindowsBirth(identity.birth)
      ? 'unknown'
      : !current
        ? 'absent'
        : !preciseWindowsBirth(current.birth)
          ? 'unknown'
          : current.birth === identity.birth
            ? 'same-birth-present'
            : 'different-birth';
    return { expected: identity, current: current ?? null, state };
  });
  return {
    drained:
      census.listeners.length === 0 &&
      rows.every((row) => ['absent', 'different-birth'].includes(row.state)),
    rows,
    ports: census.ports,
    listeners: census.listeners,
  };
}
export function sameIdentity(expected, current) {
  assert(
    expected?.birth && current && expected.pid === current.pid && expected.birth === current.birth,
    'Process missing or PID reused; refusing access/signal'
  );
}
export function ownedTree(snapshot, launcher) {
  sameIdentity(
    launcher,
    snapshot.find((p) => p.pid === launcher.pid)
  );
  const owned = [launcher];
  for (let i = 0; i < owned.length; i++) {
    for (const p of snapshot)
      if (p.parent === owned[i].pid && !owned.some((o) => o.pid === p.pid)) {
        const parentBirth = Date.parse(owned[i].birth);
        const childBirth = Date.parse(p.birth);
        assert(Number.isFinite(parentBirth) && Number.isFinite(childBirth), 'Invalid birth time');
        const iso =
          /^\d{4}-\d{2}-\d{2}T/.test(p.birth) && /^\d{4}-\d{2}-\d{2}T/.test(owned[i].birth);
        if (iso ? p.birth >= owned[i].birth : childBirth >= parentBirth) owned.push(p);
      }
  }
  return owned;
}
export function parseListeners(output) {
  const ids = output.trim() ? output.trim().split(/\s+/).map(Number) : [];
  assert(
    ids.every((pid) => Number.isInteger(pid) && pid > 0),
    'Invalid listener PID'
  );
  return [...new Set(ids)];
}
export function listeners() {
  if (windows)
    return parseListeners(
      powershell(
        'Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq 9222 | Select-Object -ExpandProperty OwningProcess'
      )
    );
  try {
    return parseListeners(
      execFileSync('lsof', ['-nP', '-t', '-iTCP:9222', '-sTCP:LISTEN'], { encoding: 'utf8' })
    );
  } catch (e) {
    if (e.status === 1 && !String(e.stdout).trim() && !String(e.stderr).trim()) return [];
    throw e;
  }
}
export function assertListenerOwnership(ids, owned) {
  assert(
    ids.length && ids.every((pid) => owned.some((p) => p.pid === pid && p.pid !== owned[0].pid)),
    'CDP listener is not a launcher descendant; refusing access'
  );
}
export async function assertPortAvailable() {
  assert.equal(listeners().length, 0, 'Port 9222 already has a listener');
  for (const host of ['127.0.0.1', '::1']) {
    await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', (error) => {
        if (host === '::1' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) resolve();
        else reject(error);
      });
      server.listen({ port: 9222, host, exclusive: true }, () => server.close(resolve));
    });
  }
}
// Deliberately reject cmd expansion syntax instead of attempting arbitrary shell escaping.
export function quoteCmdPath(value) {
  assert(!/["%!?^\r\n]/.test(value), 'Unsupported cmd path characters');
  return `"${value}"`;
}
export function fixtureShim(node, script, role, platform = process.platform) {
  assert(['opencode', 'orchestrator'].includes(role));
  if (platform === 'win32')
    return `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${quoteCmdPath(node)} ${quoteCmdPath(script)} ${role} %*\r\nexit /b %errorlevel%\r\n`;
  const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
  return `#!/bin/sh\nexec ${quote(node)} ${quote(script)} ${role} "$@"\n`;
}
export function launchCommand(platform = process.platform) {
  return platform === 'win32'
    ? {
        command: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
        args: ['/d', '/s', '/c', 'pnpm dev:mcp --noSandbox'],
      }
    : { command: 'pnpm', args: ['dev:mcp', '--noSandbox'] };
}
export function isolatedEnvironment(data, inherited = process.env) {
  const env = {};
  // OS/build/display plumbing only; never forward provider keys or configuration overrides.
  const allowed = new Set([
    'path',
    'systemroot',
    'windir',
    'comspec',
    'pathext',
    // PowerShell CIM module discovery requires Windows installation plumbing.
    'programfiles',
    'programfiles(x86)',
    'programw6432',
    'commonprogramfiles',
    'commonprogramfiles(x86)',
    'commonprogramw6432',
    'psmodulepath',
    'display',
    'wayland_display',
    'xauthority',
    'lang',
    'lc_all',
  ]);
  for (const [key, value] of Object.entries(inherited))
    if (allowed.has(key.toLowerCase())) env[key.toUpperCase() === 'PATH' ? 'PATH' : key] = value;
  return {
    ...env,
    pnpm_config_verify_deps_before_run: 'false',
    HOME: data.home,
    USERPROFILE: data.home,
    APPDATA: path.join(data.home, 'AppData/Roaming'),
    LOCALAPPDATA: path.join(data.home, 'AppData/Local'),
    TMP: data.temp,
    TEMP: data.temp,
    TMPDIR: data.temp,
    PATH: `${data.bin}${path.delimiter}${env.PATH || ''}`,
    ...(windows ? {} : { SHELL: '/bin/sh' }),
    AGENT_TEAMS_ELECTRON_USER_DATA_DIR: data.userData,
    AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: path.join(data.home, '.claude'),
    CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: data.orchestrator,
    CLAUDE_CLI_PATH: data.orchestrator,
    CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: data.opencode,
    OPENCODE_BIN_PATH: data.opencode,
    CLAUDE_TEAM_OPENCODE_MCP_HTTP: '0',
    NODE_BINARY: data.node,
    XDG_CONFIG_HOME: path.join(data.home, '.config'),
    XDG_DATA_HOME: path.join(data.home, '.local/share'),
    XDG_CACHE_HOME: path.join(data.home, '.cache'),
    XDG_STATE_HOME: path.join(data.home, '.local/state'),
  };
}

// Failed managed probes can fall back to PATH. Refuse known installed candidates
// without executing them; disposable CI should contain build tools only.
export function assertNoInstalledOpenCode(data) {
  const env = isolatedEnvironment(data);
  const dirs = [...env.PATH.split(path.delimiter), path.resolve('node_modules/.bin')];
  if (!windows)
    dirs.push(
      '/usr/local/bin',
      '/opt/homebrew/bin',
      '/opt/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin'
    );
  for (const dir of dirs.filter(Boolean)) {
    if (path.resolve(dir) === path.resolve(data.bin)) continue;
    for (const name of ['opencode', 'opencode.exe', 'opencode.cmd', 'opencode.bat'])
      assert(
        !existsSync(path.join(dir, name)),
        'Installed OpenCode candidate present; use a clean disposable runner'
      );
  }
}

export function assertLauncherCommand(launcher) {
  if (windows) return; // Windows cmd launcher is identified by OS birth + ancestry.
  const command = execFileSync('ps', ['-p', String(launcher.pid), '-o', 'args='], {
    encoding: 'utf8',
  }).trim();
  assert(
    /\bpnpm(?:\.[cm]?js)?\s+dev:mcp\b/.test(command),
    'Launcher command changed; refusing access/cleanup'
  );
}

// Read-only failure evidence. Missing identity never grants signal authority.
export function windowsCleanupEvidence(pids) {
  assert(pids.every((pid) => Number.isInteger(pid) && pid > 0));
  assert(pids.length <= 500, 'Cleanup evidence PID bound exceeded');
  if (!windows) return null;
  const ids = [...new Set(pids)].join(',');
  return JSON.parse(
    powershell(`
    $targets = @(${ids});
    $cim = @(Get-CimInstance Win32_Process | Where-Object { $targets -contains [int]$_.ProcessId } | ForEach-Object {
      [pscustomobject]@{ pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; creationDate=$_.CreationDate; executable=$_.ExecutablePath }
    });
    $native = @($targets | ForEach-Object {
      $targetPid = $_;
      try { $proc = Get-Process -Id $targetPid -ErrorAction Stop;
        [pscustomobject]@{ pid=$targetPid; startTime=$proc.StartTime.ToUniversalTime().ToString('o'); hasExited=$proc.HasExited }
      } catch { [pscustomobject]@{ pid=$targetPid; error=$_.Exception.Message } }
    });
    $tcp = @(Get-NetTCPConnection | Where-Object { $_.LocalPort -eq 9222 } | Select-Object LocalAddress,LocalPort,State,OwningProcess);
    @{ cim=$cim; native=$native; tcp=$tcp } | ConvertTo-Json -Depth 5 -Compress
  `)
      .replace(/^\uFEFF/, '')
      .trim()
  );
}
