import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { TeamOwnerError } from '../dist/team/contracts.js';

type PathApi = Pick<typeof path, 'join' | 'parse' | 'sep'>;
type Namespace = { root: string; directory: string; teamName: string };
type Observation = ['lstat' | 'readdir', string, unknown];
type Fault = { target: string; kind: 'missing' | 'file' | 'alias' | 'denied' };
const native = { join: path.join, parse: path.parse, sep: path.sep };
const posix = { join: path.posix.join, parse: path.posix.parse, sep: path.posix.sep };
const windows = { join: path.win32.join, parse: path.win32.parse, sep: path.win32.sep };
const inspect = (store: TeamOwnerStore) =>
  (store as unknown as { validateNamespace(): void }).validateNamespace();

// The previous directory walk is the differential oracle. The controlled tree
// reads are empty, so both paths retain the same two final readdir observations.
function originalTraversal(namespace: Namespace, api: PathApi): void {
  const directoryPath = (target: string, required = false): void => {
    let part = api.parse(target).root;
    for (const segment of target.slice(part.length).split(api.sep)) {
      part = api.join(part, segment);
      try {
        const stat = fs.lstatSync(part);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TeamOwnerError('hold');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          if (required) throw new TeamOwnerError('hold');
          return;
        }
        throw error;
      }
    }
  };
  const team = api.join(namespace.root, 'teams', namespace.teamName);
  const tasks = api.join(namespace.root, 'tasks', namespace.teamName);
  directoryPath(namespace.directory, true);
  directoryPath(tasks);
  fs.readdirSync(team, { withFileTypes: true });
  fs.readdirSync(tasks, { withFileTypes: true });
}

function observe(namespace: Namespace, api: PathApi, legacy: boolean, fault?: Fault) {
  const saved = { lstat: fs.lstatSync, readdir: fs.readdirSync,
    join: path.join, parse: path.parse, sep: path.sep };
  const calls: Observation[] = [];
  let joins = 0, error: unknown;
  const selected = { ...api, join: (...parts: string[]) => { joins++; return api.join(...parts); } };
  try {
    path.join = selected.join; path.parse = selected.parse;
    Object.assign(path, { sep: selected.sep });
    Object.assign(fs, { lstatSync: ((target: string, options?: unknown) => {
      calls.push(['lstat', target, options]);
      const kind = fault?.target === target ? fault.kind : undefined;
      if (kind === 'missing' || kind === 'denied')
        throw Object.assign(new Error('TEST original filesystem refusal'), { code: kind === 'missing' ? 'ENOENT' : 'EACCES' });
      return { isDirectory: () => kind !== 'file', isSymbolicLink: () => kind === 'alias' };
    }) as typeof fs.lstatSync, readdirSync: ((target: string, options?: unknown) => {
      calls.push(['readdir', target, options]); return [];
    }) as typeof fs.readdirSync });
    syncBuiltinESMExports();
    try {
      if (legacy) originalTraversal(namespace, selected);
      else inspect(Object.assign(Object.create(TeamOwnerStore.prototype) as TeamOwnerStore, namespace));
    } catch (caught) { error = caught; }
  } finally {
    Object.assign(fs, { lstatSync: saved.lstat, readdirSync: saved.readdir });
    path.join = saved.join; path.parse = saved.parse; Object.assign(path, { sep: saved.sep });
    syncBuiltinESMExports();
  }
  return { calls, joins, error: error instanceof Error
    ? { name: error.name, message: error.message, code: (error as NodeJS.ErrnoException).code } : error };
}

const spellings = [
  { name: 'POSIX', api: posix, root: '/TEST/home/storage' },
  { name: 'POSIX trailing root', api: posix, root: '/TEST/home/storage/' },
  { name: 'POSIX filesystem root', api: posix, root: '/' },
  { name: 'Windows drive', api: windows, root: 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\TEST-original\\storage' },
  { name: 'Windows drive trailing root', api: windows, root: 'C:\\TEST\\storage\\' },
  { name: 'Windows drive root', api: windows, root: 'C:\\' },
  { name: 'Windows UNC', api: windows, root: '\\\\TEST-server\\share\\storage' },
  { name: 'Windows UNC root', api: windows, root: '\\\\TEST-server\\share' },
  { name: 'Windows UNC trailing root', api: windows, root: '\\\\TEST-server\\share\\' },
  { name: 'Windows extended drive', api: windows, root: '\\\\?\\C:\\TEST\\storage' },
  { name: 'Windows extended drive root', api: windows, root: '\\\\?\\C:\\' },
  { name: 'Windows extended UNC', api: windows, root: '\\\\?\\UNC\\TEST-server\\share\\storage' },
  { name: 'Windows extended UNC trailing root', api: windows, root: '\\\\?\\UNC\\TEST-server\\share\\' },
  { name: 'Windows normalized mixed separators', api: windows, root: 'C:/TEST/storage/' },
] as const;

for (const { name, api, root } of spellings) test(`fresh namespace traversal preserves ${name} paths and refusals`, () => {
  const teamName = 'TEST-team';
  const directory = api.join(root, 'teams', teamName, '.host-owner');
  const namespace = { root, directory, teamName };
  // Production targets come from join; roots and trailing targets also preserve
  // the old empty-segment observation without normalizing every ancestor.
  for (const target of [directory, directory + api.sep, api.parse(directory).root, api.join(root)]) {
    const selected = { ...namespace, directory: target };
    const previous = observe(selected, api, true), actual = observe(selected, api, false);
    assert.deepEqual(actual.calls, previous.calls);
    assert.deepEqual(actual.error, previous.error);
    for (const [, ancestor] of previous.calls.filter(row => row[0] === 'lstat')) {
      for (const kind of ['missing', 'file', 'alias', 'denied'] as const) {
        const fault = { target: ancestor, kind };
        const expected = observe(selected, api, true, fault), observed = observe(selected, api, false, fault);
        assert.deepEqual(observed.calls, expected.calls, `${target}: ${kind} at ${ancestor}`);
        assert.deepEqual(observed.error, expected.error, `${target}: ${kind} at ${ancestor}`);
      }
    }
  }
});

test('deep canonical namespace keeps every fresh observation within a fixed path-normalization budget', () => {
  const root = windows.join('C:\\', 'Users', 'runneradmin', 'AppData', 'Local', 'Temp', 'TEST-original', 'storage');
  const namespace = { root, teamName: 'TEST-team', directory: windows.join(root, 'teams', 'TEST-team', '.host-owner') };
  const previous = observe(namespace, windows, true), actual = observe(namespace, windows, false);
  assert.equal(actual.error, undefined); assert.deepEqual(actual.calls, previous.calls);
  assert.ok(previous.joins > 20, 'the original deep namespace repeatedly normalizes already canonical ancestors');
  assert.ok(actual.joins <= 4, 'normalization cost stays bounded while every ancestor still receives its original lstat');
});

test('real namespace reads still refuse missing directories, files and a late nested alias', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(native.join(tmpdir(), 'TEST-namespace-paths-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new TeamOwnerStore(root, 'TEST-team');
  let callbacks = 0;
  store.fenced(() => { callbacks++; });
  const detached = store.directory + '-detached';
  fs.renameSync(store.directory, detached);
  try { assert.throws(() => store.fenced(() => { callbacks++; }), { code: 'hold' }); }
  finally { fs.renameSync(detached, store.directory); }
  const tasks = native.join(root, 'tasks'); fs.writeFileSync(tasks, 'TEST regular file');
  try { assert.throws(() => store.fenced(() => { callbacks++; }), { code: 'hold' }); }
  finally { fs.rmSync(tasks); }
  const outside = native.join(root, 'TEST-outside'), alias = native.join(root, 'teams', 'TEST-team', 'TEST-late-alias');
  fs.mkdirSync(outside);
  store.fenced(() => {
    fs.symlinkSync(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
    try { assert.throws(() => store.fenced(() => { callbacks++; }), { code: 'hold' }); }
    finally { fs.rmSync(alias); }
  });
  store.fenced(() => { callbacks++; });
  assert.equal(callbacks, 2, 'only the two freshly valid namespace callbacks ran');
});
