// @vitest-environment node
import { beforeEach, expect, test, vi } from 'vitest';

const proc = vi.hoisted(() => ({
  rows: new Map<number, {
    birth: string; group: number; ppid: number; executable: string; environment: string;
    inaccessible?: boolean;
  }>(),
  protectedReads: [] as string[],
}));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, readFileSync: (path: string, options: unknown) => {
    const match = /^\/proc\/(\d+)\/stat$/.exec(String(path));
    if (!match) return Reflect.apply(fs.readFileSync, fs, [path, options]);
    const value = proc.rows.get(Number(match[1]));
    if (!value) throw Object.assign(new Error('TEST missing process'), { code: 'ENOENT' });
    const fields = Array<string>(20).fill('0');
    fields[0] = 'S'; fields[1] = String(value.ppid); fields[2] = String(value.group); fields[19] = value.birth;
    return `${match[1]} (TEST captured process) ${fields.join(' ')}`;
  } };
});
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  const selected = (path: string) => {
    const match = /^\/proc\/(\d+)\/(?:exe|environ)$/.exec(path);
    if (!match) return undefined;
    proc.protectedReads.push(path);
    const value = proc.rows.get(Number(match[1]));
    if (!value) throw Object.assign(new Error('TEST missing process'), { code: 'ENOENT' });
    if (value.inaccessible) throw Object.assign(new Error('TEST protected process'), { code: 'EACCES' });
    return value;
  };
  return { ...fs,
    readdir: (path: string, options: unknown) => path === '/proc' ? Promise.resolve([...proc.rows.keys()].map(String)) : Reflect.apply(fs.readdir, fs, [path, options]),
    lstat: (path: string, options: unknown) => /^\/proc\/\d+$/.test(path) ? Promise.resolve({ uid: process.getuid!() }) : Reflect.apply(fs.lstat, fs, [path, options]),
    realpath: (path: string) => path === '/TEST-private-namespace' ? Promise.resolve(path) : fs.realpath(path),
    readlink: async (path: string, options: unknown) => selected(path)?.executable ?? Reflect.apply(fs.readlink, fs, [path, options]),
    readFile: async (path: string, options: unknown) => selected(path)?.environment ?? Reflect.apply(fs.readFile, fs, [path, options]),
  };
});

import {
  selectedLinuxProcesses,
  snapshotLinuxProcesses,
  testNamespaceLinuxProcesses,
} from '../../scripts/legacy-agent-host/desktop-retained-opencode-app.ts';

const row = (birth: string, group: number, inaccessible = false) => ({
  birth, group, ppid: group, executable: '/TEST-electron', environment: '', inaccessible,
});
beforeEach(() => { proc.rows.clear(); proc.protectedReads.length = 0; });

test.skipIf(process.platform !== 'linux')('discovery scopes kernel identity before inspecting protected executable bytes', async () => {
  proc.rows.set(1210, row('100', 1000, true));
  proc.rows.set(4048, row('27029', 4047));
  const selected = await selectedLinuxProcesses('/TEST-electron', identity => identity.group === 4047 && identity.birth === '27029');
  expect(selected.map(identity => identity.pid)).toEqual([4048]);
  expect(proc.protectedReads).toEqual(['/proc/4048/exe']);
  await expect(selectedLinuxProcesses('/TEST-electron', identity => identity.pid === 1210)).rejects.toMatchObject({ code: 'EACCES' });
});

test.skipIf(process.platform !== 'linux')('absence excludes only original baseline identities, never a reused PID', async () => {
  proc.rows.set(1210, row('100', 1000, true));
  const baseline = await snapshotLinuxProcesses();
  expect(proc.protectedReads).toEqual([]);
  expect(await testNamespaceLinuxProcesses('/TEST-private-namespace', baseline)).toEqual([]);
  expect(proc.protectedReads).toEqual([]);
  proc.rows.set(1210, row('30000', 1210, true));
  await expect(testNamespaceLinuxProcesses('/TEST-private-namespace', baseline)).rejects.toMatchObject({ code: 'EACCES' });
});

test.skipIf(process.platform !== 'linux')('new inaccessible processes remain unknown and a detached TEST child remains visible', async () => {
  proc.rows.set(1210, row('100', 1000, true));
  const baseline = await snapshotLinuxProcesses();
  proc.rows.set(5050, row('30000', 5050, true));
  await expect(testNamespaceLinuxProcesses('/TEST-private-namespace', baseline)).rejects.toMatchObject({ code: 'EACCES' });
  proc.rows.set(5050, { ...row('30000', 5050), ppid: 1, environment: 'HOME=/TEST-private-namespace/home\0' });
  const remaining = await testNamespaceLinuxProcesses('/TEST-private-namespace', baseline);
  expect(remaining.map(identity => ({ pid: identity.pid, ppid: identity.ppid, birth: identity.birth }))).toEqual([{ pid: 5050, ppid: 1, birth: '30000' }]);
});
