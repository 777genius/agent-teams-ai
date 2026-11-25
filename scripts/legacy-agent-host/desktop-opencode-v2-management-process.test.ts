import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { basename, dirname } from 'node:path';
import test from 'node:test';
import { Script } from 'node:vm';

const source = readFileSync(new URL('./desktop-opencode-v2-management-process.ts', import.meta.url), 'utf8');
const start = source.indexOf('async function birth(');
assert.ok(start > 0);
// Execute the complete actual census implementation; only its existing OS reads are finite seams.
const implementation = new Script(stripTypeScriptTypes(source.slice(start)
  .replace('export function observeDesktopV2ManagementProcesses', 'function observeDesktopV2ManagementProcesses')) +
  '\nobserveDesktopV2ManagementProcesses;');
const digest = 'a'.repeat(64);
type Candidate = { pid: number; ppid: number; pgid: number; birth: string; reason: 'unobserved-executable' };
type Child = Omit<Candidate, 'reason'> & { executableSha256: string; dataRoot: string; role: string };
interface Census {
  children: Child[];
  probes: { step: string; pid: number; birth: string }[];
  unobservedCandidates: Candidate[];
  observe(step?: string): Promise<void>;
  remaining(): Promise<(Child | Candidate)[]>;
}
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const candidates = (census: Census) => plain(census.unobservedCandidates ?? []);

function fixture() {
  const files = new Map<string, string>(), links = new Map<string, string>();
  const errors = new Map<string, Error>(), reads: string[] = [];
  let rows = [{ pid: 10, ppid: 2, pgid: 2 }, { pid: 11, ppid: 10, pgid: 11 }];
  let onRealpath: ((path: string) => void) | undefined;
  const absent = Object.assign(new Error('TEST missing original proc entry'), { code: 'ENOENT' });
  const stat = (pid: number, birth: number, ppid = 10, pgid = pid) => {
    const fields = Array<string>(20).fill('0');
    fields[0] = 'S'; fields[1] = String(ppid); fields[2] = String(pgid); fields[19] = String(birth);
    files.set(`/proc/${pid}/stat`, `${pid} (TEST finite child) ${fields.join(' ')}`);
  };
  const child = (pid: number, birth: number, role = 'catalog') => {
    stat(pid, birth); links.set(`/proc/${pid}/exe`, '/TEST/bun');
    files.set(`/proc/${pid}/cmdline`, '/TEST/bun\0--no-env-file\0--config=/dev/null\0--no-install\0/TEST/child.js\0');
    files.set(`/proc/${pid}/environ`, `XDG_DATA_HOME=/TEST/data/agent-teams-v2-${role}-TEST\0`);
  };
  stat(10, 100, 2, 2); child(11, 110);
  const factory = implementation.runInNewContext({ assert, basename, dirname,
    async readFile(path: string) {
      reads.push(`read:${path}`); if (errors.has(path)) throw errors.get(path);
      const value = files.get(path); if (value === undefined) throw absent; return value;
    },
    async realpath(path: string) {
      reads.push(`realpath:${path}`); onRealpath?.(path); if (errors.has(path)) throw errors.get(path);
      const value = links.get(path); if (value === undefined) throw absent; return value;
    },
    async fileDigest(path: string) { reads.push(`digest:${path}`); assert.equal(path, '/TEST/bun'); return digest; },
    processTable: () => rows.map(row => ({ ...row })),
    command: (pid: number) => pid === 10 ? '/TEST/node /TEST/host.js' : '',
  }) as (group: number, selected: unknown) => Census;
  const census = factory(2, { node: '/TEST/node', hostEntry: '/TEST/host.js', v2Management: {
    selection: { bunPath: '/TEST/bun', bunSha256: digest }, childEntry: '/TEST/child.js',
    management: { environment: { XDG_DATA_HOME: '/TEST/data' } },
  } });
  return { census, files, links, errors, reads, absent, stat, child,
    rows: (next: typeof rows) => { rows = next; },
    onRealpath: (callback: (path: string) => void) => { onRealpath = callback; } };
}
const original = { pid: 11, ppid: 10, pgid: 11, birth: '110', reason: 'unobserved-executable' };

test('first executable ENOENT retains the original candidate as debt, never as a native witness', async () => {
  const f = fixture(); f.links.delete('/proc/11/exe');
  await f.census.observe();
  assert.deepEqual(plain(f.census.children), []); assert.deepEqual(plain(f.census.probes), []);
  assert.deepEqual(candidates(f.census), [original]);
  assert.deepEqual(f.reads, ['read:/proc/10/stat', 'read:/proc/11/stat', 'realpath:/proc/11/exe', 'read:/proc/11/stat']);
  assert.deepEqual(plain(await f.census.remaining()), [original], 'present unknown identity prevents a successful final absence assertion');
  assert.deepEqual(f.reads.slice(-1), ['read:/proc/11/stat'], 'one additional bounded debt read, no signal or process discovery');
  await f.census.observe();
  assert.equal(f.census.unobservedCandidates.length, 1, 'repeated observations retain one original tuple');
});

test('unobserved candidate remains cleanup debt after reparenting and only actual original absence clears presence', async () => {
  const f = fixture(); f.links.delete('/proc/11/exe'); await f.census.observe();
  f.rows([{ pid: 10, ppid: 2, pgid: 2 }, { pid: 11, ppid: 1, pgid: 11 }]);
  f.stat(11, 110, 1); await f.census.observe();
  assert.deepEqual(plain(await f.census.remaining()), [original], 'debt is not lost when the Host child leaves its original ancestry');
  f.files.delete('/proc/11/stat');
  assert.deepEqual(plain(await f.census.remaining()), []);
  assert.deepEqual(candidates(f.census), [original], 'the historical unknown observation is not rewritten as a witness');
});

test('a replacement birth for an unobserved PID cannot be adopted as the original child', async () => {
  const f = fixture(); f.links.delete('/proc/11/exe'); await f.census.observe();
  f.child(11, 111);
  await assert.rejects(f.census.observe(), /unobserved candidate.*original birth/u);
  assert.deepEqual(plain(f.census.children), []);
  assert.deepEqual(candidates(f.census), [original]);
  assert.deepEqual(plain(await f.census.remaining()), [], 'the changed birth is not the captured original identity');
  assert.ok(f.files.has('/proc/11/stat'), 'no claim that the replacement disappeared');
});

test('a later complete capture of the same original birth still performs all bindings and keeps debt history', async () => {
  const f = fixture(); f.links.delete('/proc/11/exe'); await f.census.observe();
  f.links.set('/proc/11/exe', '/TEST/bun'); f.reads.length = 0;
  await f.census.observe();
  assert.equal(f.census.children.length, 1);
  assert.deepEqual(candidates(f.census), [original]);
  assert.deepEqual(f.reads, ['read:/proc/10/stat', 'read:/proc/11/stat', 'realpath:/proc/11/exe',
    'read:/proc/11/cmdline', 'read:/proc/11/environ', 'read:/proc/11/stat', 'digest:/TEST/bun', 'read:/proc/11/stat']);
  f.reads.length = 0;
  assert.equal((await f.census.remaining()).length, 1);
  assert.deepEqual(f.reads, ['read:/proc/11/stat'], 'the original qualified-child path covers the same debt without duplicate reads');
});

test('an unobserved candidate cannot satisfy the original one-probe witness', async () => {
  const f = fixture(); f.links.delete('/proc/11/exe');
  await assert.rejects(f.census.observe('global-default'), /one original native probe child/u);
  assert.deepEqual(plain(f.census.children), []); assert.deepEqual(plain(f.census.probes), []);
  assert.deepEqual(candidates(f.census), [original]);
});

test('a previously qualified child keeps the original executable uncertainty refusal', async () => {
  const f = fixture(); await f.census.observe(); f.links.delete('/proc/11/exe');
  await assert.rejects(f.census.observe(), error => error === f.absent);
  assert.equal(f.census.children.length, 1); assert.deepEqual(candidates(f.census), []);
});

for (const file of ['cmdline', 'environ']) test(`ENOENT after executable capture at ${file} remains refusal`, async () => {
  const f = fixture(); f.files.delete(`/proc/11/${file}`);
  await assert.rejects(f.census.observe(), error => error === f.absent);
  assert.deepEqual(plain(f.census.children), []); assert.deepEqual(candidates(f.census), []);
});

test('non-ENOENT executable errors remain the original error', async () => {
  const f = fixture(), error = Object.assign(new Error('TEST denied original proc entry'), { code: 'EACCES' });
  f.errors.set('/proc/11/exe', error);
  await assert.rejects(f.census.observe(), value => value === error);
  assert.deepEqual(candidates(f.census), []);
});

test('an original birth change during missing executable capture remains refusal', async () => {
  const f = fixture(); f.links.delete('/proc/11/exe');
  f.onRealpath(path => { if (path === '/proc/11/exe') f.stat(11, 111); });
  await assert.rejects(f.census.observe(), error => error === f.absent);
  assert.deepEqual(candidates(f.census), []);
});

test('the original disappeared-before-executable path stays unobserved without fabricated debt', async () => {
  const f = fixture(); f.links.delete('/proc/11/exe');
  f.onRealpath(path => { if (path === '/proc/11/exe') f.files.delete('/proc/11/stat'); });
  await f.census.observe();
  assert.deepEqual(plain(f.census.children), []); assert.deepEqual(candidates(f.census), []);
  assert.deepEqual(plain(await f.census.remaining()), []);
});

test('unobserved candidates have a finite bound, without silently dropping active debt', async () => {
  const f = fixture(), rows = [{ pid: 10, ppid: 2, pgid: 2 }];
  for (let pid = 11; pid < 44; pid++) { rows.push({ pid, ppid: 10, pgid: pid }); f.stat(pid, pid * 10); }
  f.rows(rows); f.links.clear();
  await assert.rejects(f.census.observe(), /finite original unobserved management candidates/u);
  assert.equal(f.census.unobservedCandidates.length, 32);
  assert.equal((await f.census.remaining()).length, 32);
});

test('qualified native probe capture and original durable retirement remain unchanged', async () => {
  const f = fixture(); f.child(11, 110, 'probe');
  await f.census.observe('connect-key');
  assert.equal(f.census.children.length, 1); assert.equal(f.census.probes.length, 1);
  assert.deepEqual(candidates(f.census), []);
  await assert.rejects(f.census.observe(), /each original durable receipt retired its native probe/u);
  f.files.delete('/proc/11/stat'); f.rows([{ pid: 10, ppid: 2, pgid: 2 }]);
  await f.census.observe(); assert.deepEqual(plain(await f.census.remaining()), []);
});
