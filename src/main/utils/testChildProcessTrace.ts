import { channel } from 'node:diagnostics_channel';
import { errorMonitor, type EventEmitter } from 'node:events';
import { closeSync, constants, openSync, readSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';

type Birth = { startTicks: string; parentPid: number; processGroupId: number };
type ObservedChild = EventEmitter & { pid?: number; spawnfile?: string; spawnargs?: string[] };
type SyncResult = { pid: number; status: number | null; signal: string | null };
type TraceOptions = {
  mainPid: number;
  write(line: string): void;
  readBirth?(pid: number): Birth | null;
  limit?: number;
};
const PREFIX = '[TEST_MAIN_CHILD_PROCESS] ';
const MAX_EVENTS = 256;
const MAX_CHILDREN = 64;
const commands = new Set([
  'node', 'electron', 'ps', 'git', 'sh', 'bash', 'shell-env', 'opencode', 'claude',
  'codex', 'xdg-open', 'linux-node-exec', 'node-exec',
]);
const signals = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV', 'SIGHUP', 'SIGPIPE', 'SIGQUIT']);
const errors = new Set(['ENOENT', 'EACCES', 'EINVAL', 'EMFILE', 'ENFILE', 'EAGAIN', 'ENOSYS']);

function pid(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 0x7fffffff ? value : null;
}
function status(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && Math.abs(value) <= 0x7fffffff ? value : null;
}
function command(child: ObservedChild): string {
  const name = typeof child.spawnfile === 'string' ? basename(child.spawnfile) : '';
  return commands.has(name) ? name : 'other';
}

/** A bounded observation of proc metadata, never process ownership or signal authority. */
function readBirth(pidValue: number): Birth | null {
  let fd: number | undefined;
  try {
    fd = openSync('/proc/' + pidValue + '/stat', constants.O_RDONLY | constants.O_NOFOLLOW);
    const buffer = Buffer.alloc(4097), count = readSync(fd, buffer, 0, buffer.length, 0);
    if (count > 4096) return null;
    const text = buffer.toString('utf8', 0, count);
    if (!text.startsWith(String(pidValue) + ' (') || !text.endsWith('\n')) return null;
    const end = text.lastIndexOf(') ');
    if (end < 0) return null;
    const fields = text.slice(end + 2).trim().split(/\s+/u);
    if (!/^\d{1,20}$/u.test(fields[19] ?? '')) return null;
    const parentPid = pid(Number(fields[1])), processGroupId = pid(Number(fields[2]));
    return parentPid && processGroupId ? { startTicks: fields[19]!, parentPid, processGroupId } : null;
  } catch { return null; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* Observation only. */ } } }
}

/** TEST-only diagnostics. It neither intercepts launches nor adds a consuming error listener. */
export function createTestChildProcessTrace(options: TraceOptions) {
  const limit = Number.isInteger(options.limit) && options.limit! > 0
    ? Math.min(options.limit!, MAX_EVENTS) : MAX_EVENTS;
  const mainPid = pid(options.mainPid);
  let rows = 0, dropped = 0, observedChildren = 0, unobservedChildren = 0, failures = 0;
  let limited = false, childLimited = false, finished = false;
  const write = (value: Record<string, unknown>) => {
    try { options.write(PREFIX + JSON.stringify({ mainPid, ...value }) + '\n'); }
    catch { failures++; }
  };
  const emit = (value: Record<string, unknown>) => {
    if (finished) return;
    if (rows >= limit) {
      dropped++;
      if (!limited) { limited = true; write({ event: 'trace-limit', limit, droppedAtLeast: 1 }); }
      return;
    }
    rows++;
    write({ ...value, observedAtMs: Date.now() });
  };
  const safe = (operation: () => void) => { try { operation(); } catch { failures++; } };
  const birth = (childPid: number | null): Birth | null => {
    if (childPid === null) return null;
    const read = options.readBirth ?? readBirth;
    const before = read(childPid), after = read(childPid);
    return before && after && /^\d{1,20}$/u.test(before.startTicks) &&
      before.parentPid === mainPid && pid(before.processGroupId) !== null &&
      before.startTicks === after.startTicks && before.parentPid === after.parentPid &&
      before.processGroupId === after.processGroupId
      ? { startTicks: before.startTicks, parentPid: before.parentPid, processGroupId: before.processGroupId } : null;
  };
  const observe = (message: unknown) => safe(() => {
    if (finished) return;
    if (!message || typeof message !== 'object' || !('process' in message)) return;
    const child = message.process as ObservedChild;
    if (!child || typeof child.once !== 'function') return;
    if (rows >= limit || observedChildren >= MAX_CHILDREN) {
      unobservedChildren++;
      if (!childLimited) {
        childLimited = true;
        write({ event: 'trace-child-observation-limit', childLimit: MAX_CHILDREN, eventLimit: limit,
          reason: rows >= limit ? 'event-limit' : 'child-limit', unobservedAtLeast: 1 });
      }
      return;
    }
    observedChildren++;
    let originalPid: number | null = null;
    child.once('spawn', () => safe(() => {
      originalPid = pid(child.pid);
      let observedBirth: Birth | null = null;
      try { observedBirth = birth(originalPid); } catch { failures++; }
      emit({ event: 'async-spawn', pid: originalPid, requestedCommand: command(child),
        versionOnly: child.spawnargs?.length === 2 && child.spawnargs[1] === '--version',
        observedBirth, atomic: false });
    }));
    child.once('exit', (code: unknown, signal: unknown) => safe(() => {
      emit({ event: 'async-exit', pid: originalPid, status: status(code),
        signal: typeof signal === 'string' && signals.has(signal) ? signal : null });
    }));
    child.once(errorMonitor, (error: unknown) => safe(() => {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
      emit({ event: 'async-error', pid: originalPid, requestedCommand: command(child),
        code: typeof code === 'string' && errors.has(code) ? code : 'other' });
    }));
  });
  const sync = (result: SyncResult) => safe(() => {
    // spawnSync has already reaped this child. Never inspect a possibly reused PID.
    emit({ event: 'sync-result', requestedCommand: 'unix-process-table', pid: pid(result.pid),
      status: status(result.status), signal: result.signal && signals.has(result.signal) ? result.signal : null,
      observedBirth: null, atomic: false });
  });
  const finish = () => safe(() => {
    if (finished) return;
    finished = true;
    write({ event: 'trace-summary', rows, droppedObservations: dropped, observedChildren, unobservedChildren,
      observationFailures: failures, limited: limited || childLimited,
      coverage: 'node-async-and-unix-process-table-only' });
  });
  write({ event: 'trace-active', limit, childLimit: MAX_CHILDREN,
    coverage: 'node-async-and-unix-process-table-only' });
  return { observe, sync, finish };
}

let active: ReturnType<typeof createTestChildProcessTrace> | undefined;

/** Enabled only for explicit Linux Electron development TEST fixtures. */
export function installTestChildProcessTrace(): boolean {
  try {
    if (active) return true;
    const descriptor = process.env.AGENT_TEAMS_BACKEND_DESCRIPTOR_PATH;
    if (process.platform !== 'linux' || !process.versions.electron || !('type' in process) || process.type !== 'browser' ||
        process.env.NODE_ENV !== 'development' || process.env.LEGACY_DESKTOP_TEST_CHILD_TRACE !== '1' ||
        !descriptor || !isAbsolute(descriptor) || basename(descriptor) !== 'desktop-descriptor.json') return false;
    const root = dirname(descriptor);
    if (!/^TEST-desktop-backend-[A-Za-z0-9]+$/u.test(basename(root)) ||
        process.env.HOME !== join(root, 'home')) return false;
    const trace = createTestChildProcessTrace({ mainPid: process.pid, write(line) {
      const bytes = Buffer.from(line);
      if (writeSync(2, bytes) !== bytes.length) throw new Error('Incomplete TEST trace write');
    } });
    const events = channel('child_process');
    events.subscribe(trace.observe);
    active = trace;
    process.once('exit', () => {
      try { events.unsubscribe(trace.observe); trace.finish(); } catch { /* Observation only. */ }
    });
    return true;
  } catch { return false; }
}

/** Record only the result of the original synchronous ps call; never its output or error text. */
export function traceTestUnixProcessTableResult(result: SyncResult): void {
  try { active?.sync(result); } catch { /* Observation only. */ }
}
