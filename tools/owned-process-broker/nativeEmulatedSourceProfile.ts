/** TEST immutable A/B selections; every runnable image is pinned Node or the original Windows broker. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readTeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/readProfile.js';
import { runtimeMemberProfileSchema } from '../../packages/legacy-agent-host/dist/composition/runtimeProfile.js';
import { providerManagementProfileSchema } from '../../packages/legacy-agent-host/dist/management/profile.js';
import { fileHash } from './nativeEmulatedProfile';

import type { TeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/TeamHost.js';
import type { DesktopBackendDescriptor } from '../../src/features/agent-backend/main/infrastructure/loadDesktopBackendDescriptor';
import type { SelectedHostProfile } from '../../src/features/agent-backend/main/infrastructure/selectedHostProfile';

export type EmulatedSourceProvider = 'codex' | 'claude' | 'opencode';
export const finiteSourceProbe = 'Reply only OK. Do not use tools, access files or run commands.';

async function endpoint(): Promise<string> {
  const server = createServer();
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  return `http://127.0.0.1:${address.port}`;
}

export async function prepareEmulatedSourceProfile(sandbox: string, broker: string,
  provider: EmulatedSourceProvider) {
  assert.equal(process.platform, 'win32');
  assert.ok(process.arch === 'x64' || process.arch === 'arm64');
  const root = join(sandbox, `TEST-desktop-backend-${provider}${randomUUID().replaceAll('-', '')}`);
  mkdirSync(root); assert.equal(realpathSync(root), root);
  for (const name of ['workspace', 'storage', 'bin', 'host-home', 'host-tmp']) mkdirSync(join(root, name));
  const workspace = join(root, 'workspace'), peerRoot = join(root, `TEST-peer-${provider}-scope`);
  for (const name of ['', 'home', 'tmp', 'config', 'data', 'cache']) mkdirSync(join(peerRoot, name));
  const node = realpathSync(process.execPath), systemRoot = process.env.SystemRoot;
  assert.ok(systemRoot && /^[A-Za-z]:\\/.test(systemRoot));
  const peerNames = provider === 'claude' ? ['claudeProviderPeer.mjs'] : ['providerPeer.mjs', 'providerDesktopPeer.mjs'];
  const helpers = peerNames.map(name => {
    const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
    assert.equal(realpathSync(path), path); return { path, sha256: fileHash(path) };
  });
  const entries = join(root, 'source-entries.ndjson'), effects = join(peerRoot, 'effects.ndjson');
  const versions = { A: provider === 'codex' ? '0.162.0' : provider === 'claude' ? '2.1.34' : '1.19.4',
    B: provider === 'codex' ? '0.169.0' : provider === 'claude' ? '2.1.34' : '1.19.4' };
  const images = {} as Record<'A' | 'B', { path: string; sha256: string; entry: { path: string; sha256: string } }>;
  for (const source of ['A', 'B'] as const) {
    const entry = join(root, 'bin', `TEST-source-${source}.mjs`);
    const output = provider === 'codex' ? `codex-cli ${versions[source]}`
      : provider === 'claude' ? `${versions[source]} (Claude Code)` : versions[source];
    const code = `import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';import {appendFileSync,readFileSync,realpathSync} from 'node:fs';
assert.equal(realpathSync(process.execPath),${JSON.stringify(node)});
assert.equal(createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),${JSON.stringify(fileHash(node))});
const argv=process.argv.slice(2);
const fact={provider:${JSON.stringify(provider)},source:${JSON.stringify(source)},pid:process.pid,parentPid:process.ppid};
if(argv.length===1&&argv[0]==='--version'){
  assert.equal(Object.keys(process.env).some(key=>key.startsWith('TEST_')),false);
  assert.equal(process.env.NODE_OPTIONS,undefined);assert.equal(process.env.BUN_OPTIONS,undefined);
  appendFileSync(${JSON.stringify(entries)},JSON.stringify({...fact,event:'version'})+'\\n');
  process.stdout.write(${JSON.stringify(output + '\n')});
}else{
  assert.equal(process.env.TEST_EMULATED_DESKTOP_PROVIDER,'1');assert.equal(process.env.TEST_EMULATED_WINDOWS_PROVIDER,undefined);
  assert.ok(process.env.TEST_PEER_ROLE==='runtime'||process.env.TEST_PEER_ROLE==='management');
  for(const source of ${JSON.stringify(helpers)}){assert.equal(realpathSync(source.path),source.path);assert.equal(createHash('sha256').update(readFileSync(source.path)).digest('hex'),source.sha256)}
  appendFileSync(${JSON.stringify(entries)},JSON.stringify({...fact,event:'peer',role:process.env.TEST_PEER_ROLE})+'\\n');
  await import(${JSON.stringify(pathToFileURL(helpers[0]!.path).href)});
}
`;
    writeFileSync(entry, code, { flag: 'wx' });
    const wrapper = join(root, 'bin', `TEST source ${source}.cmd`);
    writeFileSync(wrapper, provider === 'codex'
      ? `@echo off\r\nset "_prog=node"\r\n"%_prog%" "${entry}" %*\r\n`
      : `@echo off\r\n"${node}" "${entry}" %*\r\n`, { flag: 'wx' });
    images[source] = { path: realpathSync(wrapper), sha256: fileHash(wrapper), entry: { path: entry, sha256: fileHash(entry) } };
  }
  assert.notEqual(images.A.sha256, images.B.sha256); assert.notEqual(images.A.entry.sha256, images.B.entry.sha256);
  const windowsBroker = { path: broker, sha256: fileHash(broker), arch: process.arch,
    protocol: 1 as const, capability: 'service-scopes-v1' as const };
  const environment = (role: 'runtime' | 'management'): Record<string, string> => ({
    HOME: join(peerRoot, 'home'), USERPROFILE: join(peerRoot, 'home'),
    TMPDIR: join(peerRoot, 'tmp'), TEMP: join(peerRoot, 'tmp'), TMP: join(peerRoot, 'tmp'),
    XDG_CONFIG_HOME: join(peerRoot, 'config'), XDG_DATA_HOME: join(peerRoot, 'data'), XDG_CACHE_HOME: join(peerRoot, 'cache'),
    SystemRoot: systemRoot, PATH: [dirname(node), join(systemRoot, 'System32')].join(';'),
    ...(provider === 'claude' ? { CLAUDE_CONFIG_DIR: join(peerRoot, 'config') }
      : provider === 'codex' ? { CODEX_HOME: join(peerRoot, 'config') } : {}),
    TEST_EMULATED_DESKTOP_PROVIDER: '1', TEST_PEER_SCENARIO: 'desktop-ui-v1', TEST_PEER_PROVIDER: provider,
    TEST_PEER_ROLE: role, TEST_DESKTOP_PEER_ROOT: peerRoot, TEST_DESKTOP_PEER_WORKSPACE: workspace, TEST_PEER_EFFECTS: effects,
    ...(provider !== 'claude' ? { TEST_PEER_HELPER_SHA256: helpers[1]!.sha256 } : {}),
    ...(provider === 'opencode' ? {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ autoupdate: false, share: 'disabled',
        model: 'TEST-provider/TEST-model', small_model: 'TEST-provider/TEST-model', provider: { 'TEST-provider': {
          npm: '@ai-sdk/openai-compatible', name: 'TEST provider', options: { baseURL: 'http://127.0.0.1:19999/TEST-no-network' },
          models: { 'TEST-model': { name: 'TEST model', limit: { context: 4096, output: 1024 },
            variants: { low: { reasoningEffort: 'low' }, high: { reasoningEffort: 'high' } } } } } },
        agent: { build: { mode: 'primary' } }, compaction: { auto: false } }),
      OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_TELEMETRY: '1', OPENCODE_DISABLE_SHARE: '1',
    } : {}),
  });
  const nonce = randomUUID(), ownerId = `TEST-source-${provider}-${nonce}`, contextId = 'TEST-source-context';
  const providerId = provider === 'claude' ? 'anthropic' : provider, model = provider === 'claude' ? 'sonnet' : 'TEST-model';
  const savedSettings: NonNullable<TeamHostProfile['teams'][number]['savedSettings']> = {
    cwd: workspace, providerId, model: provider === 'opencode' ? 'TEST-provider/TEST-model' : model,
    prompt: '', skipPermissions: false, syncModelsWithLead: true,
    ...(provider === 'claude' ? { effort: 'low' as const, fastMode: 'off' as const } : {}) };
  const teams = (['A', 'B'] as const).map((source): TeamHostProfile['teams'][number] => {
    const binding = { backendId: ownerId, teamId: `TEST-source-team-${source}`, teamName: `test-source-team-${source.toLowerCase()}` };
    const scope = { projectId: 'TEST-project', workspaceId: 'TEST-workspace', teamId: binding.teamId,
      runId: `TEST-source-run-${source}`, memberId: 'human', generation: '1' };
    return { binding, scope, savedSettings,
      members: [{ memberId: 'alice-id', name: 'alice', role: 'lead' as const,
        delivery: { ...binding, runId: scope.runId, memberId: 'alice-id', generation: '1' } }],
      grants: [{ principalId: 'human', memberName: 'user', permissions: ['read', 'task.write', 'message.write', 'admin'] },
        { principalId: 'alice-session', memberName: 'alice', permissions: ['read', 'task.write', 'message.write'] }] };
  });
  const members = await Promise.all(teams.map(async team => runtimeMemberProfileSchema.parse({
    provider, teamId: team.binding.teamId, memberId: 'alice-id', principalId: 'alice-session',
    sessionId: randomUUID(), generation: 1, configRevision: 'TEST-source-seed-runtime',
    cwd: workspace, model, accountBinding: 'TEST-no-vendor-account',
    executable: { path: images.A.path, sha256: images.A.sha256 }, windowsBroker, environment: environment('runtime'),
    ...(provider === 'claude' ? { configNamespace: 'custom-directory', nativeTools: ['Read', 'Write', 'AskUserQuestion'], autoAllowedTools: [],
      nativeOptions: { permissionMode: 'default', settingSources: [], effort: 'low', fastMode: false } }
      : provider === 'codex' ? { protocolRevision: '0.162.0', nativeOptions: { approvalPolicy: 'on-request', sandbox: 'read-only' } }
      : { protocolRevision: '1.19.4', endpoint: await endpoint(), nativeOptions: { providerId: 'TEST-provider', agent: 'build', toolApprovalMode: 'manual' } }),
    limits: { queuedInputs: 2, inputBytes: 65536, outputBytes: 1_000_000, outputEvents: 1500, pendingInteractions: 4, timeoutMs: 90000 },
  })));
  const management = providerManagementProfileSchema.parse({ provider, profileId: `TEST-source-${provider}-management`,
    configRevision: 'TEST-source-management-1', accountBinding: 'TEST-no-vendor-account', cwd: workspace,
    executable: { path: images.A.path, sha256: images.A.sha256 }, windowsBroker, environment: environment('management'),
    timeoutMs: 15000, modelProbeTimeoutMs: 30000,
    ...(provider === 'claude' ? { sdkRevision: '0.3.305', configNamespace: 'custom-directory', settingSources: [] }
      : provider === 'codex' ? { protocolRevision: '0.162.0' } : { endpoint: await endpoint() }),
  });
  const cli = realpathSync(fileURLToPath(new URL('../../packages/legacy-agent-host/dist/cli.js', import.meta.url)));
  const hostEntry = join(root, 'TEST-source-host.mjs');
  writeFileSync(hostEntry, `await import(${JSON.stringify(pathToFileURL(cli).href)});\n`, { flag: 'wx' });
  const profile: TeamHostProfile = { schemaVersion: 1, principalId: 'human', processCustody: { kind: 'main-windows-v1' },
    owner: { ownerId, revision: 'TEST-1', storageRoot: join(root, 'storage'), profileId: `TEST-source-profile-${nonce}`,
      protocolVersion: 1, buildId: 'TEST-source-emulated', nodeSha256: fileHash(node), hostEntrySha256: fileHash(hostEntry) },
    creation: { contextIds: [contextId] }, teams, runtime: { members, providerTemplates: [structuredClone(members[0]!)] },
    management: [management] };
  const profilePath = join(root, 'TEST-source-profile.json');
  writeFileSync(profilePath, JSON.stringify(profile), { mode: 0o600, flag: 'wx' });
  readTeamHostProfile(profilePath, fileHash(profilePath));
  const host: SelectedHostProfile = { profileId: profile.owner.profileId, nodeExecutable: node, nodeVersion: process.version,
    nodeSha256: fileHash(node), hostEntry, hostEntrySha256: fileHash(hostEntry), expectedBuildId: profile.owner.buildId,
    cwd: root, env: { HOME: join(root, 'host-home'), TMPDIR: join(root, 'host-tmp'), TEMP: join(root, 'host-tmp'),
      TMP: join(root, 'host-tmp'), SystemRoot: systemRoot, PATH: [dirname(node), join(systemRoot, 'System32')].join(';'),
      LEGACY_AGENT_HOST_PROFILE_PATH: profilePath, LEGACY_AGENT_HOST_PROFILE_SHA256: fileHash(profilePath) },
    startupTimeoutMs: 10000, requestTimeoutMs: 15000, writeTimeoutMs: 5000, shutdownTimeoutMs: 1000 };
  const owner = { ownerId, revision: profile.owner.revision };
  const descriptor: DesktopBackendDescriptor = { schemaVersion: 1, defaultOwner: owner,
    owners: [{ ...owner, storageRoot: profile.owner.storageRoot, profile: host }],
    handles: teams.map(team => ({ handleId: team.binding.teamId, owner, contextId, label: team.binding.teamName,
      members: [{ memberId: 'alice-id', label: 'alice' }], scope: team.scope })),
    creation: { owner, contextIds: [contextId] },
    management: [{ runtimeId: provider, owner, contextId, projectPath: workspace,
      profileId: management.profileId, configRevision: management.configRevision }] };
  const descriptorPath = join(root, 'TEST-source-descriptor.json');
  writeFileSync(descriptorPath, JSON.stringify(descriptor), { mode: 0o600, flag: 'wx' });
  const ownSources = ['nativeEmulatedSourceProfile.ts', 'nativeEmulatedSourceScenario.ts', 'nativeEmulatedProviderGate.ts',
    'nativeEmulatedProfile.ts', 'nativeGateContext.ts', 'nativeGateEvents.ts'].map(name => fileURLToPath(new URL(name, import.meta.url)));
  const pins = [...new Set([node, broker, cli, hostEntry, profilePath, descriptorPath, ...ownSources,
    ...helpers.map(value => value.path), ...Object.values(images).flatMap(value => [value.path, value.entry.path])])]
    .map(path => ({ path, sha256: fileHash(path) }));
  return { root, workspace, provider, providerId, model, profile, host, entries, effects, images, versions, pins,
    descriptorSelection: { path: descriptorPath, sha256: fileHash(descriptorPath) } };
}
