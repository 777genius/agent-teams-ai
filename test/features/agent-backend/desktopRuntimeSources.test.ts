// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { DesktopBackendFeature } from '../../../src/features/agent-backend/main/composition/DesktopBackendFeature';
import type { DesktopBackendDescriptor } from '../../../src/features/agent-backend/main/infrastructure/loadDesktopBackendDescriptor';
import type { ProviderManagementOperation } from '../../../src/features/agent-backend/main/infrastructure/CapturedProviderManagement';
import type { TeamHostProfile } from '@agent-teams/legacy-agent-host/team-host';

const roots: string[] = [],
  features: DesktopBackendFeature[] = [];
afterEach(async () => {
  for (const feature of features.splice(0)) await feature.shutdown();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-desktop-sources-')));
  roots.push(root);
  await mkdir(join(root, '.claude'), { mode: 0o700 });
  const nodeExecutable = await realpath(process.env.AGENT_BACKEND_TEST_NODE ?? process.execPath);
  const nodeSha256 = digest(await readFile(nodeExecutable));
  const hostEntry = join(root, 'TEST-host.mjs'),
    profileFile = join(root, 'TEST-private-profile.json');
  const hostUrl = pathToFileURL(
    join(process.cwd(), 'packages/legacy-agent-host/dist/composition/TeamHost.js')
  ).href;
  const source = `import { readFileSync } from 'node:fs';
import { createTeamHost } from ${JSON.stringify(hostUrl)};
const server = createTeamHost(JSON.parse(readFileSync(${JSON.stringify(profileFile)}, 'utf8')), { input: process.stdin, output: process.stdout });
void server.closed.then(() => process.exit(0));`;
  await writeFile(hostEntry, source, { mode: 0o600 });
  const bytes = '#!/bin/sh\nprintf TEST-runtime-selection\n';
  const original = { path: join(root, 'TEST-cli-seed'), sha256: digest(bytes) };
  const replacement = { path: join(root, 'TEST-cli-repaired'), sha256: digest(bytes) };
  for (const executable of [original, replacement])
    await writeFile(executable.path, bytes, { mode: 0o700 });
  const owner = {
    ownerId: 'TEST-owner',
    revision: 'TEST-v1',
    storageRoot: root,
    profile: {
      nodeExecutable,
      nodeSha256,
      nodeVersion: execFileSync(nodeExecutable, ['--version'], {
        env: {},
        encoding: 'utf8',
      }).trim(),
      hostEntry,
      hostEntrySha256: digest(source),
      profileId: 'TEST-bootstrap',
      expectedBuildId: 'TEST-build',
      cwd: root,
      env: { HOME: root, TMPDIR: root },
      startupTimeoutMs: 5000,
      requestTimeoutMs: 5000,
      writeTimeoutMs: 1000,
      shutdownTimeoutMs: 3000,
    },
  };
  const profile: TeamHostProfile = {
    schemaVersion: 1,
    principalId: 'TEST-human',
    teams: [],
    owner: {
      ownerId: owner.ownerId,
      revision: owner.revision,
      storageRoot: root,
      profileId: owner.profile.profileId,
      protocolVersion: 1,
      buildId: owner.profile.expectedBuildId,
      nodeSha256,
      hostEntrySha256: owner.profile.hostEntrySha256,
    },
    management: [
      {
        provider: 'claude',
        sdkRevision: '0.3.305',
        profileId: 'TEST-management',
        configRevision: 'TEST-config',
        configNamespace: 'native-default',
        accountBinding: 'TEST-account',
        cwd: root,
        executable: original,
        environment: { HOME: root, PATH: '/usr/bin' },
        timeoutMs: 1000,
      },
    ],
  };
  await writeFile(profileFile, JSON.stringify(profile), { mode: 0o600 });
  const binding = {
    runtimeId: 'claude' as const,
    owner: { ownerId: owner.ownerId, revision: owner.revision },
    contextId: 'TEST-context',
    projectPath: root,
    profileId: 'TEST-management',
    configRevision: 'TEST-config',
  };
  const descriptor: DesktopBackendDescriptor = {
    schemaVersion: 1,
    defaultOwner: binding.owner,
    owners: [owner],
    handles: [],
    management: [binding],
  };
  const descriptorPath = join(root, 'TEST-descriptor.json'),
    descriptorBytes = JSON.stringify(descriptor);
  await writeFile(descriptorPath, descriptorBytes, { mode: 0o600 });
  const options = {
    descriptor: { path: descriptorPath, sha256: digest(descriptorBytes) },
    bindingDirectory: join(root, 'bindings'),
  };
  const open = () => {
    const feature = new DesktopBackendFeature(options);
    features.push(feature);
    return feature;
  };
  return { root, original, replacement, binding, owner, open };
}

it('real Main/Host publication preserves legacy target bytes and restores every retained target after restart', async () => {
  const f = await fixture(),
    desktop = f.open();
  const seed = await desktop.captureProviderManagement('TEST-context', f.root, undefined, 'claude');
  expect(seed.targetId).toBe(digest(JSON.stringify({ selected: f.binding, owner: f.owner })));
  const sources = await desktop.captureRuntimeSources('TEST-context', f.root, 'claude');
  const original = await sources.current();
  expect(original.sourceId).toBe(seed.targetId);
  const first = await sources.publish({
    commandId: 'TEST-publish-1',
    expectedRevision: original.revision,
    candidate: { sourceKind: 'app-managed', executable: f.replacement },
  });
  const selected = await desktop.captureProviderManagement(
    'TEST-context',
    f.root,
    undefined,
    'claude'
  );
  expect(selected.profileId).toBe(first.selection?.profileId);
  expect(selected.targetId).not.toBe(seed.targetId);
  expect((await desktop.restoreProviderManagement('TEST-context', seed.targetId)).targetId).toBe(
    seed.targetId
  );
  expect(seed.isCurrent()).toBe(true);
  const skills = await seed.request('skills.capture', { scope: 'project', rootKind: 'claude' });
  expect(skills).toMatchObject({ ok: true });
  await expect(
    selected.request('runtime.source.publish' as ProviderManagementOperation, {})
  ).rejects.toMatchObject({ code: 'invalid-binding' });
  await sources.publish({
    commandId: 'TEST-publish-2',
    expectedRevision: first.selection!.revision,
    candidate: { sourceKind: 'override', executable: f.original },
  });
  expect(await sources.lookup('TEST-publish-1')).toEqual(first);
  expect(JSON.stringify(await sources.current())).not.toContain(f.root);
  await desktop.shutdown();
  const restarted = f.open();
  const restored = await restarted.restoreProviderManagement('TEST-context', selected.targetId);
  expect(restored.profileId).toBe(selected.profileId);
  expect(restored.targetId).toBe(selected.targetId);
  expect(
    await restored.request('skills.capture', { scope: 'project', rootKind: 'claude' })
  ).toMatchObject({ ok: true });
  expect(
    (await restarted.captureProviderManagement('TEST-context', f.root, undefined, 'claude'))
      .targetId
  ).not.toBe(restored.targetId);
  await expect(
    restarted.captureRuntimeSources('TEST-foreign', f.root, 'claude')
  ).rejects.toMatchObject({ code: 'unavailable' });
}, 20000);
