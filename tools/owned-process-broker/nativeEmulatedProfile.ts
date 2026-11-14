import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { SelectedHostProfile } from '../../src/features/agent-backend/main/infrastructure/selectedHostProfile';
import type { TeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/TeamHost.js';
import type { RuntimeMemberProfile } from '../../packages/legacy-agent-host/dist/composition/runtimeProfile.js';

export const fileHash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

/** Every executable is this checkout's Node or C++ actor; no runtime installation/discovery. */
export async function prepareEmulatedProfile(sandbox: string, broker: string, actor: string,
  provider: 'codex' | 'opencode') {
  const selectedRoot = join(sandbox, `TEST ${provider} Я`); mkdirSync(selectedRoot);
  const root = realpathSync.native(selectedRoot);
  for (const name of ['home', 'tmp', 'config', 'data', 'cache', 'workspace', 'storage']) mkdirSync(join(root, name));
  const node = realpathSync.native(process.execPath), systemRoot = process.env.SystemRoot;
  assert.ok(systemRoot && /^[A-Za-z]:\\/.test(systemRoot));
  const peer = realpathSync(fileURLToPath(new URL('./fixtures/providerPeer.mjs', import.meta.url)));
  const wrapper = join(root, `TEST ${provider}.cmd`), effects = join(root, 'effects.ndjson');
  // Exercise both the known npm direct recipe and the existing opaque %* cmd recipe.
  writeFileSync(wrapper, provider === 'codex'
    ? `@echo off\r\nset "_prog=node"\r\n"%_prog%" "${peer}" %*\r\n`
    : `@echo off\r\n"${node}" "${peer}" %*\r\n`, { flag: 'wx' });
  const environment = { HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
    CODEX_HOME: join(root, 'config'), XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'),
    TEMP: join(root, 'tmp'), TMP: join(root, 'tmp'), SystemRoot: systemRoot,
    PATH: [dirname(node), join(systemRoot, 'System32')].join(';'),
    TEST_EMULATED_WINDOWS_PROVIDER: '1', TEST_PEER_PROVIDER: provider,
    TEST_PROCESS_FIXTURE: actor, TEST_PROCESS_FIXTURE_SHA256: fileHash(actor), TEST_PEER_EFFECTS: effects };
  assert.ok(process.arch === 'x64' || process.arch === 'arm64');
  const nonce = randomUUID(), profileId = 'TEST-emulated-' + nonce;
  const binding = { backendId: 'TEST-owner-' + nonce, teamId: 'TEST-team', teamName: 'test-emulated-processes' };
  const common = { teamId: binding.teamId, memberId: 'alice-id', principalId: 'alice-session',
    sessionId: 'TEST-session-' + nonce, generation: 1, configRevision: 'TEST-native-1',
    cwd: join(root, 'workspace'), model: 'TEST-model', accountBinding: 'TEST-no-vendor-account', environment,
    executable: { path: realpathSync(wrapper), sha256: fileHash(wrapper) },
    windowsBroker: { path: broker, sha256: fileHash(broker), arch: process.arch, protocol: 1 as const,
      capability: 'service-scopes-v1' as const },
    limits: { queuedInputs: 2, inputBytes: 65536, outputEvents: 1000, outputBytes: 1_000_000,
      pendingInteractions: 2, timeoutMs: 15000 } };
  const member: RuntimeMemberProfile = provider === 'codex'
    ? { ...common, provider, protocolRevision: '0.162.0', nativeOptions: { approvalPolicy: 'never', sandbox: 'read-only' } }
    : { ...common, provider, protocolRevision: '1.18.35', endpoint: `http://127.0.0.1:${await reservePort()}`,
      nativeOptions: { providerId: 'TEST-provider', agent: 'build' } };
  const cli = realpathSync(fileURLToPath(new URL('../../packages/legacy-agent-host/dist/cli.js', import.meta.url)));
  const hostEntry = join(root, 'TEST-host.mjs');
  writeFileSync(hostEntry, `await import(${JSON.stringify(pathToFileURL(cli).href)});\n`, { flag: 'wx' });
  const profile: TeamHostProfile = { schemaVersion: 1,
    owner: { ownerId: binding.backendId, revision: 'TEST-1', storageRoot: join(root, 'storage'),
      profileId, protocolVersion: 1, buildId: 'TEST-emulated-processes',
      nodeSha256: fileHash(node), hostEntrySha256: fileHash(hostEntry) },
    principalId: 'human', processCustody: { kind: 'main-windows-v1' },
    teams: [{ binding, scope: { projectId: 'TEST-project', workspaceId: 'TEST-workspace',
      teamId: binding.teamId, runId: 'TEST-run', memberId: 'human', generation: '1' },
      members: [{ memberId: 'alice-id', name: 'alice', role: 'member',
        delivery: { ...binding, runId: 'TEST-run', memberId: 'alice-id', generation: '1' } }],
      grants: [{ principalId: 'human', memberName: 'user', permissions: ['read', 'task.write', 'message.write', 'admin'] },
        { principalId: 'alice-session', memberName: 'alice', permissions: ['read', 'task.write', 'message.write', 'process.write'] }] }],
    runtime: { members: [member] } };
  const source = join(root, 'TEST-profile.json'); writeFileSync(source, JSON.stringify(profile), { flag: 'wx' });
  const host: SelectedHostProfile = { profileId, nodeExecutable: node, nodeVersion: process.version,
    nodeSha256: profile.owner.nodeSha256, hostEntry: realpathSync.native(hostEntry), hostEntrySha256: profile.owner.hostEntrySha256,
    expectedBuildId: profile.owner.buildId, cwd: root,
    env: { ...environment, LEGACY_AGENT_HOST_PROFILE_PATH: source, LEGACY_AGENT_HOST_PROFILE_SHA256: fileHash(source) },
    startupTimeoutMs: 10000, requestTimeoutMs: 15000, writeTimeoutMs: 5000, shutdownTimeoutMs: 1000 };
  return { root, profile, host, effects,
    pins: { node: fileHash(node), peer: fileHash(peer), wrapper: fileHash(wrapper), cli: fileHash(cli), source: fileHash(source) } };
}
