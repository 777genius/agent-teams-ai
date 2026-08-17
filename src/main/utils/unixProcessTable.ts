import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';

export interface UnixProcessIdentity {
  pid: number;
  parentPid: number;
  processGroupId: number;
  startIdentity: string;
}

export function tryReadUnixProcessTable(): Map<number, UnixProcessIdentity> | null {
  try {
    return readUnixProcessTable(0);
  } catch {
    return null;
  }
}

export function readUnixProcessTable(rootPid: number): Map<number, UnixProcessIdentity> {
  try {
    const result = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
      throw new Error(`Failed to inspect Unix process tree ${rootPid}`);
    }

    const processes = new Map<number, UnixProcessIdentity>();
    for (const rawLine of result.stdout.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (!match) {
        throw new Error(`Unix process table omitted process birth identity for tree ${rootPid}`);
      }
      const pid = Number(match[1]);
      const startIdentity = readPreciseUnixProcessStartIdentity(pid, match[4].trim());
      if (startIdentity === null) continue;
      processes.set(pid, {
        pid,
        parentPid: Number(match[2]),
        processGroupId: Number(match[3]),
        startIdentity,
      });
    }
    if (processes.size === 0 && result.stdout.trim().length > 0) {
      throw new Error(`Unix process table omitted process birth identity for tree ${rootPid}`);
    }
    return processes;
  } catch (error) {
    throw new Error(`Failed to inspect Unix process tree ${rootPid}`, { cause: error });
  }
}

function readPreciseUnixProcessStartIdentity(pid: number, fallbackIdentity: string): string | null {
  if (process.platform !== 'linux') return `ps:${fallbackIdentity}`;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd < 0) throw new Error(`Malformed /proc/${pid}/stat`);
    const fieldsAfterCommand = stat
      .slice(commandEnd + 2)
      .trim()
      .split(/\s+/);
    const startTimeTicks = fieldsAfterCommand[19];
    if (!startTimeTicks || !/^\d+$/.test(startTimeTicks)) {
      throw new Error(`Missing start time in /proc/${pid}/stat`);
    }
    return `proc:${startTimeTicks}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function isSameUnixProcessIdentity(
  expected: UnixProcessIdentity,
  current: UnixProcessIdentity | undefined
): boolean {
  if (current === undefined || current.startIdentity !== expected.startIdentity) return false;
  if (current.processGroupId !== expected.processGroupId) {
    throw new Error(
      `Failed to verify Unix process ${expected.pid}: captured birth identity changed process groups`
    );
  }
  return true;
}
