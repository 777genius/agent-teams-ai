import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { isMainThread, MessageChannel, receiveMessageOnPort, Worker, workerData } from 'node:worker_threads';

const windows = process.platform === 'win32';
const windowsProcessQuery =
  "@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,ExecutablePath | Where-Object CreationDate | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; birth=$_.CreationDate.ToUniversalTime().ToString('o'); executable=$_.ExecutablePath} }) | ConvertTo-Json -Compress";
const windowsListenerQuery = port =>
  `Get-CimInstance -Namespace 'Root\\StandardCimv2' -ClassName MSFT_NetTCPConnection -Filter "LocalPort = ${port} AND State = 2" | Select-Object -ExpandProperty OwningProcess`;
export function powershell(script) {
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
    { encoding: 'utf8', windowsHide: true, timeout: 30000 }
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
function assertWindowsBirth(birth) {
  assert.equal(typeof birth, 'string');
  assert.match(birth, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/);
  const milliseconds = Date.parse(birth);
  assert.ok(Number.isFinite(milliseconds), 'Invalid Windows creation identity');
  assert.equal(new Date(milliseconds).toISOString(), birth.slice(0, 23) + 'Z', 'Canonical Windows creation date');
}
function windowsQueryObserver(snapshot, observerPid) {
  assert.ok(Number.isSafeInteger(observerPid) && observerPid > 0, 'Missing current query PID');
  const matches = snapshot.filter(row => row.pid === observerPid);
  assert.equal(matches.length, 1, 'One current query identity in the original census');
  const { pid, parent, birth } = matches[0];
  assert.ok(Number.isSafeInteger(parent) && parent > 0);
  assertWindowsBirth(birth);
  return { pid, parent, birth };
}
/** Identify this executing query from its own $PID; no second process observation. */
export function windowsProcessSnapshot(execute = powershell) {
  const output = execute(
    `$TESTProcessOutput = ${windowsProcessQuery};\n` +
    '[pscustomobject]@{ processes = [string]$TESTProcessOutput; observerPid = [int]$PID } | ConvertTo-Json -Compress'
  );
  const value = JSON.parse(output.replace(/^\uFEFF/, '').trim());
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Invalid Windows observation envelope');
  assert.deepEqual(Object.keys(value).sort(), ['observerPid', 'processes']);
  assert.equal(typeof value.processes, 'string');
  const snapshot = parseWindowsProcesses(value.processes);
  return { processes: snapshot, observer: windowsQueryObserver(snapshot, value.observerPid) };
}
/** Current-query children are observations only; never add them to App ownership or cleanup. */
export function windowsQueryChildren(snapshot, observer, driver) {
  assert.ok(Array.isArray(snapshot) && snapshot.length <= 10000, 'Complete current query census');
  assert.ok(observer && typeof observer === 'object' && !Array.isArray(observer));
  assert.deepEqual(Object.keys(observer).sort(), ['birth', 'parent', 'pid']);
  assert.deepEqual(observer, windowsQueryObserver(snapshot, observer.pid));
  const byPid = new Map();
  for (const row of snapshot) {
    assert.ok(!byPid.has(row.pid), 'Duplicate process PID in current query census');
    byPid.set(row.pid, row);
  }
  const currentDriver = byPid.get(driver.pid);
  sameIdentity(driver, currentDriver);
  assert.equal(currentDriver.parent, driver.parent, 'Same original query driver parent');
  assert.notEqual(observer.pid, driver.pid);
  assert.notEqual(observer.pid, driver.parent);
  assert.equal(observer.parent, driver.pid, 'Current query belongs to the original driver');
  return snapshot.filter(child => {
    if (child.parent !== observer.pid) return false;
    assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0);
    assertWindowsBirth(child.birth);
    return child.birth > observer.birth;
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
        windowsProcessQuery
      )
    );
  return parseUnixProcesses(
    execFileSync('ps', ['-eo', 'pid=,ppid=,lstart='], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
    })
  );
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
function assertCdpPort(port) {
  assert(Number.isSafeInteger(port) && port >= 1024 && port <= 65535, 'Invalid isolated CDP port');
}
export async function allocateIsolatedCdpPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1', exclusive: true }, () => {
      const address = server.address();
      server.close((error) => {
        if (error) return reject(error);
        if (!address || typeof address === 'string') return reject(new Error('CDP port allocation failed'));
        assertCdpPort(address.port);
        resolve(address.port);
      });
    });
  });
}
export function listeners(port = 9222) {
  assertCdpPort(port);
  if (windows)
    return parseListeners(
      powershell(
        windowsListenerQuery(port)
      )
    );
  try {
    return parseListeners(
      execFileSync('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
    );
  } catch (e) {
    if (e.status === 1 && !String(e.stdout).trim() && !String(e.stderr).trim()) return [];
    throw e;
  }
}
const windowsObservationScript = (port, captureObserver = false) =>
  `$TESTProcessOutput = ${windowsProcessQuery};\n` +
    `$TESTListenerOutput = ${windowsListenerQuery(port)};\n` +
    '[pscustomobject]@{ processes = [string]$TESTProcessOutput; ' +
    'listeners = [string]($TESTListenerOutput -join [Environment]::NewLine)' +
    (captureObserver ? '; observerPid = [int]$PID' : '') +
    ' } | ConvertTo-Json -Compress';
function parseWindowsObservation(output, captureObserver = false) {
  const value = JSON.parse(output.replace(/^\uFEFF/, '').trim());
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Invalid Windows observation envelope');
  assert.deepEqual(Object.keys(value).sort(), captureObserver ? ['listeners', 'observerPid', 'processes'] : ['listeners', 'processes']);
  assert.equal(typeof value.processes, 'string');
  assert.equal(typeof value.listeners, 'string');
  const snapshot = parseWindowsProcesses(value.processes);
  return { processes: snapshot, listeners: parseListeners(value.listeners),
    ...(captureObserver ? { observer: windowsQueryObserver(snapshot, value.observerPid) } : {}),
  };
}
/** Fresh ordered observations, not an atomic snapshot or retained authority. */
export function windowsProcessListenerSnapshot(port = 9222, execute = powershell, captureObserver = false) {
  assertCdpPort(port);
  assert.equal(typeof captureObserver, 'boolean');
  return parseWindowsObservation(execute(windowsObservationScript(port, captureObserver)), captureObserver);
}

const windowsObserverKind = 'TEST_WINDOWS_PROCESS_OBSERVER_V1';
const windowsObserverLimit = 1024 * 1024;
/** A fixed read-only interpreter loop; stdin carries sequence numbers, never PowerShell source. */
export function windowsProcessObserverScript(port) {
  assertCdpPort(port);
  // First-use CIM module progress is emitted as CLIXML on stderr by Windows
  // PowerShell. Disable that presentation stream before importing any module;
  // genuine stderr still fails the worker and never becomes an observation.
  return "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; " +
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ' +
    "$sequence=0; while ($null -ne ($line=[Console]::ReadLine())) { " +
    "$sequence++; if ($line -cne [string]$sequence) { throw 'Invalid TEST observation sequence' }; " +
    '$observation = & { ' + windowsObservationScript(port) + ' }; ' +
    '[Console]::WriteLine(([pscustomobject]@{ sequence=$sequence; observation=[string]$observation } | ConvertTo-Json -Compress)); ' +
    '[Console]::Out.Flush(); }';
}
/** The worker alone owns the original child, its streams, timer and close observation. */
export function serveWindowsProcessObserver(channel, wake, options, createChild = spawn) {
  const publish = value => {
    channel.postMessage(value);
    Atomics.add(wake, 0, 1); Atomics.notify(wake, 0);
  };
  let child, pending, timer, failed = false, closing = false, closed = false, stopping = false, sequence = 0;
  let buffered = Buffer.alloc(0);
  const stopChild = () => {
    if (child && !closed && !stopping) {
      stopping = true; child.stdin.end(); child.kill();
    }
  };
  const fail = () => {
    if (!failed) { failed = true; publish({ kind: 'failure' }); }
    clearTimeout(timer);
    stopChild();
  };
  const receive = message => {
    try {
      assert.ok(message && typeof message === 'object' && !Array.isArray(message));
      if (message.kind === 'close') {
        assert.deepEqual(Object.keys(message), ['kind']);
        closing = true; clearTimeout(timer);
        stopChild();
        return;
      }
      assert.deepEqual(Object.keys(message).sort(), ['kind', 'sequence', 'timeoutMs']);
      assert.equal(message.kind, 'read');
      assert.ok(!failed && !closing && !closed && pending === undefined);
      assert.ok(Number.isSafeInteger(message.sequence) && message.sequence === sequence + 1);
      assert.ok(Number.isSafeInteger(message.timeoutMs) && message.timeoutMs > 0 && message.timeoutMs <= 30000);
      sequence = message.sequence; pending = sequence;
      timer = setTimeout(fail, message.timeoutMs);
      child.stdin.write(String(sequence) + '\n', error => { if (error) fail(); });
    } catch { fail(); }
  };
  try {
    child = createChild(options.executable,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand',
        Buffer.from(windowsProcessObserverScript(options.port), 'utf16le').toString('base64')],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.once('spawn', () => publish({ kind: 'ready', pid: child.pid }));
    child.once('error', fail); child.stdin.on('error', fail);
    child.stderr.on('data', fail);
    child.stdout.on('data', part => {
      try {
        assert.ok(!failed && !closing && pending !== undefined);
        assert.ok(buffered.length + part.length <= windowsObserverLimit);
        buffered = Buffer.concat([buffered, part]);
        const end = buffered.indexOf(10);
        if (end < 0) return;
        assert.equal(end, buffered.length - 1, 'Only one complete original observation is accepted');
        const value = JSON.parse(buffered.toString('utf8').trim());
        assert.deepEqual(Object.keys(value).sort(), ['observation', 'sequence']);
        assert.equal(value.sequence, pending); assert.equal(typeof value.observation, 'string');
        const observation = parseWindowsObservation(value.observation);
        buffered = Buffer.alloc(0); clearTimeout(timer); pending = undefined;
        publish({ kind: 'snapshot', sequence, observation });
      } catch { fail(); }
    });
    child.once('close', (code, signal) => {
      closed = true; clearTimeout(timer);
      if (!closing) fail();
      publish({ kind: 'closed', pid: child.pid ?? null, code, signal, expected: closing && !failed });
      channel.off('message', receive); channel.close();
    });
    channel.on('message', receive);
  } catch {
    fail();
    if (!child) {
      publish({ kind: 'closed', pid: null, code: null, signal: null, expected: false });
      channel.close();
    }
  }
}

/** Synchronous fresh reads preserve the UI guard contract; no observation is reused. */
export function createWindowsProcessObservationClient({
  channel, wake, executable, driverPid, exited, receive = receiveMessageOnPort,
  now = () => performance.now(), wait = Atomics.wait,
}) {
  let pid, identity, sequence = 0, failed = false, closing = false;
  const duration = milliseconds => {
    assert.ok(Number.isSafeInteger(milliseconds) && milliseconds > 0 && milliseconds <= 30000);
    return now() + milliseconds;
  };
  const next = deadline => {
    for (;;) {
      const left = Math.floor(deadline - now());
      assert.ok(left > 0, 'Original Windows observation deadline');
      const version = Atomics.load(wake, 0), packet = receive(channel);
      if (packet) {
        const value = packet.message;
        assert.ok(value && typeof value === 'object' && !Array.isArray(value));
        assert.notEqual(value.kind, 'failure', 'Original Windows observation worker failed');
        return value;
      }
      wait(wake, 0, version, left);
    }
  };
  return {
    snapshot(milliseconds) {
      assert.ok(!failed && !closing, 'Original Windows observer is closed or failed');
      const deadline = duration(milliseconds);
      try {
        if (pid === undefined) {
          const ready = next(deadline);
          assert.deepEqual(Object.keys(ready).sort(), ['kind', 'pid']); assert.equal(ready.kind, 'ready');
          assert.ok(Number.isSafeInteger(ready.pid) && ready.pid > 1); pid = ready.pid;
        }
        const left = Math.floor(deadline - now()); assert.ok(left > 0, 'Original Windows observation deadline');
        channel.postMessage({ kind: 'read', sequence: ++sequence, timeoutMs: left });
        const response = next(deadline);
        assert.deepEqual(Object.keys(response).sort(), ['kind', 'observation', 'sequence']);
        assert.equal(response.kind, 'snapshot'); assert.equal(response.sequence, sequence);
        const observation = response.observation;
        assert.deepEqual(Object.keys(observation).sort(), ['listeners', 'processes']);
        assert.ok(Array.isArray(observation.processes) && observation.processes.length <= 10000);
        assert.ok(Array.isArray(observation.listeners));
        const owners = observation.processes.filter(row => row.pid === pid);
        assert.equal(owners.length, 1, 'Original query child appears exactly once in every fresh census');
        const owner = owners[0];
        assert.equal(owner.parent, driverPid); assert.equal(typeof owner.birth, 'string');
        assert.ok(owner.birth.length > 0); assert.equal(typeof owner.executable, 'string');
        assert.equal(owner.executable.toLowerCase(), executable.toLowerCase());
        if (identity) sameIdentity(identity, owner); else identity = { ...owner };
        assert.ok(now() < deadline, 'Original Windows observation deadline');
        return { ...observation, observer: { pid: owner.pid, parent: owner.parent, birth: owner.birth } };
      } catch (error) { failed = true; throw error; }
    },
    async close(milliseconds) {
      closing = true;
      channel.postMessage({ kind: 'close' });
      let timer;
      try {
        const deadline = duration(milliseconds);
        const result = await Promise.race([exited, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Original Windows observer close deadline')), Math.max(1, deadline - now()));
        })]);
        assert.equal(result.code, 0, 'Original observation worker exited normally');
        assert.equal(result.error, undefined, 'Original observation worker did not fail');
        let closed;
        for (let packet = receive(channel); packet; packet = receive(channel)) {
          if (packet.message?.kind === 'ready' && pid === undefined) pid = packet.message.pid;
          if (packet.message?.kind === 'closed') { assert.equal(closed, undefined); closed = packet.message; }
        }
        assert.ok(closed, 'Original PowerShell child close was positively observed');
        assert.equal(closed.pid, pid); assert.equal(closed.expected, true);
        assert.ok(now() < deadline, 'Original Windows observer close deadline');
        return { identity: identity ?? null, pid, closed: true };
      } finally { clearTimeout(timer); channel.close(); }
    },
  };
}
export function createWindowsProcessObserver(port = 9222) {
  assert.equal(process.platform, 'win32'); assertCdpPort(port);
  const executable = realpathSync.native(path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32/WindowsPowerShell/v1.0/powershell.exe'));
  const { port1, port2 } = new MessageChannel(), wake = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { kind: windowsObserverKind, channel: port2, wake, executable, port }, transferList: [port2],
  });
  let error;
  worker.once('error', value => { error = value; });
  const exited = new Promise(resolve => worker.once('exit', code => resolve({ code, error })));
  return createWindowsProcessObservationClient({ channel: port1, wake, executable, driverPid: process.pid, exited });
}
if (!isMainThread && workerData?.kind === windowsObserverKind)
  serveWindowsProcessObserver(workerData.channel, workerData.wake, workerData);

export function assertListenerOwnership(ids, owned) {
  assert(
    ids.length && ids.every((pid) => owned.some((p) => p.pid === pid && p.pid !== owned[0].pid)),
    'CDP listener is not a launcher descendant; refusing access'
  );
}
export async function assertPortAvailable(port = 9222) {
  assertCdpPort(port);
  // Electron can release its CDP listener just after the previous owned
  // fixture has received SIGTERM. Wait briefly, but never connect to, reuse,
  // or terminate a foreign listener.
  const deadline = Date.now() + 15_000;
  while (listeners(port).length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(listeners(port).length, 0, `Port ${port} already has a listener`);
  for (const host of ['127.0.0.1', '::1']) {
    await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', (error) => {
        if (host === '::1' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) resolve();
        else reject(error);
      });
      server.listen({ port, host, exclusive: true }, () => server.close(resolve));
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
export function launchCommand(platform = process.platform, port = 9222) {
  assertCdpPort(port);
  // The dev:mcp shortcut pins port 9222. An isolated test uses the same
  // underlying dev script with its own explicitly selected debugging port.
  const args = port === 9222
    ? ['dev:mcp', '--noSandbox']
    : ['dev', '--remoteDebuggingPort', String(port), '--noSandbox'];
  return platform === 'win32'
    ? {
        command: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
        args: ['/d', '/s', '/c', 'pnpm ' + args.join(' ')],
      }
    : { command: 'pnpm', args };
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
    /\bpnpm(?:\.[cm]?js)?\s+dev(?::mcp)?\b/.test(command),
    'Launcher command changed; refusing access/cleanup'
  );
}

// Read-only failure evidence. Missing identity never grants signal authority.
export function windowsCleanupEvidence(pids) {
  assert(pids.every(pid => Number.isInteger(pid) && pid > 0));
  assert(pids.length <= 500, 'Cleanup evidence PID bound exceeded');
  if (!windows) return null;
  const ids = [...new Set(pids)].join(',');
  return JSON.parse(powershell(`
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
  `).replace(/^\uFEFF/, '').trim());
}
