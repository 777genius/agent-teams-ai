import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readTeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/readProfile.js';
import { desktopNodeScriptHeader, digest, fileDigest } from './desktop-backend-fixture.ts';
import { prepareDesktopEmulatedRuntimeFixture } from './desktop-emulated-runtime-fixture.ts';
import { publishDesktopEmulatedClaudeSettingsProfile } from './desktop-emulated-claude-settings-fixture.ts';
import { finiteImportJson as json, finiteImportRow as row, startFiniteLegacyCatalog,
  verifyFiniteLegacyCandidates, type FiniteImportRow } from './desktop-finite-stopped-import-fixture.ts';

export const RETAINED_ORIGINAL_MODE = 'emulated-retained-original-ui';
export const RETAINED_ORIGINAL_TEAM = 'test-retained-original';
export const RETAINED_ORIGINAL_PROMPT = 'TEST_RETAINED_ORIGINAL_SOLO_ONE';
export const RETAINED_ORIGINAL_REPLY = 'REPLY_TEST_RETAINED_ORIGINAL_SOLO_ONE';
export const RETAINED_ORIGINAL_KIND = 'TEST-legacy-archive-without-native-release';
export type RetainedOriginalFixture = Awaited<ReturnType<typeof prepareDesktopRetainedOriginalFixture>>;
let originalCatalog: Awaited<ReturnType<typeof startFiniteLegacyCatalog>> | undefined;
export async function closeDesktopRetainedOriginalCatalog() {
  const selected = originalCatalog; originalCatalog = undefined;
  await selected?.close();
}
export function isDesktopRetainedOriginalFixture(fixture: Awaited<ReturnType<typeof prepareDesktopEmulatedRuntimeFixture>>): fixture is RetainedOriginalFixture {
  return Object.hasOwn(fixture, 'retainedOriginal');
}

/** A labeled synthetic archive starts without release authority; no qualified source is modified. */
export async function prepareDesktopRetainedOriginalFixture(repo: string, pnpmEntry: string) {
  assert.equal(process.env.LEGACY_DESKTOP_EMULATED_ONLY, '1');
  assert.equal(process.env.LEGACY_DESKTOP_PROOF_MODE, RETAINED_ORIGINAL_MODE);
  assert.notEqual(process.platform, 'win32');
  assert.equal(originalCatalog, undefined, 'one retained original catalog owner');
  const fixture = await prepareDesktopEmulatedRuntimeFixture(repo, pnpmEntry, 'claude');
  const profile = readTeamHostProfile(fixture.profilePath, fixture.pins.profileSha256);
  await publishDesktopEmulatedClaudeSettingsProfile(fixture, profile, descriptor => {
    row(descriptor.creation).importAuthority = { principalId: profile.principalId };
  });
  const { root } = fixture, workspace = join(root, 'workspace');
  const team = join(root, 'claude/teams', RETAINED_ORIGINAL_TEAM);
  await mkdir(dirname(team), { mode: 0o700 });
  await assert.rejects(lstat(team), { code: 'ENOENT' });
  await mkdir(team, { mode: 0o700 });
  await mkdir(join(root, 'claude/tasks', RETAINED_ORIGINAL_TEAM), { recursive: true, mode: 0o700 });
  const lead = 'team-lead@' + RETAINED_ORIGINAL_TEAM, createdAt = Date.now();
  const config = { name: RETAINED_ORIGINAL_TEAM, description: 'TEST legacy archive; native ownership never qualified',
    createdAt, _backupIdentityId: randomUUID(), leadAgentId: lead,
    leadSessionId: 'TEST-unqualified-archive-session', projectPath: workspace, projectPathHistory: [workspace],
    members: [{ agentId: lead, name: 'team-lead', agentType: 'team-lead', providerId: 'anthropic',
      model: 'claude-sonnet-4-6', joinedAt: createdAt, cwd: workspace }] };
  const saved = { cwd: workspace, providerId: 'anthropic', model: 'claude-sonnet-4-6', effort: 'low',
    prompt: RETAINED_ORIGINAL_PROMPT, skipPermissions: false, syncModelsWithLead: true };
  const records = { 'config.json': config, 'team.meta.json': { version: 1, ...saved, createdAt,
    displayName: 'TEST legacy archive without native release', description: config.description },
    'members.meta.json': { version: 1, members: [] } };
  const before = [];
  for (const [name, value] of Object.entries(records)) {
    const path = join(team, name), bytes = JSON.stringify(value, null, 2);
    await writeFile(path, bytes, { mode: 0o600, flag: 'wx' }); before.push({ path, sha256: digest(bytes) });
  }
  const absent = ['launch-state.json', 'launch-stopped.json', 'launch-freshness.json'];
  for (const name of absent) await assert.rejects(lstat(join(team, name)), { code: 'ENOENT' });
  const seed = { version: 1, sourceKind: RETAINED_ORIGINAL_KIND, teamName: RETAINED_ORIGINAL_TEAM,
    workspace, config, saved, before, absent,
    hostDescriptor: { path: fixture.descriptorPath, sha256: fixture.pins.descriptorSha256 } };
  const seedPath = join(root, 'retained-original-archive.json'), seedBytes = JSON.stringify(seed, null, 2);
  await writeFile(seedPath, seedBytes, { mode: 0o600, flag: 'wx' });
  const source = join(repo, 'tools/owned-process-broker/fixtures/retainedLegacyBootstrapPeer.mjs');
  assert.equal(await realpath(source), source);
  const sourceSha256 = await fileDigest(source), lock = await json(join(repo, 'runtime.lock.json'));
  const version = String(lock.cliVersion ?? lock.version); assert.match(version, /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u);
  const path = join(root, 'bin/TEST-retained-bootstrap-peer');
  const bytes = `${desktopNodeScriptHeader(fixture.node)}import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';import {readFileSync,realpathSync} from 'node:fs';
assert.equal(realpathSync(${JSON.stringify(source)}),${JSON.stringify(source)});
assert.equal(createHash('sha256').update(readFileSync(${JSON.stringify(source)})).digest('hex'),${JSON.stringify(sourceSha256)});
await import(${JSON.stringify(pathToFileURL(source).href)});
`;
  await writeFile(path, bytes, { mode: 0o700, flag: 'wx' });
  const candidates = await verifyFiniteLegacyCandidates(repo, fixture), catalog = await startFiniteLegacyCatalog();
  originalCatalog = catalog;
  Object.assign(fixture.appEnvironment, {
    PATH: [join(root, 'bin'), dirname(fixture.node), '/usr/bin', '/bin'].join(':'),
    CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: path, CLAUDE_CLI_PATH: path,
    CODEX_CLI_PATH: join(root, 'bin', 'codex'),
    TEST_RETAINED_BOOTSTRAP: 'archive-solo-v1', TEST_RETAINED_BOOTSTRAP_ROOT: root,
    TEST_RETAINED_BOOTSTRAP_REPO: repo, TEST_RETAINED_BOOTSTRAP_VERSION: version,
    TEST_RETAINED_BOOTSTRAP_ARCHIVE_SHA256: digest(seedBytes),
    ANTHROPIC_BASE_URL: catalog.url, ANTHROPIC_API_KEY: 'TEST-finite-legacy-catalog',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  });
  assert.equal(fixture.appEnvironment.AGENT_TEAMS_BACKEND_DESCRIPTOR_PATH, fixture.descriptorPath);
  assert.equal(fixture.appEnvironment.AGENT_TEAMS_BACKEND_DESCRIPTOR_SHA256, fixture.pins.descriptorSha256);
  return { ...fixture, retainedOriginal: { seed, seedPath, seedSha256: digest(seedBytes), candidates, catalog,
    executable: { path, sha256: digest(bytes), source, sourceSha256, version } } };
}

export async function readRetainedOriginalEffects(root: string): Promise<FiniteImportRow[]> {
  let bytes: string;
  try { bytes = await readFile(join(root, 'finite-retained-peer.ndjson'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  assert.ok(Buffer.byteLength(bytes) < 256 * 1024);
  return bytes.trim().split('\n').filter(Boolean).map(line => {
    const value = row(JSON.parse(line)); assert.equal(value.kind, 'finite-retained-bootstrap');
    assert.ok(Number.isSafeInteger(value.pid) && Number(value.pid) > 1);
    assert.ok(['metadata-version', 'metadata-control', 'model-probe', 'bootstrap', 'turn-completed', 'sigterm', 'sigint'].includes(String(value.event)));
    return value;
  });
}
