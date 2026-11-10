import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
      const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
      assert.ok(pid && ppid !== undefined && pgid);
      return { pid, ppid, pgid };
    });
}
export function groupMembers(group: number): ProcessIdentity[] {
  return processTable().filter((row) => row.pgid === group);
}
export function safeGroupSnapshot(group: number): (ProcessIdentity & { executable: string })[] {
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
export function assertOwnedCdpListener(group: number): number {
  // Limit descriptor inspection to the captured TEST group. A machine-wide
  // lsof scan for every UI read can time out under unrelated process load.
  const owned = groupMembers(group);
  assert.ok(owned.length > 0, 'captured TEST app group still exists');
  let output: string;
  try {
    output = execFileSync(
      '/usr/sbin/lsof',
      [
        '-nP',
        '-a',
        '-p',
        owned.map((row) => row.pid).join(','),
        `-iTCP:${selectedCdpPort}`,
        '-sTCP:LISTEN',
        '-t',
      ],
      { encoding: 'utf8', timeout: 10_000 }
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
      !/^\d+(?:\n\d+)*\n?$/.test(result.stdout) ||
      String(result.stderr ?? '').trim()
    )
      throw error;
    output = result.stdout;
  }
  const listeners = output.trim().split('\n').map(Number);
  assert.equal(new Set(listeners).size, 1, 'one CDP listener');
  const listener = listeners[0];
  assert.ok(
    groupMembers(group).some((row) => row.pid === listener),
    'CDP belongs to the captured TEST app process group'
  );
  return listener!;
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
