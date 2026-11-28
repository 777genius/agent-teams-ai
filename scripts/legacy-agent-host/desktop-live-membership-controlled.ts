/** Private TEST initial peers for the original P11 OpenCode V2 membership journey. */
import assert from 'node:assert/strict';
import { mkdir, lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readTeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/readProfile.js';
import { runtimeMemberProfileSchema } from '../../packages/legacy-agent-host/dist/composition/runtimeProfile.js';
import type { CodexMemberProfile } from '../../packages/legacy-agent-host/dist/composition/runtimeProfile.js';
import { providerManagementProfileSchema } from '../../packages/legacy-agent-host/dist/management/profile.js';
import type { CodexManagementProfile } from '../../packages/legacy-agent-host/dist/management/profile.js';
import type { TeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/TeamHost.js';
import { processFacts } from '../../packages/legacy-agent-host/tests/fixtures/native-input-capture.ts';
import type { ProcessFact } from '../../packages/legacy-agent-host/tests/fixtures/native-input-capture.ts';
import { desktopNodeScriptHeader, digest, fileDigest, prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import { command } from './desktop-backend-observations.ts';

type Row = Record<string, unknown>;
const record = (value: unknown): Row => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Row;
};
type Pin = { path: string; sha256: string };
export interface DesktopFiniteMembership {
  readonly kind: 'finite-initial-peers-native-v2';
  readonly sources: readonly Pin[];
  readonly peers: readonly { provider: 'claude' | 'codex'; root: string; executable: Pin }[];
  readonly codex: CodexMemberProfile;
  readonly codexManagement: CodexManagementProfile;
}

/** Called before any fixture/model/app work. The original emulated-only admission is unchanged. */
export function desktopFiniteV2MembershipSelected(): boolean {
  const selected = process.env.LEGACY_DESKTOP_FINITE_V2_MEMBERSHIP;
  assert.ok(selected === undefined || selected === '1');
  if (selected === undefined) return false;
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
  assert.equal(process.env.LEGACY_DESKTOP_BACKEND_GO, '1');
  assert.equal(process.env.LEGACY_DESKTOP_PROOF_MODE, 'native-mixed-create-launch-ui');
  assert.equal(process.env.LEGACY_DESKTOP_MIXED_MEMBERSHIP_UI, '1');
  assert.equal(process.env.LEGACY_DESKTOP_OPENCODE_GENERATION, 'v2');
  assert.equal(process.env.LEGACY_DESKTOP_EMULATED_ONLY, undefined);
  const allowed = /^LEGACY_DESKTOP_(?:BACKEND_GO|PROOF_MODE|MIXED_MEMBERSHIP_UI|OPENCODE_GENERATION|FINITE_V2_MEMBERSHIP|CDP_PORT|TEST_DISPLAY|TEST_XAUTHORITY|TEST_FINITE_HEAP_1536|COREPACK_HOME|NODE_SHA256|HOST_ENTRY_SHA256|PNPM_PATH|PNPM_SHA256|COREPACK_PACKAGE_SHA256|COREPACK_LIBRARY_SHA256)$/u;
  for (const key of Object.keys(process.env)) if (key.startsWith('LEGACY_DESKTOP_'))
    assert.ok(allowed.test(key), 'finite V2 membership refuses ' + key);
  for (const key of ['OPENCODE_V2_EMBEDDED_BUN', 'OPENCODE_V2_EMBEDDED_GRAPH']) assert.ok(process.env[key]);
  assert.match(process.env.OPENCODE_V2_EMBEDDED_BUN_SHA256 ?? '', /^[a-f0-9]{64}$/u);
  return true;
}

/** One existing private owner; no runtime allocation, model call, task seed or saved schedule. */
export async function prepareDesktopFiniteMembershipFixture(repo: string, pnpmEntry: string) {
  assert.equal(desktopFiniteV2MembershipSelected(), true);
  const base = await prepareDesktopBackendFixture(repo, { pnpmEntry, seedUiPreferences: true, creation: true });
  // Ordinary custom-folder discovery makes this zero-session TEST project selectable before Launch.
  const configPath = join(base.root, 'claude/agent-teams-config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8')) as { general: Record<string, unknown> };
  config.general.customProjectPaths = [join(base.root, 'workspace')];
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const sources = await Promise.all([
    'tools/owned-process-broker/fixtures/claudeProviderPeer.mjs',
    'tools/owned-process-broker/fixtures/providerPeer.mjs',
    'tools/owned-process-broker/fixtures/providerDesktopPeer.mjs',
  ].map(async source => {
    const path = join(repo, source); assert.equal(await realpath(path), path);
    return { path, sha256: await fileDigest(path) };
  }));
  const selections = await Promise.all((['claude', 'codex'] as const).map(async provider => {
    const root = join(base.root, `TEST-peer-${provider}-scope`);
    for (const name of ['', 'home', 'tmp', 'config', 'data', 'cache']) await mkdir(join(root, name), { mode: 0o700 });
    const wrapper = `${desktopNodeScriptHeader(base.node)}import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';import {readFileSync,realpathSync} from 'node:fs';
for(const source of ${JSON.stringify(sources)}){assert.equal(realpathSync(source.path),source.path);assert.equal(createHash('sha256').update(readFileSync(source.path)).digest('hex'),source.sha256)}
${provider === 'codex' ? "if(process.argv.length===3&&process.argv[2]==='--version')process.stdout.write('codex-cli 0.162.0\\n');else " : ''}await import(${JSON.stringify(pathToFileURL(sources[provider === 'claude' ? 0 : 1]!.path).href)});
`;
    const path = join(base.root, 'bin', `TEST-p11-${provider}${provider === 'claude' ? '' : '.mjs'}`);
    await writeFile(path, wrapper, { mode: 0o700, flag: 'wx' });
    const environment = (role: 'runtime' | 'management'): Record<string, string> => ({
      HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'), XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'),
      PATH: `${dirname(base.node)}:/usr/bin:/bin`, SHELL: '/bin/sh',
      TEST_EMULATED_DESKTOP_PROVIDER: '1', TEST_PEER_SCENARIO: 'desktop-ui-v1', TEST_PEER_PROVIDER: provider,
      TEST_PEER_ROLE: role, TEST_DESKTOP_PEER_ROOT: root, TEST_PEER_EFFECTS: join(root, 'effects.ndjson'),
      TEST_DESKTOP_PEER_WORKSPACE: join(base.root, 'workspace'),
      ...(provider === 'claude' ? { CLAUDE_CONFIG_DIR: join(root, 'config') }
        : { CODEX_HOME: join(root, 'config'), TEST_PEER_HELPER_SHA256: sources[2]!.sha256 }),
    });
    return { provider, root, executable: { path, sha256: digest(wrapper) }, environment };
  }));
  const profile = JSON.parse(await readFile(base.profilePath, 'utf8')) as TeamHostProfile;
  assert.equal(profile.runtime, undefined); assert.equal(profile.management, undefined);
  const team = profile.teams[0]!;
  team.members[0]!.role = 'lead';
  team.members[0]!.delivery = { ...team.binding, runId: team.scope.runId, memberId: 'alice-id', generation: '1' };
  team.grants.push({ principalId: 'alice-session', memberName: 'alice', permissions: ['read', 'task.write', 'message.write'] });
  const members = selections.map(selection => runtimeMemberProfileSchema.parse({
    provider: selection.provider, teamId: team.scope.teamId, memberId: selection.provider === 'claude' ? 'alice-id' : 'TEST-codex-template',
    principalId: selection.provider === 'claude' ? 'alice-session' : 'TEST-codex-template',
    sessionId: `TEST-finite-p11-${selection.provider}`, generation: 1, configRevision: `TEST-finite-p11-${selection.provider}`,
    cwd: join(base.root, 'workspace'), model: selection.provider === 'claude' ? 'sonnet' : 'TEST-model',
    accountBinding: 'TEST-no-vendor-account', executable: selection.executable, environment: selection.environment('runtime'),
    ...(selection.provider === 'claude' ? { configNamespace: 'custom-directory', nativeTools: ['Bash'], autoAllowedTools: [],
      nativeOptions: { permissionMode: 'default', settingSources: [], effort: 'medium', fastMode: false } }
      : { protocolRevision: '0.162.0', nativeOptions: { approvalPolicy: 'on-request', sandbox: 'read-only' } }),
    limits: { queuedInputs: 2, inputBytes: 8192, outputBytes: 1_000_000, outputEvents: 1500,
      pendingInteractions: 4, timeoutMs: 45_000 },
  }));
  const claude = members[0]!, codex = members[1]!;
  assert.equal(claude.provider, 'claude'); assert.equal(codex.provider, 'codex');
  if (codex.provider !== 'codex') throw new Error('Only the original finite Codex protocol peer');
  const management = selections.map((selection, index) => providerManagementProfileSchema.parse({
    provider: selection.provider, profileId: `TEST-finite-p11-${selection.provider}-management`,
    configRevision: `TEST-finite-p11-${selection.provider}-management`, accountBinding: members[index]!.accountBinding,
    cwd: members[index]!.cwd, executable: selection.executable, environment: selection.environment('management'),
    ...(selection.provider === 'claude' ? { sdkRevision: '0.3.305', configNamespace: 'custom-directory', settingSources: [] }
      : { protocolRevision: '0.162.0' }), timeoutMs: 15000, modelProbeTimeoutMs: 30000,
  }));
  const codexManagement = management[1]!;
  if (codexManagement.provider !== 'codex') throw new Error('Only the finite Codex management selection');
  profile.runtime = { members: [claude], providerTemplates: [structuredClone(claude)] };
  profile.management = [management[0]!];
  const profileBytes = JSON.stringify(profile);
  await writeFile(base.profilePath, profileBytes, { mode: 0o600 }); base.pins.profileSha256 = digest(profileBytes);
  readTeamHostProfile(base.profilePath, base.pins.profileSha256);
  const descriptor = record(JSON.parse(await readFile(base.descriptorPath, 'utf8')));
  assert.ok(Array.isArray(descriptor.owners) && descriptor.owners.length === 1);
  const owner = record(descriptor.owners[0]); record(record(owner.profile).env).LEGACY_AGENT_HOST_PROFILE_SHA256 = base.pins.profileSha256;
  descriptor.management = [{ runtimeId: 'claude', owner: { ownerId: owner.ownerId, revision: owner.revision },
    contextId: 'local', projectPath: null, profileId: management[0]!.profileId, configRevision: management[0]!.configRevision }];
  const descriptorBytes = JSON.stringify(descriptor);
  await writeFile(base.descriptorPath, descriptorBytes, { mode: 0o600 }); base.pins.descriptorSha256 = digest(descriptorBytes);
  base.appEnvironment.AGENT_TEAMS_BACKEND_DESCRIPTOR_SHA256 = base.pins.descriptorSha256;
  const finiteInitialPeers: DesktopFiniteMembership = { kind: 'finite-initial-peers-native-v2', sources,
    peers: selections.map(({ provider, root, executable }) => ({ provider, root, executable })), codex, codexManagement };
  return { ...base, finiteInitialPeers };
}

/** Existing peer effects are evidence only; they never grant Runtime or signal authority. */
export async function readDesktopFiniteMembershipPeers(selected: Pick<DesktopFiniteMembership, 'sources' | 'peers'>) {
  const effects: Row[] = [];
  for (const peer of selected.peers) {
    for (const pin of [...selected.sources, peer.executable]) {
      assert.equal(await realpath(pin.path), pin.path); assert.equal(await fileDigest(pin.path), pin.sha256);
    }
    const path = join(peer.root, 'effects.ndjson');
    let bytes: Buffer;
    try {
      const stat = await lstat(path); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024);
      bytes = await readFile(path);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    assert.ok(bytes.length <= 1024 * 1024);
    for (const line of bytes.toString('utf8').split('\n').filter(Boolean)) {
      const row = record(JSON.parse(line)); assert.equal(row.provider, peer.provider);
      assert.ok(row.role === 'management' || row.role === 'runtime');
      assert.ok(Number.isSafeInteger(row.pid) && Number(row.pid) > 1);
      assert.notEqual(row.event, 'failure', 'a finite peer refusal is never native V2 qualification');
      if (row.event === 'input') {
        // Model probes derived from Runtime selections retain that selection's role.
        assert.equal(row.marker, 'TEST_MODEL_PROBE');
      }
      effects.push(row);
    }
  }
  assert.ok(effects.length <= 4096);
  return { effects, probeCounts: (['claude', 'codex'] as const).map(provider =>
    effects.filter(row => row.provider === provider && row.event === 'input').length) };
}

/** Same captured ps census plus Linux kernel identity for that Host and its direct children only. */
export async function desktopFiniteMembershipProcesses(group: number, fixture: {
  node: string; hostEntry: string; finiteInitialPeers: DesktopFiniteMembership;
}): Promise<ProcessFact[]> {
  assert.equal(process.platform, 'linux');
  const table = processFacts(), hosts = table.filter(row => row.groupId === group && command(row.pid) === fixture.node + ' ' + fixture.hostEntry);
  assert.ok(hosts.length <= 1);
  if (!hosts.length) return table;
  const host = hosts[0]!, selected = table.filter(row => row.pid === host.pid || row.parentPid === host.pid);
  assert.ok(selected.length <= 129, 'original finite metadata bound plus its Host');
  const readIdentity = async (pid: number) => {
    const bytes = await readFile(`/proc/${pid}/stat`, 'utf8'); assert.ok(Buffer.byteLength(bytes) <= 4096);
    const fields = bytes.slice(bytes.lastIndexOf(')') + 2).trim().split(/\s+/u);
    assert.match(fields[19] ?? '', /^\d+$/u);
    return { parentPid: Number(fields[1]), groupId: Number(fields[2]), birth: fields[19]! };
  };
  const replacements = new Map<number, ProcessFact>();
  const absent = new Set<number>();
  for (const row of selected) {
    let before: Awaited<ReturnType<typeof readIdentity>>;
    try { before = await readIdentity(row.pid); }
    catch (error) {
      // A short-lived metadata candidate can exit after ps. This is current absence only,
      // never a captured birth or owner release; the Runtime/lineage oracles still apply.
      if (row.pid !== host.pid && (error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
        absent.add(row.pid); continue;
      }
      throw error;
    }
    const executable = await realpath(`/proc/${row.pid}/exe`);
    const bytes = await readFile(`/proc/${row.pid}/cmdline`); assert.ok(bytes.length <= 128 * 1024);
    const args = bytes.toString('utf8').split('\0').filter(Boolean);
    assert.deepEqual(await readIdentity(row.pid), before, 'the observed original Linux process did not change');
    assert.equal(before.parentPid, row.parentPid); assert.equal(before.groupId, row.groupId);
    if (row.pid === host.pid) assert.deepEqual(args, [fixture.node, fixture.hostEntry]);
    else if (executable === fixture.node) {
      assert.ok(fixture.finiteInitialPeers.peers.some(peer => args[1] === peer.executable.path));
      assert.ok(args.length > 2); assert.equal(args[0], fixture.node);
    } else {
      assert.equal(executable, process.env.OPENCODE_V2_EMBEDDED_BUN);
      assert.deepEqual(args, [executable, '--no-env-file', '--config=/dev/null', '--no-install',
        join(dirname(fixture.hostEntry), 'adapters/providers/OpenCodeV2EmbeddedChild.js')]);
    }
    if (row.pid === host.pid) assert.equal(executable, fixture.node);
    replacements.set(row.pid, { ...row, birth: 'linux-starttime:' + before.birth, command: executable });
  }
  return table.filter(row => !absent.has(row.pid)).map(row => replacements.get(row.pid) ?? row);
}

export function captureDesktopFiniteMembershipScope(evidence: Row, selected: DesktopFiniteMembership) {
  evidence.scope = 'Original P11 Add/Remove/Restore/Stop/cold with captured OpenCode V2 and finite initial Claude/Codex protocol peers';
  evidence.excluded = ['Claude/Codex vendor execution', 'vendor authentication/inference', 'full mixed native qualification', 'release/default activation'];
  evidence.finiteInitialPeers = { kind: selected.kind, sources: selected.sources, peers: selected.peers,
    businessInputs: 0, linuxIdentity: 'captured ps plus exact proc executable/argv/starttime', nativeQualification: false };
}

/** Retain incomplete cleanup without replacing the original failure or skipping receipt publication. */
export async function observeDesktopFiniteMembershipCleanup(selected: DesktopFiniteMembership, evidence: Row) {
  try {
    const peers = await readDesktopFiniteMembershipPeers(selected), table = processFacts();
    const pids = [...new Set(peers.effects.filter(row => row.event === 'launch').map(row => Number(row.pid)))];
    const remaining = table.filter(row => pids.includes(row.pid));
    evidence.finiteInitialPeersAfterCleanup = { ...peers, originalPids: pids, remaining, absent: remaining.length === 0 };
    if (remaining.length) evidence.status = 'INCOMPLETE';
  } catch (error) {
    evidence.finiteInitialPeersAfterCleanup = { absent: false, observationFailed: true };
    evidence.status = 'INCOMPLETE';
  }
}
