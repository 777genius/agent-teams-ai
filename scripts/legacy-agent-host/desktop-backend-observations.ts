import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, openSync, readlinkSync, readSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { basename, join } from 'node:path';
import { fileDigest } from './desktop-backend-fixture.ts';

export interface ProcessIdentity {
  pid: number;
  ppid: number;
  pgid: number;
}
export const selectedCdpPort = Number(process.env.LEGACY_DESKTOP_CDP_PORT ?? 9222);
assert.ok(Number.isInteger(selectedCdpPort) && selectedCdpPort >= 1024 && selectedCdpPort <= 65535);
/** Preserve explicit TEST admission before even probing the selected renderer port. */
export function assertDesktopProofEnvironment(linuxModeAllowed: boolean): void {
  assert.equal(process.env.LEGACY_DESKTOP_BACKEND_GO, '1', 'root must authorize actual pnpm dev:mcp launch');
  assert.ok(process.platform === 'darwin' ||
    (process.platform === 'linux' && process.arch === 'x64' && linuxModeAllowed),
    'Linux Desktop portability requires an explicitly bounded proof mode');
  if (process.platform === 'linux') {
    assert.match(process.env.LEGACY_DESKTOP_TEST_DISPLAY ?? '', /^:\d+$/u, 'explicit isolated TEST X display');
    assert.ok(process.env.LEGACY_DESKTOP_TEST_XAUTHORITY, 'explicit TEST display authorization file');
  }
}

/** Diagnostics only: no raw message, values, environment, causes or outside-source stack. */
export function projectDesktopHarnessFailure(value: unknown, repository: string, sources: readonly string[]): {
  kind: 'assertion' | 'error' | 'unclassified'; frames: string[];
} {
  try {
    if (!(value instanceof Error)) return { kind: 'unclassified', frames: [] };
    const prefix = repository.replaceAll('\\', '/').replace(/\/+$/u, '') + '/';
    const allowed = new Set(sources.filter(path =>
      /^(?:scripts\/legacy-agent-host\/|packages\/legacy-agent-host\/(?:src|dist|tests)\/)[A-Za-z0-9._/-]+\.(?:[cm]?[jt]s)$/u.test(path) &&
      !path.split('/').some(part => part === '.' || part === '..')));
    const frames: string[] = [];
    for (const line of (typeof value.stack === 'string' ? value.stack.slice(0, 16 * 1024) : '').split('\n').slice(1, 40)) {
      if (!/^\s+at /u.test(line)) continue;
      const frameText = line.trimStart().slice(3).replaceAll('\\', '/');
      const boundary = frameText.lastIndexOf(' (');
      let location = boundary >= 0 && frameText.endsWith(')')
        ? frameText.slice(boundary + 2, -1) : frameText.replace(/^async /u, '');
      location = location.replace(/^file:\/\//u, '');
      if (/^[A-Za-z]:\//u.test(prefix) && /^\/[A-Za-z]:\//u.test(location)) location = location.slice(1);
      if (!location.startsWith(prefix)) continue;
      const match = /^(.+):([1-9]\d{0,5}):([1-9]\d{0,5})$/u.exec(location.slice(prefix.length));
      if (!match || !allowed.has(match[1]!)) continue;
      const frame = match[1] + ':' + match[2] + ':' + match[3];
      if (!frames.includes(frame)) frames.push(frame);
      if (frames.length === 6) break;
    }
    return { kind: value.name === 'AssertionError' ? 'assertion' : 'error', frames };
  } catch { return { kind: 'unclassified', frames: [] }; }
}

export async function portOccupied(port = selectedCdpPort): Promise<boolean> {
  return new Promise<boolean>((done) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => {
      socket.destroy();
      done(false);
    });
    socket.setTimeout(1000, () => {
      socket.destroy();
      done(true);
    });
  });
}
export function processTable(): ProcessIdentity[] {
  return execFileSync('/bin/ps', ['-ax', '-o', 'pid=,ppid=,pgid='], {
    encoding: 'utf8',
    timeout: 3000,
  })
    .trim()
    .split('\n')
    .map((line) => {
      const fields = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/u.exec(line);
      assert.ok(fields, 'Malformed process table row');
      const pid = Number(fields[1]), ppid = Number(fields[2]), pgid = Number(fields[3]);
      // Linux kernel processes may have PGID 0; they are visible but never an owned app group.
      assert.ok(Number.isSafeInteger(pid) && pid > 0 &&
        Number.isSafeInteger(ppid) && ppid >= 0 &&
        Number.isSafeInteger(pgid) && pgid >= 0, 'Invalid process table identity');
      return { pid, ppid, pgid };
    });
}
export function groupMembers(group: number): ProcessIdentity[] {
  assert.ok(Number.isSafeInteger(group) && group > 0, 'Captured app group must be positive');
  return processTable().filter((row) => row.pgid === group);
}
export function safeGroupSnapshot(group: number): (ProcessIdentity & { executable: string })[] {
  assert.ok(Number.isSafeInteger(group) && group > 0, 'Captured app group must be positive');
  const rows = execFileSync('/bin/ps', ['-ax', '-o', 'pid=,ppid=,pgid=,comm='], {
    encoding: 'utf8',
    timeout: 3000,
  });
  return rows
    .trim()
    .split('\n')
    .flatMap((line) => {
      const parsed = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (!parsed || Number(parsed[3]) !== group) return [];
      return [
        {
          pid: Number(parsed[1]),
          ppid: Number(parsed[2]),
          pgid: Number(parsed[3]),
          executable: basename(parsed[4]!),
        },
      ];
    });
}

export function command(pid: number): string {
  try {
    return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 3000,
    }).trim();
  } catch (error) {
    const result = error as { status?: number; stdout?: unknown; stderr?: unknown };
    // A short-lived child may exit between the group census and its argv read.
    // No matching identity is inferred; all other ps failures still retain debt.
    if (
      result.status === 1 &&
      String(result.stdout ?? '').trim() === '' &&
      String(result.stderr ?? '').trim() === ''
    )
      return '';
    throw error;
  }
}

interface CdpListenerFile {
  pid: number;
  fd: string;
  family: 'IPv4' | 'IPv6' | 'unknown';
  inode: string | null;
  device: string | null;
  endpoint: 'loopback-v4' | 'loopback-v6' | 'wildcard' | 'other' | 'unknown';
  state: 'LISTEN' | 'other' | 'unknown';
  afterCensus?: CdpProcFacts;
}
type CdpRole = 'electron-main' | 'electron-renderer' | 'electron-zygote' | 'electron-gpu' |
  'electron-utility' | 'electron-crashpad' | 'node' | 'unknown';
interface ProcBirth { startTicks: string; ppid: number; pgid: number; }
interface CdpProcFacts {
  scope: 'after-original-census'; atomic: false; birth: 'same' | 'unknown';
  startTicks: string | null; ppid: number | null; pgid: number | null;
  role: CdpRole; socketInode: string | null;
}
/** Bounded TEST diagnostics; proc data never admits a listener or authorizes a signal. */
function boundedProcText(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const buffer = Buffer.alloc(4097);
    const count = readSync(fd, buffer, 0, buffer.length, 0);
    return count <= 4096 ? buffer.toString('utf8', 0, count) : undefined;
  } catch { return undefined; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* Diagnostic only. */ } } }
}
function readProcBirth(pid: number): ProcBirth | undefined {
  const value = boundedProcText(`/proc/${pid}/stat`);
  if (!value?.startsWith(`${pid} (`) || !value.endsWith('\n')) return undefined;
  const end = value.lastIndexOf(') ');
  if (end < 0) return undefined;
  const fields = value.slice(end + 2).trim().split(/\s+/u);
  if (!/^[A-Za-z]$/u.test(fields[0] ?? '') || !/^\d{1,16}$/u.test(fields[1] ?? '') ||
      !/^\d{1,16}$/u.test(fields[2] ?? '') || !/^\d{1,20}$/u.test(fields[19] ?? '')) return undefined;
  const ppid = Number(fields[1]), pgid = Number(fields[2]);
  return Number.isSafeInteger(ppid) && Number.isSafeInteger(pgid)
    ? { ppid, pgid, startTicks: fields[19]! } : undefined;
}
function captureProcBirths(owned: readonly ProcessIdentity[]): Map<number, ProcBirth> {
  const captured = new Map<number, ProcBirth>();
  for (const row of owned.slice(0, 64)) {
    const birth = readProcBirth(row.pid);
    if (birth?.pgid === row.pgid && birth.ppid === row.ppid) captured.set(row.pid, birth);
  }
  return captured;
}
function readProcRole(pid: number): CdpRole {
  const commandLine = boundedProcText(`/proc/${pid}/cmdline`);
  if (!commandLine?.endsWith('\0')) return 'unknown';
  const args = commandLine.split('\0'), executable = basename(args[0]!);
  if (executable === 'node') return 'node';
  if (executable === 'chrome_crashpad_handler') return 'electron-crashpad';
  if (!['electron', 'agent-teams-ai', 'Agent Teams AI'].includes(executable)) return 'unknown';
  const type = args.find(arg => arg.startsWith('--type='));
  if (type === undefined) return 'electron-main';
  if (type === '--type=renderer') return 'electron-renderer';
  if (type === '--type=zygote') return 'electron-zygote';
  if (type === '--type=gpu-process') return 'electron-gpu';
  if (type === '--type=utility') return 'electron-utility';
  return 'unknown';
}
function afterCdpCensus(file: CdpListenerFile, group: number, original?: ProcBirth): CdpProcFacts {
  const unknown: CdpProcFacts = { scope: 'after-original-census', atomic: false, birth: 'unknown',
    startTicks: null, ppid: null, pgid: null, role: 'unknown', socketInode: null };
  if (!original) return unknown;
  try {
    const before = readProcBirth(file.pid);
    if (!before || before.startTicks !== original.startTicks || before.pgid !== group) return unknown;
    const target = readlinkSync(`/proc/${file.pid}/fd/${file.fd}`);
    const inode = /^socket:\[(\d{1,20})\]$/u.exec(target)?.[1] ?? null;
    const role = readProcRole(file.pid), after = readProcBirth(file.pid);
    if (!after || after.startTicks !== original.startTicks || after.pgid !== group) return unknown;
    // The fd may still have changed between the original lsof and this observation.
    return { scope: 'after-original-census', atomic: false, birth: 'same', startTicks: after.startTicks,
      ppid: after.ppid, pgid: after.pgid, role, socketInode: inode };
  } catch { return unknown; }
}
interface CdpListenerFacts {
  scope: 'original-linux-lsof-test-cdp';
  port: number;
  holderCount: number;
  fileCount: number;
  truncated: boolean;
  files: CdpListenerFile[];
}
interface CdpFixtureCorrelation {
  pid: number; fd: string; scope: 'after-failed-census'; atomic: false;
  birth: 'same' | 'unknown'; socket: 'same-as-supplemental' | 'unknown';
  fixtureHostArgv: boolean | null; fixtureNodeExecutable: boolean | null;
  closeOnExec: boolean | null;
}
type CdpFixtureSelection = { node: string; hostEntry: string };
const cdpListenerFailures = new WeakMap<Error, CdpListenerFacts>();
const cdpFixtureFailures = new WeakMap<Error, CdpListenerFacts & {
  fixtureCorrelation: CdpFixtureCorrelation[];
}>();

/** Path comparison only: never executable attestation, socket admission or signal authority. */
function correlateCdpFixture(file: CdpListenerFile, fixture: CdpFixtureSelection): CdpFixtureCorrelation {
  const unknown: CdpFixtureCorrelation = { pid: file.pid, fd: file.fd,
    scope: 'after-failed-census', atomic: false, birth: 'unknown', socket: 'unknown',
    fixtureHostArgv: null, fixtureNodeExecutable: null, closeOnExec: null };
  const original = file.afterCensus;
  if (original?.birth !== 'same' || !original.socketInode) return unknown;
  const sameBirth = (value: ProcBirth | undefined) => value !== undefined &&
    value.startTicks === original.startTicks && value.pgid === original.pgid && value.ppid === original.ppid;
  try {
    if (!sameBirth(readProcBirth(file.pid))) return unknown;
    const socket = `socket:[${original.socketInode}]`;
    const path = `/proc/${file.pid}/fd/${file.fd}`;
    if (readlinkSync(path) !== socket) return unknown;
    const argv = boundedProcText(`/proc/${file.pid}/cmdline`);
    const executable = readlinkSync(`/proc/${file.pid}/exe`);
    const info = boundedProcText(`/proc/${file.pid}/fdinfo/${file.fd}`);
    const flags = info?.split('\n').filter(line => line.startsWith('flags:')) ?? [];
    const octal = flags.length === 1 ? /^flags:\t(0[0-7]{1,10})$/u.exec(flags[0]!)?.[1] : undefined;
    const numeric = octal === undefined ? undefined : BigInt('0o' + octal);
    const closeOnExec = numeric === undefined || numeric > 0xffffffffn
      ? null : (numeric & 0o2000000n) !== 0n;
    const fixtureHostArgv = argv?.endsWith('\0')
      ? argv === fixture.node + '\0' + fixture.hostEntry + '\0' : null;
    if (readlinkSync(path) !== socket || !sameBirth(readProcBirth(file.pid))) return unknown;
    return { ...unknown, birth: 'same', socket: 'same-as-supplemental',
      fixtureHostArgv, fixtureNodeExecutable: executable === fixture.node, closeOnExec };
  } catch { return unknown; }
}

/** Original error facts plus, at most once, a separately labelled comparison to captured TEST paths. */
export function readOwnedCdpListenerFailure(
  value: unknown, fixture?: CdpFixtureSelection
): (CdpListenerFacts & { fixtureCorrelation?: CdpFixtureCorrelation[] }) | undefined {
  if (!(value instanceof Error)) return undefined;
  const facts = cdpListenerFailures.get(value);
  if (!facts || !fixture) return facts;
  const previous = cdpFixtureFailures.get(value);
  if (previous) return previous;
  const projected = { ...facts, fixtureCorrelation: facts.files.map(file => correlateCdpFixture(file, fixture)) };
  cdpFixtureFailures.set(value, projected);
  return projected;
}
function parseLinuxCdpListeners(output: string): { listeners: number[]; facts: CdpListenerFacts } {
  const pids = new Set<number>(), withFiles = new Set<number>();
  const files: CdpListenerFile[] = [];
  let pid: number | undefined, current: CdpListenerFile | undefined, fileCount = 0;
  const finish = () => {
    if (!current) return;
    withFiles.add(current.pid); fileCount++;
    if (files.length < 16) files.push(current);
    current = undefined;
  };
  assert.ok(output.endsWith('\n'), 'Complete original lsof machine output');
  for (const line of output.slice(0, -1).split('\n')) {
    assert.ok(line.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(line), 'Bounded lsof field');
    if (/^p[1-9]\d{0,15}$/u.test(line)) {
      finish(); pid = Number(line.slice(1));
      assert.ok(Number.isSafeInteger(pid), 'Valid lsof PID'); pids.add(pid);
    } else if (/^f\d{1,9}$/u.test(line)) {
      finish(); assert.ok(pid !== undefined, 'lsof descriptor has its original holder');
      current = { pid, fd: line.slice(1), family: 'unknown', inode: null, device: null,
        endpoint: 'unknown', state: 'unknown' };
    } else {
      assert.ok(current, 'lsof field has its original descriptor');
      if (line === 'tIPv4' || line === 'tIPv6') current.family = line === 'tIPv4' ? 'IPv4' : 'IPv6';
      else if (/^i\d{1,20}$/u.test(line)) current.inode = line.slice(1);
      else if (/^D0x[0-9a-f]{1,16}$/iu.test(line)) current.device = line.slice(1);
      else if (line === 'PTCP') { /* The query already selects only TCP LISTEN descriptors. */ }
      else if (/^TST=[A-Z_]{1,24}$/u.test(line)) current.state = line === 'TST=LISTEN' ? 'LISTEN' : 'other';
      else if (line.startsWith('n')) {
        const endpoint = line.slice(1);
        current.endpoint = endpoint === `127.0.0.1:${selectedCdpPort}` ? 'loopback-v4'
          : endpoint === `[::1]:${selectedCdpPort}` ? 'loopback-v6'
          : [`*:${selectedCdpPort}`, `0.0.0.0:${selectedCdpPort}`, `[::]:${selectedCdpPort}`].includes(endpoint)
            ? 'wildcard' : 'other';
      } else assert.fail('Unexpected lsof machine field');
    }
  }
  finish();
  assert.ok(pids.size > 0 && pids.size === withFiles.size, 'Positive original lsof descriptor census');
  return { listeners: [...pids], facts: { scope: 'original-linux-lsof-test-cdp', port: selectedCdpPort,
    holderCount: pids.size, fileCount, truncated: fileCount > files.length, files } };
}
export function assertOwnedCdpListener(group: number): number {
  // Limit descriptor inspection to the captured TEST group. A machine-wide
  // lsof scan for every UI read can time out under unrelated process load.
  const owned = groupMembers(group);
  assert.ok(owned.length > 0, 'captured TEST app group still exists');
  const births = process.platform === 'linux' ? captureProcBirths(owned) : undefined;
  let output: string;
  try {
    output = execFileSync(
      process.platform === 'linux' ? '/usr/bin/lsof' : '/usr/sbin/lsof',
      [
        '-nP',
        '-a',
        '-p',
        owned.map((row) => row.pid).join(','),
        `-iTCP:${selectedCdpPort}`,
        '-sTCP:LISTEN',
        ...(process.platform === 'linux' ? ['-w', '-FpfDtinPT', '-Ts'] : ['-t']),
      ],
      { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 }
    );
  } catch (error) {
    const result = error as {
      status?: number;
      signal?: string | null;
      stdout?: unknown;
      stderr?: unknown;
    };
    // lsof returns1 when any selected short-lived child is already gone,
    // even while stdout contains the matching live listener. Accept only
    // that positive observation; timeout, diagnostics and no match still fail.
    if (
      result.status !== 1 ||
      result.signal ||
      typeof result.stdout !== 'string' ||
      !(process.platform === 'linux' ? /^p[1-9]\d*\n/u.test(result.stdout)
        : /^\d+(?:\n\d+)*\n?$/.test(result.stdout)) ||
      String(result.stderr ?? '').trim()
    )
      throw error;
    output = result.stdout;
  }
  const census = process.platform === 'linux' ? parseLinuxCdpListeners(output) : undefined;
  const listeners = census?.listeners ?? output.trim().split('\n').map(Number);
  try {
    assert.equal(new Set(listeners).size, 1, 'one CDP listener');
    const listener = listeners[0];
    assert.ok(
      groupMembers(group).some((row) => row.pid === listener),
      'CDP belongs to the captured TEST app process group'
    );
    return listener!;
  } catch (error) {
    if (census && error instanceof Error) {
      for (const file of census.facts.files) {
        if (file.inode === null) file.afterCensus = afterCdpCensus(file, group, births?.get(file.pid));
      }
      cdpListenerFailures.set(error, census.facts);
    }
    throw error;
  }
}
export async function compiledBundleHashes(
  directory: string,
  prefix = ''
): Promise<{ path: string; sha256: string }[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const result: { path: string; sha256: string }[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory())
      result.push(...(await compiledBundleHashes(join(directory, entry.name), relative)));
    else if (entry.isFile() && /\.(?:cjs|js)$/.test(entry.name))
      result.push({ path: relative, sha256: await fileDigest(join(directory, entry.name)) });
  }
  return result;
}

export async function getTargets(): Promise<Record<string, unknown>[]> {
  const response = await fetch(`http://127.0.0.1:${selectedCdpPort}/json/list`, {
    signal: AbortSignal.timeout(1500),
  });
  assert.equal(response.ok, true);
  const body: unknown = await response.json();
  assert.ok(Array.isArray(body));
  return body.map((value) => {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    return value as Record<string, unknown>;
  });
}

/** Only initial discovery is repeatable across navigation; product commands never use this retry seam. */
export async function readRendererBackendConnections(
  cdp: {
    evaluate(expression: string, timeoutMs?: number): Promise<unknown>;
  },
  timeoutMs?: number
): Promise<
  | { kind: 'pending'; reason: 'bridge-not-ready' | 'context-replaced' | 'handler-not-ready' }
  | { kind: 'read'; value: unknown }
> {
  const deadline = timeoutMs === undefined ? undefined : performance.now() + timeoutMs;
  const remaining = () => {
    if (deadline === undefined) return undefined;
    const value = Math.floor(deadline - performance.now());
    assert.ok(value > 0, 'initial backend discovery observation deadline');
    return value;
  };
  try {
    if (
      !(await cdp.evaluate(
        'Boolean(window.electronAPI?.agentBackend?.getConnections)',
        remaining()
      ))
    )
      return { kind: 'pending', reason: 'bridge-not-ready' };
    return {
      kind: 'read',
      value: await cdp.evaluate('window.electronAPI.agentBackend.getConnections()', remaining()),
    };
  } catch (error) {
    if (
      /execution context was destroyed|cannot find (?:default )?execution context|cannot find context with specified id/i.test(
        String(error)
      )
    )
      return { kind: 'pending', reason: 'context-replaced' };
    if (/No handler registered for ['"]?agentBackend:connections/.test(String(error)))
      return { kind: 'pending', reason: 'handler-not-ready' };
    throw error;
  }
}

/** A just-exited child may be visible as a zombie until Node processes its exit event. */
export async function settledGroupMembers(
  group: number,
  until = Date.now() + 3000
): Promise<ProcessIdentity[]> {
  let members = groupMembers(group);
  while (members.some((row) => row.pid === group) && Date.now() < until) {
    let state: string;
    try {
      state = execFileSync('/bin/ps', ['-p', String(group), '-o', 'stat='], {
        encoding: 'utf8',
        timeout: 3000,
      }).trim();
    } catch {
      return groupMembers(group);
    }
    if (!state.startsWith('Z')) break;
    // Observation only. Never signal a zombie or accept a changed command identity.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    members = groupMembers(group);
  }
  return members;
}

/**
 * macOS ps shows a just-exited Node child as "(node)" or "<defunct>" instead of its original
 * command. Authorize TEST process-group cleanup only while the captured leader
 * is still an unreaped zombie owned by this exact harness. A changed live
 * process, PID reuse, or an orphaned group must never pass this guard.
 */
export function isCapturedOriginalNodeZombie(input: {
  expectedIdentity: string;
  observedIdentity: string;
  state: string;
  childPid: number | undefined;
  group: number;
  leader: ProcessIdentity | undefined;
  parentPid: number;
  platform?: NodeJS.Platform;
}): boolean {
  if ((input.platform ?? process.platform) !== 'darwin') return false;
  if (!Number.isSafeInteger(input.group) || input.group <= 0 || input.childPid !== input.group)
    return false;
  if (
    input.leader?.pid !== input.group ||
    input.leader.ppid !== input.parentPid ||
    input.leader.pgid !== input.group ||
    !input.state.startsWith('Z')
  )
    return false;
  const expression =
    /^([A-Za-z]{3} [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})\s+(.+)$/;
  const expected = expression.exec(input.expectedIdentity);
  const observed = expression.exec(input.observedIdentity);
  if (!expected || !observed || expected[1] !== observed[1]) return false;
  // The original packed app has a different macOS zombie display name than
  // the dev Node wrapper. Bind that exception to its exact captured invocation.
  const originalNode =
    (observed[2] === '(node)' || observed[2] === '<defunct>') &&
    /(?:^|\/)node\s+/.test(expected[2]!) &&
    /(?:^|\s)dev:mcp(?:\s|$)/.test(expected[2]!);
  const originalPackedApp =
    observed[2] === '(Agent Teams AI)' &&
    /(?:^|\/)Agent Teams AI\.app\/Contents\/MacOS\/Agent Teams AI --remote-debugging-port=9222$/.test(expected[2]!);
  return originalNode || originalPackedApp;
}

interface OriginalAppReapInput {
  child: { pid?: number; exitCode: number | null; signalCode: NodeJS.Signals | null };
  group: number;
  hostPid: number;
  initialMembers: readonly ProcessIdentity[];
  expectedIdentity: string;
  observedIdentity: string;
  /** The same deadline captured before the initial settledGroupMembers call. */
  deadline: number;
}

/** Read-only absence observation after this exact child has already exited naturally. */
export async function observeExitedAppGroup(
  input: Pick<OriginalAppReapInput, 'child' | 'group' | 'hostPid' | 'initialMembers' | 'deadline'>,
  readTable: () => ProcessIdentity[] = processTable
) {
  const initialMembers = input.initialMembers.map((member) => ({ ...member }));
  let remaining: ProcessIdentity[] | null = null;
  let capturedHostAbsent: boolean | null = null;
  let capturedDescendantsAbsent: boolean | null = null;
  const result = (settled: boolean, reason: string) => ({
    settled, reason, initialMembers, remaining, capturedHostAbsent, capturedDescendantsAbsent,
    appExitCode: input.child.exitCode, appSignalCode: input.child.signalCode,
  });
  if (
    !Number.isSafeInteger(input.group) || input.group <= 0 || input.child.pid !== input.group ||
    input.child.exitCode !== 0 || input.child.signalCode !== null ||
    !Number.isSafeInteger(input.hostPid) || input.hostPid <= 0 || input.hostPid === input.group ||
    !Number.isFinite(input.deadline) || initialMembers.length === 0 ||
    initialMembers.some((member) => member.pid === input.group || member.pgid !== input.group)
  ) return result(false, 'ineligible-original-natural-exit-observation');

  while (Date.now() < input.deadline) {
    let table: ProcessIdentity[];
    try { table = readTable(); }
    catch { return result(false, 'process-table-unavailable'); }
    remaining = table.filter((member) => member.pgid === input.group);
    capturedHostAbsent = !table.some((member) => member.pid === input.hostPid);
    capturedDescendantsAbsent = initialMembers.every((original) =>
      !table.some((member) => member.pid === original.pid));
    if (Date.now() >= input.deadline) break;
    if (table.some((member) => member.pid === input.group))
      return result(false, 'captured-leader-pid-reappeared');
    if (remaining.length === 0 && capturedHostAbsent && capturedDescendantsAbsent)
      return result(true, 'original-natural-exit-and-fresh-absence');
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(100, Math.max(0, input.deadline - Date.now())))
    );
  }
  return result(false, 'original-observation-deadline');
}

/** Observations only after a refused signal guard; this function has no signal capability. */
export async function observeOriginalAppReap(
  input: OriginalAppReapInput,
  readTable: () => ProcessIdentity[] = processTable
) {
  const initial = {
    members: input.initialMembers.map((member) => ({ ...member })),
    expectedIdentity: input.expectedIdentity,
    observedIdentity: input.observedIdentity,
    appExitCode: input.child.exitCode,
    appSignalCode: input.child.signalCode,
  };
  let remaining: ProcessIdentity[] | null = null;
  let capturedHostAbsent: boolean | null = null;
  const result = (settled: boolean, reason: string) => ({
    settled,
    reason,
    initial,
    remaining,
    capturedHostAbsent,
    appExitCode: input.child.exitCode,
    appSignalCode: input.child.signalCode,
  });
  const identity = /^([A-Za-z]{3} [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})\s+(.+)$/;
  const expected = identity.exec(input.expectedIdentity);
  const observed = identity.exec(input.observedIdentity);
  if (
    !Number.isSafeInteger(input.group) ||
    input.group <= 0 ||
    input.child.pid !== input.group ||
    !Number.isSafeInteger(input.hostPid) ||
    input.hostPid <= 0 ||
    input.hostPid === input.group ||
    !Number.isFinite(input.deadline) ||
    !expected ||
    !observed ||
    expected[1] !== observed[1] ||
    expected[2] === '<defunct>' ||
    observed[2] !== '<defunct>' ||
    initial.members.length !== 1 ||
    initial.members[0]!.pid !== input.group ||
    initial.members[0]!.pgid !== input.group
  )
    return result(false, 'ineligible-original-defunct-observation');

  while (Date.now() < input.deadline) {
    if (
      input.child.signalCode !== null ||
      (input.child.exitCode !== null && input.child.exitCode !== 0)
    )
      return result(false, 'original-child-exit-not-natural-zero');
    let table: ProcessIdentity[];
    try {
      table = readTable();
    } catch {
      return result(false, 'process-table-unavailable');
    }
    remaining = table.filter((member) => member.pgid === input.group);
    capturedHostAbsent = !table.some((member) => member.pid === input.hostPid);
    if (Date.now() >= input.deadline) break;
    if (remaining.some((member) => member.pid !== input.group) || !capturedHostAbsent)
      return result(false, 'captured-processes-remain');
    if (input.child.exitCode === 0 && input.child.signalCode === null) {
      if (remaining.length) return result(false, 'captured-processes-remain');
      return result(true, 'original-natural-exit-and-fresh-absence');
    }
    // A vanished numeric PID alone never substitutes for this ChildProcess's exit observation.
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(100, Math.max(0, input.deadline - Date.now())))
    );
  }
  return result(false, 'original-observation-deadline');
}
