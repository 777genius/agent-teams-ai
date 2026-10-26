import { constants } from 'node:fs';
import { open, opendir, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

type Identity = { pid: number; ppid: number; start: string };
type Options = {
  ownedLauncherPid: number;
  expectedEngineExecutable: string;
  expectedHome: string;
  expectedStateRoot: string;
};
const safeNames = new Set(
  'HOME USER LOGNAME USERPROFILE PATH TMPDIR TMP TEMP LANG SYSTEMROOT WINDIR COMSPEC PATHEXT APPDATA LOCALAPPDATA LC_ALL'.split(
    ' '
  )
);
const errnos = new Set('ENOENT ESRCH EACCES EPERM EIO EINVAL ENOTDIR ELOOP EOVERFLOW'.split(' '));
class Unavailable extends Error {}
const code = (error: unknown) =>
  error instanceof Unavailable
    ? error.message
    : errnos.has((error as NodeJS.ErrnoException)?.code ?? '')
      ? (error as NodeJS.ErrnoException).code!
      : 'UNAVAILABLE';

async function bounded(file: string, limit: number): Promise<Buffer> {
  const handle = await open(file, 'r');
  try {
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size <= limit) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, null);
      if (!bytesRead) return bytes.subarray(0, size);
      size += bytesRead;
    }
    throw new Unavailable('READ_LIMIT');
  } finally {
    await handle.close();
  }
}

async function identity(pid: number, base = `/proc/${pid}`): Promise<Identity> {
  const raw = (await bounded(`${base}/stat`, 8192)).toString('utf8');
  const end = raw.lastIndexOf(') ');
  const fields = raw
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  const ppid = Number(fields[1]);
  if (
    !raw.startsWith(`${pid} (`) ||
    end < 0 ||
    !Number.isSafeInteger(ppid) ||
    ppid < 0 ||
    !/^\d+$/.test(fields[19] ?? '') ||
    fields[0] === 'Z'
  )
    throw new Unavailable('INVALID_PROCESS');
  return { pid, ppid, start: fields[19]! };
}
const same = (a: Identity, b: Identity) =>
  a.pid === b.pid && a.ppid === b.ppid && a.start === b.start;

function environmentStats(bytes: Buffer, options: Options) {
  const lengths: Record<string, number[]> = {};
  const counts = new Map<string, number>();
  const localeLengths: number[] = [];
  let allowedBytesWithNuls = 0;
  let pathComponents = 0;
  let homeMatchesExpected = false;
  let stateRootMatchesExpected = false;
  let stateRoots = 0;
  let allowedEntries = 0;
  for (let offset = 0; offset < bytes.length; ) {
    const end = bytes.indexOf(0, offset);
    if (end < 0) throw new Unavailable('INVALID_ENVIRONMENT');
    const entry = bytes.subarray(offset, end);
    offset = end + 1;
    const equals = entry.indexOf(61);
    if (equals < 1) continue;
    const name = entry.subarray(0, equals).toString('utf8').toUpperCase();
    const value = entry.subarray(equals + 1);
    if (name === 'HOME') homeMatchesExpected = value.equals(Buffer.from(options.expectedHome));
    if (name === 'AGENTPLUGINS_HOME') {
      stateRoots++;
      stateRootMatchesExpected = value.equals(Buffer.from(options.expectedStateRoot));
    }
    if (!safeNames.has(name) && !name.startsWith('LC_')) continue;
    if (++allowedEntries > 256) throw new Unavailable('ENVIRONMENT_ENTRY_LIMIT');
    counts.set(name, (counts.get(name) ?? 0) + 1);
    allowedBytesWithNuls += Buffer.byteLength(name) + value.length + 2;
    if (safeNames.has(name)) (lengths[name] ??= []).push(value.length);
    else localeLengths.push(value.length);
    if (name === 'PATH') pathComponents = 1 + value.filter((byte) => byte === 58).length;
  }
  const duplicates = [...counts].filter(([, count]) => count > 1).map(([name]) => name);
  return {
    rawEnvironmentBytes: bytes.length,
    allowedEntryBytesWithNuls: allowedBytesWithNuls,
    totalBasis: 'allowed canonical entries including duplicates; before generated Claude overrides',
    valueBytes: lengths,
    otherLocaleValueBytes: localeLengths,
    duplicateNames: duplicates.filter((name) => safeNames.has(name)),
    otherLocaleDuplicateNames: duplicates.filter((name) => !safeNames.has(name)).length,
    pathComponents,
    homeMatchesExpected: homeMatchesExpected && counts.get('HOME') === 1,
    stateRootMatchesExpected: stateRootMatchesExpected && stateRoots === 1,
  };
}

async function taskStats(base: string) {
  let observed = 0;
  let readable = 0;
  let limited = false;
  const failures: Record<string, number> = {};
  for await (const entry of await opendir(`${base}/task`)) {
    if (!/^\d+$/.test(entry.name)) continue;
    if (observed === 128) {
      limited = true;
      break;
    }
    observed++;
    try {
      const handle = await open(`${base}/task/${entry.name}/children`, 'r');
      try {
        await handle.read(Buffer.alloc(1), 0, 1, 0);
        readable++;
      } finally {
        await handle.close();
      }
    } catch (error) {
      const errno = code(error);
      failures[errno] = (failures[errno] ?? 0) + 1;
    }
  }
  return { observed, readable, limited, failures };
}

/** Failure-only metadata for owned pinned engine processes; never a readiness proof. */
export async function captureOwnedUapProcessMetadata(
  options: Options
): Promise<Record<string, unknown>> {
  if (process.platform !== 'linux') return { status: 'unavailable', code: 'UNSUPPORTED_PLATFORM' };
  try {
    if (
      !Number.isSafeInteger(options.ownedLauncherPid) ||
      options.ownedLauncherPid <= 0 ||
      !isAbsolute(options.expectedEngineExecutable)
    )
      throw new Unavailable('INVALID_INPUT');
    const launcher = await identity(options.ownedLauncherPid);
    if (launcher.ppid !== process.pid) throw new Unavailable('LAUNCHER_NOT_OWNED');
    const executable = await realpath(options.expectedEngineExecutable);
    const table = new Map<number, Identity>();
    const deadline = Date.now() + 5000;
    let scanned = 0;
    for await (const entry of await opendir('/proc')) {
      if (++scanned > 4096 || Date.now() > deadline) throw new Unavailable('PROCESS_SCAN_LIMIT');
      if (!/^\d+$/.test(entry.name)) continue;
      const pid = Number(entry.name);
      try {
        table.set(pid, await identity(pid));
      } catch {
        /* Disappearing/unreadable PIDs cannot establish ancestry. */
      }
    }
    const chains: Identity[][] = [];
    for (const item of table.values()) {
      const chain: Identity[] = [];
      let current: Identity | undefined = item;
      while (
        current &&
        chain.length < 64 &&
        !chain.some((ancestor) => ancestor.pid === current!.pid)
      ) {
        chain.push(current);
        if (same(current, launcher)) {
          chains.push(chain);
          break;
        }
        const parent = table.get(current.ppid);
        current = parent && BigInt(parent.start) <= BigInt(current.start) ? parent : undefined;
      }
    }
    const processes: Record<string, unknown>[] = [];
    let limited = false;
    for (const chain of chains) {
      const candidate = chain[0]!;
      const directory = await open(
        `/proc/${candidate.pid}`,
        constants.O_RDONLY | constants.O_DIRECTORY
      ).catch(() => null);
      if (!directory) continue;
      const base = `/proc/self/fd/${directory.fd}`; // Pin proc inode across PID reuse.
      let matched = false;
      try {
        if ((await realpath(`${base}/exe`)) !== executable) continue;
        if (processes.length === 8) {
          limited = true;
          break;
        }
        matched = true;
        const verify = async () => {
          if (
            !same(await identity(candidate.pid, base), candidate) ||
            (await realpath(`${base}/exe`)) !== executable
          )
            throw new Unavailable('PROCESS_CHANGED');
          for (const member of chain)
            if (!same(await identity(member.pid), member))
              throw new Unavailable('ANCESTRY_CHANGED');
        };
        await verify();
        const environment = environmentStats(await bounded(`${base}/environ`, 128 * 1024), options);
        const tasks = await taskStats(base);
        await verify();
        processes.push({
          status: 'observed',
          pid: candidate.pid,
          startTime: candidate.start,
          ancestryDepth: chain.length,
          environment,
          tasks,
        });
      } catch (error) {
        if (matched) processes.push({ status: 'unavailable', code: code(error) });
      } finally {
        await directory.close();
      }
    }
    const observed = processes.some((item) => item.status === 'observed');
    return {
      status: observed ? 'observed' : 'unavailable',
      ...(observed ? {} : { code: 'NO_STABLE_OWNED_ENGINE' }),
      processScope: 'owned pinned executable descendants; may include supervisors',
      limited,
      processes,
    };
  } catch (error) {
    return { status: 'unavailable', code: code(error) };
  }
}
