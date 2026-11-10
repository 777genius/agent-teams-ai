// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPackagedSmokeOwnership } from '../../../scripts/electron-builder/packagedSmokeOwnedProcesses.ts';

// Hermetic Linux /proc model: lineage debt and signal authority are checked on
// every POSIX host without spawning or signaling real processes. An entry
// without environ is a same-uid non-dumpable process (EACCES at open).
const world = vi.hoisted(() => ({
  processes: new Map<number, { parent: number; birth: number; environ?: string }>(),
  descriptors: new Map<number, { data: Buffer; offset: number }>(),
  nextDescriptor: 1_000_000,
  beforeCensus: [] as (() => void)[],
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const passthrough = actual as unknown as Record<string, (...args: unknown[]) => unknown>;
  const errno = (code: string) => Object.assign(new Error(code), { code });
  const procfs = (path: unknown) => {
    const match = /^\/proc\/(\d+)(?:\/(stat|environ))?$/.exec(String(path));
    return match ? { pid: Number(match[1]), file: match[2] } : undefined;
  };
  const entry = (pid: number) => {
    const found = world.processes.get(pid);
    if (!found) throw errno('ENOENT');
    return found;
  };
  return {
    ...actual,
    readdirSync: (path: unknown, ...rest: unknown[]) => {
      if (path !== '/proc') return passthrough.readdirSync(path, ...rest);
      world.beforeCensus.shift()?.();
      return [...world.processes.keys()].map(String);
    },
    statSync: (path: unknown, ...rest: unknown[]) => {
      const target = procfs(path);
      if (!target || target.file) return passthrough.statSync(path, ...rest);
      entry(target.pid);
      return { uid: process.getuid?.() };
    },
    readFileSync: (path: unknown, ...rest: unknown[]) => {
      const target = procfs(path);
      if (target?.file !== 'stat') return passthrough.readFileSync(path, ...rest);
      const { parent, birth } = entry(target.pid);
      const fields = ['S', parent, target.pid, ...Array<number>(16).fill(0), birth];
      return `${target.pid} (fake) ${fields.join(' ')}`;
    },
    openSync: (path: unknown, ...rest: unknown[]) => {
      const target = procfs(path);
      if (target?.file !== 'environ') return passthrough.openSync(path, ...rest);
      const { environ } = entry(target.pid);
      if (environ === undefined) throw errno('EACCES');
      const descriptor = world.nextDescriptor++;
      world.descriptors.set(descriptor, { data: Buffer.from(environ), offset: 0 });
      return descriptor;
    },
    readSync: (
      descriptor: unknown,
      buffer: unknown,
      offset: unknown,
      length: unknown,
      ...rest: unknown[]
    ) => {
      const open = world.descriptors.get(descriptor as number);
      if (!open) return passthrough.readSync(descriptor, buffer, offset, length, ...rest);
      const end = Math.min(open.data.length, open.offset + (length as number));
      const bytes = open.data.copy(buffer as Buffer, offset as number, open.offset, end);
      open.offset += bytes;
      return bytes;
    },
    closeSync: (descriptor: unknown) => {
      if (!world.descriptors.delete(descriptor as number)) passthrough.closeSync(descriptor);
    },
  };
});

// Above Linux PID_MAX_LIMIT (2^22) and macOS PID_MAX: never a real process.
const FAKE_PID = 5_000_000;
const HARNESS_BIRTH = 100;

function exit(pid: number) {
  world.processes.delete(pid);
  for (const entry of world.processes.values()) if (entry.parent === pid) entry.parent = 1;
}

function setup(onSignal: (pid: number) => void = exit) {
  world.processes.set(process.pid, { parent: 1, birth: HARNESS_BIRTH, environ: '' });
  // A pre-launch browser zygote stays in the baseline and is never inspected.
  world.processes.set(FAKE_PID, { parent: 1, birth: HARNESS_BIRTH - 50 });
  const ownership = createPackagedSmokeOwnership({ platform: 'linux', timeoutMs: 1_000 });
  const marked = [
    ...Object.entries(ownership.environment).map(([key, value]) => `${key}=${value}`),
    'PATH=/bin',
  ].join('\0');
  const signals: [number, string][] = [];
  const realKill = process.kill.bind(process);
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
    if (pid < FAKE_PID) return realKill(pid, signal);
    signals.push([pid, String(signal)]);
    onSignal(pid);
    return true;
  }) as typeof process.kill);
  return { ownership, marked, signals };
}

describe.skipIf(process.platform === 'win32')('packaged smoke non-dumpable lineage debt', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    world.processes.clear();
    world.descriptors.clear();
    world.beforeCensus.length = 0;
  });

  it('never signals marked non-dumpable descendants and forgets unrelated ones', async () => {
    const { ownership, marked, signals } = setup();
    const [leader, child, grandchild, unrelated] = [1, 2, 3, 4].map((offset) => FAKE_PID + offset);
    world.processes.set(leader, { parent: process.pid, birth: 200, environ: marked });
    world.processes.set(child, { parent: leader, birth: 210 });
    world.processes.set(grandchild, { parent: child, birth: 220 });
    world.processes.set(unrelated, { parent: process.pid, birth: 230 });

    expect(ownership.begin(leader).map((entry) => entry.pid)).toEqual([leader]);
    ownership.signal('SIGTERM');
    ownership.signal('SIGKILL');
    expect(signals).toEqual([[leader, 'SIGTERM']]);
    expect(await ownership.waitForExit(100)).toBe(false);
    expect(() => ownership.finish()).toThrow(
      /Unverifiable packaged smoke processes remain after cleanup/
    );

    exit(grandchild);
    exit(child);
    expect(await ownership.waitForExit(1_000)).toBe(true);
    expect(ownership.finish()).toMatchObject({ remaining: [] });
    expect(world.processes.has(unrelated)).toBe(true);
    expect(signals).toEqual([[leader, 'SIGTERM']]);
  });

  it('keeps a non-dumpable child first seen while its retiring parent is unsettled', async () => {
    const leader = FAKE_PID + 11;
    const child = FAKE_PID + 12;
    const { ownership, marked, signals } = setup((pid) => {
      // Linux releases a retiring process's environment before it is a zombie.
      const retiring = world.processes.get(pid);
      if (retiring) retiring.environ = '';
      world.processes.set(child, { parent: pid, birth: 310 });
      // Wait census 1 sees same-birth parent debt; census 2 sees the child
      // reparented after that parent exited.
      world.beforeCensus.push(
        () => undefined,
        () => exit(pid)
      );
    });
    world.processes.set(leader, { parent: process.pid, birth: 300, environ: marked });

    expect(ownership.begin(leader).map((entry) => entry.pid)).toEqual([leader]);
    ownership.signal('SIGTERM');
    expect(await ownership.waitForExit(300)).toBe(false);
    expect(world.processes.get(child)?.parent).toBe(1);
    expect(() => ownership.finish()).toThrow(
      /Unverifiable packaged smoke processes remain after cleanup/
    );
    expect(signals).toEqual([[leader, 'SIGTERM']]);
  });
});
