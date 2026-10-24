// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPackagedSmokeOwnership } from '../../../scripts/electron-builder/packagedSmokeOwnedProcesses.ts';

// Hermetic Darwin ps model. Apple's ps appends the environment to argv, and a
// retiring helper can answer from a failed KERN_PROCARGS2 lookup as (comm)
// while it is still live. Ownership must absorb that race without signaling
// anything, and must still fail closed while a live process stays unreadable
// or loses its marker proof.
const world = vi.hoisted(() => ({
  markerName: 'AGENT_TEAMS_PACKAGED_SMOKE_RUN_ID',
  processes: new Map<
    number,
    {
      parent: number;
      group: number;
      birth: string;
      state: string;
      argv: string;
      environ: string[];
      batchCommand?: 'comm';
      perPidCommand?: 'comm';
      exitAt?: number;
      perPidMarkerAnswers?: number;
    }
  >(),
}));

type ProbeProcess = NonNullable<ReturnType<typeof world.processes.get>>;

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const execFileSync = (file: unknown, args: unknown) => {
    if (file !== '/bin/ps') throw new Error('Unexpected packaged smoke probe executable');
    const argv = (args as readonly unknown[]).map(String);
    const uid = process.getuid?.() ?? -1;
    const absent = (): never => {
      throw Object.assign(new Error('ps: no such process'), { status: 1, stdout: '' });
    };
    const alive = (proc: ProbeProcess) => proc.exitAt === undefined || Date.now() < proc.exitAt;
    const rows = () => [...world.processes.entries()].filter(([, proc]) => alive(proc));
    const metadata = (pid: number, proc: ProbeProcess) =>
      `${pid} ${uid} ${proc.parent} ${proc.group} ${proc.state} ${proc.birth}`;
    const rendered = (pid: number, expanded: boolean) => {
      const proc = world.processes.get(pid)!;
      let environ = proc.environ;
      if (expanded && proc.perPidMarkerAnswers !== undefined) {
        if (proc.perPidMarkerAnswers > 0) proc.perPidMarkerAnswers -= 1;
        else environ = environ.filter((entry) => !entry.startsWith(`${world.markerName}=`));
      }
      return proc.perPidCommand === 'comm'
        ? '(helper)'
        : [proc.argv, ...(expanded ? environ : [])].join(' ');
    };
    const shape = argv.at(-1);
    if (argv.includes('-U')) {
      const listing = rows();
      const lines =
        shape === 'pid=,ruid=,ppid=,pgid=,stat=,lstart='
          ? listing.map(([pid, proc]) => metadata(pid, proc))
          : listing.map(([pid, proc]) =>
              `${pid} ${
                proc.batchCommand === 'comm'
                  ? '(helper)'
                  : [proc.argv, ...proc.environ].join(' ')
              }`
            );
      return lines.length ? lines.join('\n') + '\n' : '';
    }
    const pid = Number(argv[argv.indexOf('-p') + 1]);
    const proc = world.processes.get(pid);
    if (!proc || !alive(proc)) return absent();
    if (shape === 'pid=,ruid=,ppid=,pgid=,stat=,lstart=') return metadata(pid, proc) + '\n';
    // -E appends the environment to argv; only those dumps carry marker proofs.
    const expandedDump = argv.includes('-E');
    const command = rendered(pid, expandedDump);
    return (shape === 'pid=,command=' ? `${pid} ${command}` : command) + '\n';
  };
  return { ...actual, execFileSync };
});

// Above Linux PID_MAX_LIMIT (2^22) and macOS PID_MAX: never a real process.
const FAKE_PID = 5_000_000;
const BIRTH = 'Mon Oct 24 12:00:00 2026';

function setup() {
  const ownership = createPackagedSmokeOwnership({ platform: 'darwin', timeoutMs: 10_000 });
  const environ = [
    ...Object.entries(ownership.environment).map(([key, value]) => `${key}=${value}`),
    'PATH=/bin',
  ];
  const signals: [number, string][] = [];
  const realKill = process.kill.bind(process);
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
    if (pid < FAKE_PID) return realKill(pid, signal);
    signals.push([pid, String(signal)]);
    return true;
  }) as typeof process.kill);
  return { ownership, environ, signals };
}

function spawn(environ: string[]) {
  const pid = FAKE_PID + world.processes.size + 1;
  world.processes.set(pid, {
    parent: process.pid,
    group: pid,
    birth: BIRTH,
    state: 'S',
    argv: '/Applications/Agent Teams.app/Contents/MacOS/helper --packaged-smoke',
    environ,
  });
  return pid;
}

describe.skipIf(process.platform === 'win32')('packaged smoke Darwin probe races', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    world.processes.clear();
  });

  it('absorbs a retiring helper whose per-process environment probe degrades to (comm)', async () => {
    const { ownership, environ, signals } = setup();
    const leader = spawn(environ);
    expect(ownership.begin(leader).map((entry) => entry.pid)).toEqual([leader]);
    // KERN_PROCARGS2 lookup failures appear as (comm) while the helper is
    // still live; the next probe finds it gone.
    const proc = world.processes.get(leader)!;
    proc.perPidCommand = 'comm';
    proc.exitAt = Date.now() + 250;
    ownership.signal('SIGTERM');
    expect(signals).toEqual([]);
    expect(await ownership.waitForExit(1_000)).toBe(true);
    expect(ownership.finish()).toMatchObject({ remaining: [] });
  });

  it('absorbs a retiring helper whose batch census row degrades to (comm)', async () => {
    const { ownership, environ, signals } = setup();
    const leader = spawn(environ);
    expect(ownership.begin(leader).map((entry) => entry.pid)).toEqual([leader]);
    const proc = world.processes.get(leader)!;
    proc.batchCommand = 'comm';
    proc.perPidCommand = 'comm';
    proc.exitAt = Date.now() + 250;
    ownership.signal('SIGTERM');
    expect(signals).toEqual([]);
    expect(await ownership.waitForExit(1_000)).toBe(true);
    expect(ownership.finish()).toMatchObject({ remaining: [] });
  });

  it('stays loud while a live owned helper keeps an unreadable environment', () => {
    const { ownership, environ, signals } = setup();
    const leader = spawn(environ);
    expect(ownership.begin(leader).map((entry) => entry.pid)).toEqual([leader]);
    world.processes.get(leader)!.perPidCommand = 'comm';
    expect(() => ownership.signal('SIGTERM')).toThrow(
      /Unverifiable packaged smoke process environment/
    );
    expect(signals).toEqual([]);
  });

  it('refuses to signal a live helper whose marker proof disappears', () => {
    const { ownership, environ, signals } = setup();
    const leader = spawn(environ);
    expect(ownership.begin(leader).map((entry) => entry.pid)).toEqual([leader]);
    // Verifiable again in signal's census, then readable without the marker.
    world.processes.get(leader)!.perPidMarkerAnswers = 1;
    expect(() => ownership.signal('SIGTERM')).toThrow(/ownership changed before signal/);
    expect(signals).toEqual([]);
  });
});
