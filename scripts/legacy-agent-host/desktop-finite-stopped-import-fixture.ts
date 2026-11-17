import assert from 'node:assert/strict';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readTeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/readProfile.js';
import { desktopNodeScriptHeader, digest, fileDigest } from './desktop-backend-fixture.ts';
import { prepareDesktopEmulatedRuntimeFixture } from './desktop-emulated-runtime-fixture.ts';
import { publishDesktopEmulatedClaudeSettingsProfile } from './desktop-emulated-claude-settings-fixture.ts';

export const FINITE_IMPORT_MODE = 'emulated-import-lifecycle-ui';
export const FINITE_SOURCE_TEAM = 'test-stopped-legacy';
export const FINITE_SOURCE_PROMPT = 'TEST_CURRENT_LEGACY_SOLO_ONE';
export const FINITE_SOURCE_REPLY = 'REPLY_TEST_CURRENT_LEGACY_SOLO_ONE';
export const FINITE_HOST_PROMPT = 'TEST_UI_BOOT';
export const FINITE_HOST_REPLY = 'TEST boot ready';
export type FiniteImportFixture = Awaited<ReturnType<typeof prepareDesktopEmulatedRuntimeFixture>>;
export type FiniteImportRow = Record<string, unknown>;
export const finiteImportRow = (value: unknown): FiniteImportRow => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as FiniteImportRow;
};
export const finiteImportJson = async (path: string): Promise<FiniteImportRow> =>
  finiteImportRow(JSON.parse(await readFile(path, 'utf8')));

/** This fixture never creates any source Team, run record, transcript or release receipt. */
export async function prepareDesktopFiniteStoppedImportFixture(repo: string, pnpmEntry: string) {
  assert.equal(process.env.LEGACY_DESKTOP_EMULATED_ONLY, '1');
  assert.equal(process.env.LEGACY_DESKTOP_PROOF_MODE, FINITE_IMPORT_MODE);
  const fixture = await prepareDesktopEmulatedRuntimeFixture(repo, pnpmEntry, 'claude');
  const profile = readTeamHostProfile(fixture.profilePath, fixture.pins.profileSha256);
  for (const peer of fixture.emulatedRuntime.peers)
    peer.environment.TEST_DESKTOP_IMPORT_LIFECYCLE = 'current-solo-v1';
  for (const selected of [...profile.runtime!.members, ...profile.runtime!.providerTemplates!, ...profile.management!])
    selected.environment.TEST_DESKTOP_IMPORT_LIFECYCLE = 'current-solo-v1';
  await publishDesktopEmulatedClaudeSettingsProfile(fixture, profile, descriptor => {
    finiteImportRow(descriptor.creation).importAuthority = { principalId: profile.principalId };
  });
  return fixture;
}

/** Only the original frontend's bounded model-list reads; no inference endpoint exists. */
export async function startFiniteLegacyCatalog() {
  let requests = 0;
  const failures: string[] = [];
  const server = createServer((request, response) => {
    try {
      assert.equal(request.socket.remoteAddress, '127.0.0.1');
      assert.equal(request.method, 'GET');
      assert.ok(['/v1/models', '/v1/models?limit=1000'].includes(request.url ?? ''));
      assert.equal(request.headers['x-api-key'], 'TEST-finite-legacy-catalog');
      assert.ok(++requests <= 8);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'claude-sonnet-4-6', type: 'model',
        display_name: 'Sonnet 4.6', created_at: '2026-01-01T00:00:00Z' }],
      has_more: false, first_id: 'claude-sonnet-4-6', last_id: 'claude-sonnet-4-6' }));
    } catch {
      failures.push('unexpected-catalog-request'); response.writeHead(400); response.end('TEST refusal');
    }
  });
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return { url: `http://127.0.0.1:${address.port}`, failures, get requests() { return requests; },
    close: () => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())) };
}

/** Reject resolver fallbacks before starting the no-Host app; metadata never executes a vendor CLI. */
export async function verifyFiniteLegacyCandidates(repo: string, fixture: FiniteImportFixture) {
  const absent = async (path: string) => {
    try { await lstat(path); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
  };
  const root = fixture.root, home = join(root, 'home');
  assert.match(basename(root), /^TEST-desktop-backend-/);
  const directories = [join(root, 'bin'), dirname(fixture.node), join(repo, 'node_modules/.bin'),
    join(root, 'claude/local/node_modules/.bin'),
    ...['.bun/bin', '.local/bin', '.npm-global/bin', '.npm/bin', '.asdf/shims', '.local/share/mise/shims',
      '.volta/bin', 'Library/pnpm', '.local/share/pnpm', '.cargo/bin', '.nix-profile/bin'].map(name => join(home, name)),
    '/usr/local/bin', '/opt/homebrew/bin', '/opt/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const observations: FiniteImportRow[] = [];
  for (const name of ['claude', 'claude-multimodel', 'codex', 'opencode', 'gemini']) {
    const sentinels = [join(root, 'bin', name), join(root, 'claude/local/node_modules/.bin', name)];
    for (const sentinel of sentinels) {
      const stat = await lstat(sentinel);
      assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size < 64 * 1024);
      assert.equal(await realpath(sentinel), sentinel); assert.equal(await fileDigest(sentinel), fixture.pins.sentinelSha256);
    }
    for (const path of new Set(directories.map(directory => resolve(repo, directory, name)))) {
      if (sentinels.includes(path)) observations.push({ path, kind: 'pinned-test-sentinel', sha256: fixture.pins.sentinelSha256 });
      else { assert.equal(await absent(path), true, 'unexpected source runtime resolver candidate: ' + path);
        observations.push({ path, kind: 'absent' }); }
    }
    const managed = join(root, 'userData/data/runtimes', name, 'current.json');
    assert.equal(await absent(managed), true); observations.push({ path: managed, kind: 'absent' });
  }
  assert.ok(observations.length <= 160);
  return observations;
}

/** Only the captured finite peer is selected for the original legacy runtime override. */
export async function prepareFiniteLegacyExecutable(repo: string, fixture: FiniteImportFixture) {
  const source = join(repo, 'tools/owned-process-broker/fixtures/legacyBootstrapPeer.mjs');
  assert.equal(await realpath(source), source);
  const sourceSha256 = await fileDigest(source), lock = await finiteImportJson(join(repo, 'runtime.lock.json'));
  const version = String(lock.cliVersion ?? lock.version);
  assert.match(version, /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u);
  const bytes = `${desktopNodeScriptHeader(fixture.node)}import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';import {readFileSync,realpathSync} from 'node:fs';
assert.equal(realpathSync(${JSON.stringify(source)}),${JSON.stringify(source)});
assert.equal(createHash('sha256').update(readFileSync(${JSON.stringify(source)})).digest('hex'),${JSON.stringify(sourceSha256)});
await import(${JSON.stringify(pathToFileURL(source).href)});
`;
  const path = join(fixture.root, 'bin/TEST-legacy-bootstrap-peer');
  await writeFile(path, bytes, { mode: 0o700, flag: 'wx' });
  return { path, sha256: digest(bytes), source, sourceSha256, version };
}

export async function readFiniteLegacyEffects(root: string) {
  let bytes: string;
  try { bytes = await readFile(join(root, 'finite-legacy-peer.ndjson'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  assert.ok(Buffer.byteLength(bytes) < 256 * 1024);
  return bytes.trim().split('\n').filter(Boolean).map(line => {
    const value = finiteImportRow(JSON.parse(line)); assert.equal(value.kind, 'finite-legacy-bootstrap');
    assert.ok(Number.isSafeInteger(value.pid) && Number(value.pid) > 1);
    assert.ok(['metadata-version', 'metadata-control', 'model-probe', 'bootstrap', 'turn-completed', 'sigterm', 'sigint'].includes(String(value.event)));
    return value;
  });
}
