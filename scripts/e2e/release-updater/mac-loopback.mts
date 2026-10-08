import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { resolve4, resolve6 } from 'node:dns/promises';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { connect, isIP } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

import { canonical, digest } from '../../ci/release/contract.ts';
import { waitFor } from './cdp.mts';
import { serializeMacPfBaseline } from './mac-pf-baseline.mts';

import type { ChildProcess } from 'node:child_process';

const execute = promisify(execFile);
export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  outputSha256: string;
  logFile: string;
  elapsedMs?: number;
  execFailure?: { code: number | string | null; signal: string | null; killed: boolean };
}
export class MacCommands {
  readonly commands: CommandResult[] = [];
  activeChildPid: number | undefined;
  readonly output: string;
  private progressSequence = 0;
  constructor(output: string) {
    this.output = output;
  }
  async run(
    label: string,
    binary: string,
    args: string[],
    timeout = 120_000
  ): Promise<CommandResult> {
    assert(binary.startsWith('/'), 'Native command must use an absolute executable path');
    assert(/^[a-z0-9-]+$/.test(label));
    // Diagnostic write failures must not change command execution or block cleanup.
    const progressId = `${process.pid}-command-${++this.progressSequence}-${label}`;
    const progress = { label, executable: binary, timeout, startedAt: new Date().toISOString() };
    await writeFile(
      path.join(this.output, `${progressId}-start.json`),
      `${canonical({ ...progress, state: 'START' })}\n`,
      { flag: 'wx', mode: 0o600 }
    ).catch(() => undefined);
    const nativeStarted = Date.now();
    let execFailure: CommandResult['execFailure'];
    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    try {
      const pending = execute(binary, args, {
        timeout,
        maxBuffer: 4_194_304,
        env: { ...process.env, LC_ALL: 'C' },
      });
      this.activeChildPid = pending.child.pid;
      const result = await pending;
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      const result = error as Error & {
        stdout?: string;
        stderr?: string;
        code?: number | string;
        signal?: string;
        killed?: boolean;
      };
      execFailure = {
        code: result.code ?? null,
        signal: result.signal ?? null,
        killed: result.killed === true,
      };
      stdout = result.stdout ?? '';
      stderr = `${result.stderr ?? ''}\n${result.message}`;
      exitCode = typeof result.code === 'number' ? result.code : 128;
    }
    this.activeChildPid = undefined;
    const logFile = `${process.pid}-${String(this.commands.length + 1).padStart(3, '0')}-${label}.log`;
    const bytes = `stdout:\n${stdout}\nstderr:\n${stderr}`;
    const result = {
      command: [binary, ...args].join(' '),
      exitCode,
      stdout,
      stderr,
      outputSha256: digest(bytes),
      logFile,
      elapsedMs: Date.now() - nativeStarted,
      ...(execFailure ? { execFailure } : {}),
    };
    await writeFile(path.join(this.output, logFile), bytes, { flag: 'wx' });
    this.commands.push(result);
    await writeFile(
      path.join(this.output, `${progressId}-complete.json`),
      `${canonical({
        ...progress,
        state: 'COMPLETE',
        elapsedMs: result.elapsedMs,
        ...(execFailure ? { execFailure } : {}),
      })}\n`,
      { flag: 'wx', mode: 0o600 }
    ).catch(() => undefined);
    return result;
  }
  async checked(label: string, binary: string, args: string[], timeout?: number) {
    const result = await this.run(label, binary, args, timeout);
    const diagnostics = label.startsWith('pf-')
      ? `\nPF stderr: ${result.stderr.slice(0, 4096)}\nPF stdout: ${result.stdout.slice(0, 4096)}`
      : '';
    assert.equal(result.exitCode, 0, `${label} failed; see ${result.logFile}${diagnostics}`);
    return result;
  }
}

function ciOnly() {
  assert.equal(process.platform, 'darwin');
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.env.GITHUB_REPOSITORY, '777genius/agent-teams-ai');
  assert(
    process.env.GITHUB_WORKFLOW_REF?.startsWith(
      '777genius/agent-teams-ai/.github/workflows/updater-mac-updater.yml@'
    )
  );
}
interface PfReceipt {
  baselineDisabled: true;
  toolingSha: string;
  originalRulesSha256: string;
  originalNatSha256: string;
  originalPolicySha256: string;
  applicationRoot: string;
  launchAttempted: boolean;
  launchPid?: number;
  launchOwner?: MacProcess;
  restored: boolean;
}
async function readPfReceipt(commands: MacCommands) {
  ciOnly();
  const receipt = JSON.parse(
    await readFile(path.join(commands.output, 'pf-owned.json'), 'utf8')
  ) as PfReceipt;
  assert(
    receipt.baselineDisabled && receipt.toolingSha === process.env.GITHUB_SHA,
    'PF receipt must belong to this disposable job'
  );
  const runnerRoot = await realpath(process.env.RUNNER_TEMP ?? '');
  assert(
    receipt.applicationRoot.startsWith(`${runnerRoot}/TEST-mac-current-`) &&
      receipt.applicationRoot.endsWith('/Applications/Agent Teams AI.app') &&
      path.dirname(path.dirname(path.dirname(receipt.applicationRoot))) === runnerRoot &&
      (await realpath(receipt.applicationRoot)) === receipt.applicationRoot,
    "PF receipt install path must be this job's original TEST application"
  );
  return receipt;
}
export async function recordMacLaunch(commands: MacCommands, pid?: number, owner?: MacProcess) {
  const receipt = await readPfReceipt(commands);
  assert(!receipt.restored, 'A TEST app may not launch after PF restoration');
  receipt.launchAttempted = true;
  if (pid !== undefined) {
    assert(Number.isSafeInteger(pid) && pid > 0);
    assert(receipt.launchPid === undefined || receipt.launchPid === pid, 'Launch PID changed');
    receipt.launchPid = pid;
  }
  if (owner) {
    assert.equal(owner.pid, receipt.launchPid);
    requireMacOwner(owner, owner.pid, `${receipt.applicationRoot}/Contents/MacOS/Agent Teams AI`);
    receipt.launchOwner = owner;
  }
  await writeFile(path.join(commands.output, 'pf-owned.json'), `${canonical(receipt)}\n`);
}
async function proveMacApplicationStopped(commands: MacCommands, receipt: PfReceipt) {
  assert(
    !receipt.launchAttempted || receipt.launchPid !== undefined,
    'Launch registration was interrupted; retain PF until disposable VM teardown'
  );
  let stopError: string | undefined;
  if (receipt.launchOwner && !receipt.restored) {
    try {
      await stopMacOwned(commands, receipt.launchOwner, receipt.applicationRoot);
    } catch (error) {
      // A later native scan may prove the app exited. Never signal an unproven identity.
      stopError = String(error);
    }
  }
  const scans: { remaining: MacProcess[]; at: string }[] = [];
  let absentReads = 0;
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    const remaining = (await macProcesses(commands)).filter(
      (process) =>
        process.command.startsWith(`${receipt.applicationRoot}/Contents/`) ||
        process.pid === receipt.launchPid ||
        process.group === receipt.launchPid ||
        process.group === receipt.launchOwner?.group
    );
    scans.push({ remaining, at: new Date().toISOString() });
    absentReads = remaining.length ? 0 : absentReads + 1;
    if (absentReads >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const proof = {
    applicationRoot: receipt.applicationRoot,
    launchPid: receipt.launchPid,
    owner: receipt.launchOwner,
    stopError,
    scans,
    applicationAbsent: absentReads >= 2,
  };
  await writeFile(
    path.join(commands.output, `mac-app-cleanup-${process.pid}.json`),
    `${JSON.stringify(proof, null, 2)}\n`
  );
  assert(
    proof.applicationAbsent,
    'TEST app termination is unproven; retain PF until disposable VM teardown'
  );
}
export async function restoreMacNetwork(commands: MacCommands) {
  const receipt = await readPfReceipt(commands);
  // This gate also applies to emergency cleanup after timeout/cancellation or a failed finally.
  // The firewall is never disabled while a registered launch or TEST app process remains.
  await proveMacApplicationStopped(commands, receipt);
  if (receipt.restored) return receipt;
  // The baseline was disabled. Reconnect CI before restoring the captured baseline configuration.
  const current = await commands.checked('pf-current-status', '/usr/bin/sudo', [
    '-n',
    '/sbin/pfctl',
    '-s',
    'info',
  ]);
  if (!current.stdout.includes('Status: Disabled'))
    await commands.checked('pf-disable-owned', '/usr/bin/sudo', ['-n', '/sbin/pfctl', '-d']);
  const baseline = path.join(commands.output, 'pf-baseline-active.conf');
  assert.equal(
    digest(await readFile(baseline)),
    receipt.originalPolicySha256,
    'Captured PF baseline bytes changed'
  );
  await commands.checked('pf-restore-baseline', '/usr/bin/sudo', [
    '-n',
    '/sbin/pfctl',
    '-f',
    baseline,
  ]);
  const status = await commands.checked('pf-restored-status', '/usr/bin/sudo', [
    '-n',
    '/sbin/pfctl',
    '-s',
    'info',
  ]);
  assert(status.stdout.includes('Status: Disabled'), 'PF must return to its disabled baseline');
  const rules = await commands.checked('pf-restored-rules', '/usr/bin/sudo', [
    '-n',
    '/sbin/pfctl',
    '-sr',
  ]);
  assert.equal(
    digest(rules.stdout),
    receipt.originalRulesSha256,
    'PF baseline filter rules changed'
  );
  const nat = await commands.checked('pf-restored-nat', '/usr/bin/sudo', [
    '-n',
    '/sbin/pfctl',
    '-sn',
  ]);
  assert.equal(digest(nat.stdout), receipt.originalNatSha256, 'PF baseline NAT rules changed');
  receipt.restored = true;
  await writeFile(path.join(commands.output, 'pf-owned.json'), `${canonical(receipt)}\n`);
  return receipt;
}

async function tcp(address: string) {
  return new Promise<{ connected: boolean; error?: string }>((resolve) => {
    const socket = connect({ host: address, port: 443 });
    let done = false;
    const finish = (result: { connected: boolean; error?: string }) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(2500, () => finish({ connected: false, error: 'timeout' }));
    socket.once('connect', () => finish({ connected: true }));
    socket.once('error', (error) => finish({ connected: false, error: error.message }));
  });
}
export async function containMacNetwork(commands: MacCommands, applicationRoot: string) {
  ciOnly();
  const status = await commands.checked('pf-baseline-status', '/usr/bin/sudo', [
    '-n',
    '/sbin/pfctl',
    '-s',
    'info',
  ]);
  assert(
    status.stdout.includes('Status: Disabled'),
    'Fresh VM must begin with PF disabled; no shared active firewall may be replaced'
  );
  const rules = await commands.checked('pf-baseline-rules', '/usr/bin/sudo', [
    '-n',
    '/sbin/pfctl',
    '-sr',
  ]);
  const nat = await commands.checked('pf-baseline-nat', '/usr/bin/sudo', [
    '-n',
    '/sbin/pfctl',
    '-sn',
  ]);
  // Disabled PF may have an empty active ruleset even when /etc/pf.conf contains anchors.
  // Restore the actual active baseline, not a newly loaded approximation of it.
  const originalPolicy = serializeMacPfBaseline(nat.stdout, rules.stdout);
  await writeFile(path.join(commands.output, 'pf-baseline-active.conf'), originalPolicy, {
    flag: 'wx',
  });
  // A rendered pfctl dump is not necessarily a reloadable config. Reject an
  // unparseable baseline before replacing any active PF policy.
  await commands.checked('pf-parse-active-baseline', '/usr/bin/sudo', [
    '-n',
    '/sbin/pfctl',
    '-n',
    '-f',
    path.join(commands.output, 'pf-baseline-active.conf'),
  ]);
  const conf = await readFile('/etc/pf.conf');
  await writeFile(path.join(commands.output, 'pf-original.conf'), conf, { flag: 'wx' });
  // Resolve the public control before PF blocks DNS, then reuse those exact addresses.
  // A TCP handshake carries no app/provider credentials or application payload.
  const controlHost = 'one.one.one.one';
  const [[ipv4Address], [ipv6Address]] = await Promise.all([
    resolve4(controlHost),
    resolve6(controlHost),
  ]);
  assert(ipv4Address && isIP(ipv4Address) === 4, 'Public control needs an IPv4 address');
  assert(ipv6Address && isIP(ipv6Address) === 6, 'Public control needs an IPv6 address');
  const [beforeIpv4, beforeIpv6] = await Promise.all([tcp(ipv4Address), tcp(ipv6Address)]);
  await writeFile(
    path.join(commands.output, 'network-control-baseline.json'),
    `${JSON.stringify({ controlHost, ipv4Address, ipv6Address, beforeIpv4, beforeIpv6 }, null, 2)}\n`,
    { flag: 'wx' }
  );
  assert(
    beforeIpv4.connected,
    'External IPv4 denial proof requires a reachable pre-containment control'
  );
  if (!beforeIpv6.connected) {
    await commands.checked('ipv6-baseline-interfaces', '/sbin/ifconfig', ['-a']);
    // Missing IPv6 routing is evidence of the runner limitation, not a containment pass.
    await commands.run('ipv6-baseline-route', '/sbin/route', ['-n', 'get', '-inet6', ipv6Address]);
  }
  const ruleFile = path.join(commands.output, 'pf-loopback.conf');
  const policy =
    'set block-policy drop\nset skip on lo0\nblock drop quick inet all\nblock drop quick inet6 all\n';
  await writeFile(ruleFile, policy, { flag: 'wx' });
  const receipt: PfReceipt = {
    baselineDisabled: true,
    toolingSha: process.env.GITHUB_SHA ?? '',
    originalRulesSha256: digest(rules.stdout),
    originalNatSha256: digest(nat.stdout),
    originalPolicySha256: digest(originalPolicy),
    applicationRoot,
    launchAttempted: false,
    restored: false,
  };
  await writeFile(path.join(commands.output, 'pf-owned.json'), `${canonical(receipt)}\n`, {
    flag: 'wx',
  });
  await commands.checked('pf-check-policy', '/usr/bin/sudo', [
    '-n',
    '/sbin/pfctl',
    '-n',
    '-f',
    ruleFile,
  ]);
  await commands.checked('pf-install-policy', '/usr/bin/sudo', [
    '-n',
    '/sbin/pfctl',
    '-f',
    ruleFile,
  ]);
  await commands.checked('pf-enable-owned', '/usr/bin/sudo', ['-n', '/sbin/pfctl', '-e']);
  await commands.checked('pf-flush-disposable-states', '/usr/bin/sudo', [
    '-n',
    '/sbin/pfctl',
    '-F',
    'states',
  ]);
  const active = await commands.checked('pf-active-rules', '/usr/bin/sudo', [
    '-n',
    '/sbin/pfctl',
    '-sr',
  ]);
  const enabled = await commands.checked('pf-active-status', '/usr/bin/sudo', [
    '-n',
    '/sbin/pfctl',
    '-s',
    'info',
  ]);
  assert(enabled.stdout.includes('Status: Enabled'), 'Owned PF policy must be enabled');
  assert.deepEqual(active.stdout.trim().split(/\r?\n/), [
    'block drop quick inet all',
    'block drop quick inet6 all',
  ]);
  const [ipv4, ipv6] = await Promise.all([tcp(ipv4Address), tcp(ipv6Address)]);
  assert(!ipv4.connected && !ipv6.connected, 'OS containment allowed an external connection');
  return {
    scope: 'disposable GitHub VM only; rules apply to every process and successor',
    policy,
    controlHost,
    ipv4Address,
    ipv6Address,
    ipv4: { before: beforeIpv4, after: ipv4, activeDenialProved: true, policyEnforced: true },
    ipv6: {
      before: beforeIpv6,
      after: ipv6,
      activeDenialProved: beforeIpv6.connected,
      policyEnforced: true,
      limitation: beforeIpv6.connected
        ? null
        : 'Runner IPv6 control was initially unreachable; empirical IPv6 denial is not proven',
    },
    rulesSha256: digest(active.stdout),
    processIndependent: true,
  };
}

interface MacProcess {
  pid: number;
  uid: number;
  group: number;
  start: string;
  command: string;
}
class MacProcessReadError extends Error {}
export interface MacProcessSnapshot extends MacProcess {
  parentPid: number;
  state: string;
}
export function activeMacProcess(process: MacProcessSnapshot): boolean {
  return !/^[ZX]/.test(process.state);
}
export function parseMacProcessSnapshot(stdout: string): MacProcessSnapshot[] {
  return stdout
    .trim()
    .split('\n')
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      const state = parts[4];
      assert(
        parts.length >= 11 && typeof state === 'string' && /^[A-Z?][A-Za-z+<>-]*$/.test(state),
        'Invalid native process state'
      );
      const pid = Number(parts[0]);
      const uid = Number(parts[1]);
      const group = Number(parts[2]);
      const parentPid = Number(parts[3]);
      assert(
        [pid, uid, group, parentPid].every((value) => Number.isSafeInteger(value) && value >= 0),
        'Invalid native process identity'
      );
      return {
        pid,
        uid,
        group,
        parentPid,
        state,
        start: parts.slice(5, 10).join(' '),
        command: parts.slice(10).join(' '),
      };
    });
}
export async function macProcessSnapshot(commands: MacCommands): Promise<MacProcessSnapshot[]> {
  const raw = await commands.run(
    'process-identities',
    '/bin/ps',
    ['-axww', '-o', 'pid=,uid=,pgid=,ppid=,stat=,lstart=,comm='],
    5000
  );
  if (raw.exitCode !== 0)
    throw new MacProcessReadError(`process-identities failed; see ${raw.logFile}`);
  const processes = parseMacProcessSnapshot(raw.stdout);
  assert(
    processes.some((entry) => entry.pid === process.pid && entry.uid === process.getuid?.()),
    'Native process enumeration must include the current harness'
  );
  return processes;
}
// State and parent changes are evidence, not immutable launch identity.
function processIdentity(process: MacProcessSnapshot): MacProcess {
  return {
    pid: process.pid,
    uid: process.uid,
    group: process.group,
    start: process.start,
    command: process.command,
  };
}

export async function macProcesses(commands: MacCommands): Promise<MacProcess[]> {
  return (await macProcessSnapshot(commands)).map(processIdentity);
}
export async function macOwner(commands: MacCommands, pid: number, executable: string) {
  const owner = (await macProcesses(commands)).find((process) => process.pid === pid);
  return requireMacOwner(owner, pid, executable);
}
function requireMacOwner(owner: MacProcess | undefined, pid: number, executable: string) {
  assert(
    owner?.group === pid && owner.uid === process.getuid?.() && owner.command === executable,
    'Detached TEST launch identity must match its native executable'
  );
  return owner;
}
export async function macLaunchOwner(
  commands: MacCommands,
  child: ChildProcess,
  pid: number,
  executable: string
) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    assert(child.exitCode === null && child.signalCode === null, 'TEST launch already exited');
    const owner = (await macProcesses(commands)).find((process) => process.pid === pid);
    assert(
      child.exitCode === null && child.signalCode === null,
      'TEST launch exited during lookup'
    );
    if (owner) return requireMacOwner(owner, pid, executable);
    // Only a missing PID retries. Command and foreign-identity failures propagate.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Cannot prove ownership of spawned Mac PID ${pid}`);
}
export async function stopMacOwned(commands: MacCommands, owner: MacProcess, app: string) {
  const members = async () => {
    const processes = (await macProcessSnapshot(commands))
      .filter(activeMacProcess)
      .map(processIdentity);
    const current = processes.find((process) => process.pid === owner.pid);
    if (current) assert.deepEqual(current, owner, 'Owned main PID identity changed');
    const group = processes.filter((process) => process.group === owner.group);
    assert(
      group.every(
        (process) => process.uid === owner.uid && process.command.startsWith(`${app}/Contents/`)
      ),
      'Owned process group contains a foreign process'
    );
    return group;
  };
  // Post-signal presentation changes remain blocking; only members() authorizes signals.
  const remaining = async () =>
    (await macProcessSnapshot(commands))
      .filter(activeMacProcess)
      .map(processIdentity)
      .filter((process) => process.pid === owner.pid || process.group === owner.group);
  const before = await members();
  if (before.length) process.kill(-owner.group, 'SIGTERM');
  try {
    await waitFor(
      async () => ((await remaining()).length === 0 ? true : null),
      'Mac owned process group termination',
      3000
    );
  } catch {
    if ((await members()).length) process.kill(-owner.group, 'SIGKILL');
    await waitFor(
      async () => ((await remaining()).length === 0 ? true : null),
      'Mac owned process group forced termination',
      3000
    );
  }
  return { before, remaining: await remaining() };
}

export async function macOwnedForeground(commands: MacCommands, owner: MacProcess, reader: string) {
  return waitFor(async () => {
    assert.deepEqual(await macOwner(commands, owner.pid, owner.command), owner, 'Owned focus PID identity changed');
    const observed = JSON.parse((await commands.checked('actual-frontmost-application', reader, [String(owner.pid), owner.command])).stdout) as { pid: number; executable: string };
    if (observed.pid !== owner.pid) return null;
    assert.equal(observed.executable, owner.command, 'Owned frontmost executable changed');
    return observed;
  }, 'Exact owned application foreground', 3000);
}

export interface MacSmokeObservation {
  process: MacProcessSnapshot;
  crashpadDatabase?: string;
}
export function macSmokeCustody(
  observations: MacSmokeObservation[], leaderPid: number, app: string,
  uid: number, started: number, finished: number, profiles: readonly string[]
): MacProcessSnapshot[] {
  const owned = new Map<number, MacProcessSnapshot>();
  const leader = observations.find(({ process }) => process.pid === leaderPid)?.process;
  assert(leader, 'Smoke leader native identity was not observed');
  const qualifies = (item: MacProcessSnapshot) => {
    const start = Date.parse(item.start);
    assert(item.uid === uid && item.command.startsWith(`${app}/Contents/`) &&
      Number.isFinite(start) && start >= started - 1000 && start <= finished,
    'Smoke process custody UID/path/start mismatch');
  };
  qualifies(leader);
  assert.equal(leader.group, leader.pid, 'Smoke leader must own its detached group');
  owned.set(leader.pid, leader);
  for (const observation of observations) {
    const item = observation.process;
    qualifies(item);
    const previous = owned.get(item.pid);
    if (previous) {
      assert.deepEqual(processIdentity(item), processIdentity(previous), 'Smoke PID identity changed');
      owned.set(item.pid, item);
      continue;
    }
    const parent = owned.get(item.parentPid);
    const database = observation.crashpadDatabase;
    const roleBound = database !== undefined && profiles.some(profile => database.startsWith(`${path.dirname(profile)}/`) && path.basename(database) === 'Crashpad');
    if (parent || (item.group === leader.group) || roleBound) owned.set(item.pid, item);
  }
  for (const { process: item } of observations)
    assert(owned.has(item.pid), `Unproved live smoke bundle process PID ${item.pid} PPID ${item.parentPid} state ${item.state}`);
  return [...owned.values()];
}
export async function stopMacSmokeCustody(commands: MacCommands, owners: MacProcessSnapshot[], app: string) {
  const stop = async (signal: 'SIGTERM' | 'SIGKILL') => {
    for (const owner of owners) {
      const current = (await macProcessSnapshot(commands)).find(item => item.pid === owner.pid);
      if (!current || !activeMacProcess(current)) continue;
      assert.deepEqual(processIdentity(current), processIdentity(owner), 'Smoke PID identity changed before signal');
      assert(current.parentPid === owner.parentPid || current.parentPid === 1, 'Smoke parent identity changed before signal');
      assert(current.uid === process.getuid?.() && current.command.startsWith(`${app}/Contents/`));
      process.kill(current.pid, signal);
    }
  };
  const remaining = async () => (await macProcessSnapshot(commands)).filter(item =>
    activeMacProcess(item) && (owners.some(owner => owner.pid === item.pid) || item.command.startsWith(`${app}/Contents/`)));
  await stop('SIGTERM');
  try { await waitFor(async () => (await remaining()).length === 0 ? true : null, 'Smoke bundle termination', 3000); }
  catch { await stop('SIGKILL'); await waitFor(async () => (await remaining()).length === 0 ? true : null, 'Smoke bundle forced termination', 3000); }
  return { owners, remaining: await remaining() };
}
async function macSmokeObservation(commands: MacCommands, item: MacProcessSnapshot, profiles: Set<string>, seedProfile: boolean): Promise<MacSmokeObservation> {
        let args: string;
        try { args = (await execute('/bin/ps', ['-p', String(item.pid), '-o', 'args='], { timeout: 1000 })).stdout; }
        catch (error) {
          const current = (await macProcessSnapshot(commands)).find(value => value.pid === item.pid);
          if (current && activeMacProcess(current)) throw error;
          return { process: item };
        }
        const profile = /--user-data-dir=(\S+)/.exec(args)?.[1];
        if (profile && seedProfile) {
          const profileRoot = path.dirname(profile), info = await stat(profileRoot);
          assert(path.basename(profileRoot).startsWith('agent-teams-smoke-TEST-') && info.uid === item.uid && (info.mode & 0o777) === 0o700);
          assert(path.isAbsolute(profile));
          assert.equal(await readFile(path.join(profileRoot, '.test-only'), 'utf8'), 'packaged-app-smoke-test-v1');
          profiles.add(await realpath(profile));
        }
        const database = /--database=(\S+)/.exec(args)?.[1];
        return { process: item, ...(/(?:^|\s)--type=crashpad-handler(?:\s|$)/.test(args) && database ? { crashpadDatabase: await realpath(database) } : {}) };
}
export async function runMacSmokeOwned(commands: MacCommands, app: string, nonce: string, smokeParent: () => number | undefined, run: () => Promise<CommandResult>) {
  assert.equal(await realpath(app), app, 'Smoke bundle must be canonical');
  assert(/^[a-f0-9-]{36}$/.test(nonce));
  assert.equal(await readFile(path.join(path.dirname(app), '.test-only-smoke-custody'), 'utf8'), `mac-manual-owned:${nonce}`);
  const root = path.dirname(app), rootStat = await stat(root);
  assert(path.basename(root).startsWith('TEST-mac-manual-owned-') && rootStat.uid === process.getuid?.() && (rootStat.mode & 0o777) === 0o700, 'Smoke bundle root custody invalid');
  assert(!(await macProcessSnapshot(commands)).some(item => activeMacProcess(item) && item.command.startsWith(`${app}/Contents/`)), 'Smoke baseline bundle must be empty');
  const observations: MacSmokeObservation[] = [], profiles = new Set<string>();
  const started = Date.now();
  let done = false, observationError: Error | undefined;
  const observe = async () => {
    while (!done) {
      const all = await macProcessSnapshot(commands);
      const parent = all.find(item => item.pid === smokeParent());
      const parentOwned = parent !== undefined && parent.uid === process.getuid?.() && parent.parentPid === process.pid && parent.command === process.execPath;
      const snapshot = all.filter(item => activeMacProcess(item) && item.command.startsWith(`${app}/Contents/`));
      for (const item of snapshot) {
        assert.equal(item.uid, process.getuid?.(), 'Foreign smoke process UID');
        const previous = observations.find(value => value.process.pid === item.pid && value.process.start === item.start);
        if (previous) {
          assert.deepEqual(processIdentity(previous.process), processIdentity(item), 'Smoke PID identity changed');
          observations.push({ ...previous, process: item });
          continue;
        }
        const seedProfile = parentOwned && item.parentPid === parent?.pid && item.group === item.pid && item.command === path.join(app, 'Contents/MacOS/Agent Teams AI') && Date.parse(item.start) >= started - 1000;
        observations.push(await macSmokeObservation(commands, item, profiles, seedProfile));
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  const observing = observe().catch((error: unknown) => { observationError = error instanceof Error ? error : new Error('Smoke observation failed with non-Error cause'); });
  let result: CommandResult;
  try { result = await run(); } finally {
    done = true; await observing;
    await writeFile(path.join(commands.output, 'smoke-process-custody.json'), `${canonical({ started, finished: Date.now(), observations, profiles: [...profiles], observationError: observationError?.message ?? null })}\n`, { flag: 'wx' });
  }
  if (observationError) throw observationError;
  const leaderPid = Number(/\[smokePackagedApp\] spawned: pid=(\d+)/.exec(result.stdout)?.[1]);
  const owners = macSmokeCustody(observations, leaderPid, app, process.getuid?.() ?? -1, started, Date.now(), [...profiles]);
  const cleanup = await stopMacSmokeCustody(commands, owners, app);
  return { observations, profiles: [...profiles], cleanup };
}

// CoreGraphics reads the actual Aqua window owner. Renderer screenshots are separate evidence.
const windowSource = `import Foundation
import CoreGraphics
import ImageIO
if CommandLine.arguments[1] == "--image" {
  let url = URL(fileURLWithPath: CommandLine.arguments[2])
  guard let source = CGImageSourceCreateWithURL(url as CFURL, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { exit(3) }
  var pixels = [UInt8](repeating: 0, count: 64 * 64 * 4)
  guard let context = CGContext(data: &pixels, width: 64, height: 64, bitsPerComponent: 8, bytesPerRow: 256, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { exit(4) }
  context.draw(image, in: CGRect(x: 0, y: 0, width: 64, height: 64))
  let colors = Set(stride(from: 0, to: pixels.count, by: 4).map { Int(pixels[$0]) << 16 | Int(pixels[$0 + 1]) << 8 | Int(pixels[$0 + 2]) })
  let data = try JSONSerialization.data(withJSONObject: ["width": image.width, "height": image.height, "distinctColors": colors.count], options: [.sortedKeys])
  FileHandle.standardOutput.write(data)
  exit(0)
}
let pid = Int(CommandLine.arguments[1])!
guard let all = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { exit(2) }
let windows = all.filter { ($0[kCGWindowOwnerPID as String] as? Int) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }
let data = try JSONSerialization.data(withJSONObject: windows, options: [.sortedKeys])
FileHandle.standardOutput.write(data)
`;
export async function prepareMacWindow(commands: MacCommands) {
  const source = path.join(commands.output, 'TEST-window.swift');
  const binary = path.join(commands.output, 'TEST-window');
  await writeFile(source, windowSource, { flag: 'wx' });
  await commands.checked('compile-window-reader', '/usr/bin/xcrun', [
    'swiftc',
    source,
    '-o',
    binary,
  ]);
  return binary;
}
export async function captureMacWindow(
  commands: MacCommands,
  binary: string,
  owner: MacProcess,
  app: string
) {
  const window = await waitFor(
    async () => {
      const result = await commands.checked('aqua-windows', binary, [String(owner.pid)]);
      const windows = JSON.parse(result.stdout) as {
        kCGWindowOwnerPID: number;
        kCGWindowNumber: number;
        kCGWindowBounds: { Width: number; Height: number };
      }[];
      return (
        windows.find(
          (window) => window.kCGWindowBounds.Width >= 300 && window.kCGWindowBounds.Height >= 200
        ) ?? null
      );
    },
    'visible native Mac application window',
    10_000
  );
  let current: MacProcess;
  try {
    current = await macOwner(commands, owner.pid, owner.command);
  } catch (error) {
    if (!(error instanceof MacProcessReadError)) throw error;
    current = await macOwner(commands, owner.pid, owner.command);
  }
  assert.deepEqual(current, owner, 'Native capture owner identity changed');
  const screenshot = path.join(commands.output, 'native-window.png');
  await commands.checked('capture-aqua-window', '/usr/sbin/screencapture', [
    '-x',
    '-l',
    String(window.kCGWindowNumber),
    screenshot,
  ]);
  assert((await stat(screenshot)).size > 1000, 'Native Aqua screenshot is empty');
  const readback = await commands.checked('native-capture-pixels', binary, ['--image', screenshot]);
  const pixels = JSON.parse(readback.stdout) as {
    width: number;
    height: number;
    distinctColors: number;
  };
  assert(
    pixels.width >= 300 && pixels.height >= 200 && pixels.distinctColors >= 32,
    'Native Aqua capture is blank or lacks actual painted content'
  );
  assert(owner.command.startsWith(`${app}/Contents/`));
  return { ...window, owner, screenshot, sha256: digest(await readFile(screenshot)), pixels };
}
