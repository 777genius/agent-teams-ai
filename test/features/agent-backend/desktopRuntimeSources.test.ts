// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, expect, it, vi } from 'vitest';

import { DesktopBackendFeature } from '../../../src/features/agent-backend/main/composition/DesktopBackendFeature';
import { CapturedOpenCodeRuntimeInstaller } from '../../../src/features/opencode-runtime-installer/main/application/CapturedOpenCodeRuntimeInstaller';
import { captureOpenCodeNativeSelection } from '../../../src/features/opencode-runtime-installer/main/infrastructure/captureOpenCodeNativeSelection';

import type { ProviderManagementOperation } from '../../../src/features/agent-backend/main/infrastructure/CapturedProviderManagement';
import type { DesktopBackendDescriptor } from '../../../src/features/agent-backend/main/infrastructure/loadDesktopBackendDescriptor';
import type { TeamHostProfile } from '@agent-teams/legacy-agent-host/team-host';
import type { OpenCodeRuntimeStatus } from '@shared/types';

const roots: string[] = [],
  features: DesktopBackendFeature[] = [];
afterEach(async () => {
  for (const feature of features.splice(0)) await feature.shutdown();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

async function fixture(runtimeId: 'claude' | 'opencode' = 'claude') {
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
  const bytes =
    runtimeId === 'claude'
      ? '#!/bin/sh\nprintf "2.1.34 (Claude Code)\\n"\n'
      : '#!/bin/sh\nprintf "1.19.4\\n"\n';
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
  if (runtimeId === 'opencode')
    profile.management = [
      {
        provider: 'opencode',
        nativeGeneration: 'v1',
        endpoint: 'http://127.0.0.1:19182',
        profileId: 'TEST-management',
        configRevision: 'TEST-config',
        accountBinding: 'TEST-account',
        cwd: root,
        executable: original,
        environment: { HOME: root, PATH: '/usr/bin:/bin' },
        timeoutMs: 1000,
      },
    ];
  await writeFile(profileFile, JSON.stringify(profile), { mode: 0o600 });
  const binding = {
    runtimeId,
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
  const nativeSelection = {
    commandId: 'TEST-publish-2',
    expectedRevision: first.selection!.revision,
    ...(process.platform === 'win32'
      ? { candidate: { sourceKind: 'override' as const, executable: f.original } }
      : {
          nativeSelection: {
            sourceKind: 'override' as const,
            nativeCli: { executable: f.original, version: '2.1.34' },
          },
        }),
  };
  const second = await sources.publish(nativeSelection);
  expect(second.selection?.cliVersion).toBe(process.platform === 'win32' ? undefined : '2.1.34');
  expect(await sources.recover()).toBeNull();
  expect(await sources.lookup('TEST-publish-1')).toEqual(first);
  expect(JSON.stringify(await sources.current())).not.toContain(f.root);
  await desktop.shutdown();
  const restarted = f.open();
  expect(
    await (
      await restarted.captureRuntimeSources('TEST-context', f.root, 'claude')
    ).publish(nativeSelection)
  ).toEqual(second);
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

it.skipIf(process.platform === 'win32')(
  'installed CLI is admitted by the real Host and immediate Refresh reuses its exact receipt',
  async () => {
    const f = await fixture('opencode'),
      desktop = f.open();
    const oldTarget = await desktop.captureProviderManagement('TEST-context', f.root);
    const sources = await desktop.captureRuntimeSources('TEST-context', f.root, 'opencode');
    const binaryPath = join(f.root, 'TEST-installed-opencode'),
      marker = join(f.root, 'TEST-version-observation');
    await writeFile(binaryPath, `#!/bin/sh\nprintf "1.19.5\\n"\nprintf x >> '${marker}'\n`, {
      mode: 0o700,
    });
    const selected: OpenCodeRuntimeStatus = {
      installed: true,
      state: 'ready',
      source: 'app-managed',
      version: '1.19.5',
      binaryPath,
    };
    const install = vi.fn(async () => selected),
      getReadinessStatus = vi.fn(async () => selected);
    const service = new CapturedOpenCodeRuntimeInstaller({
      native: { install, getReadinessStatus },
      captureSelection: (status, original) =>
        captureOpenCodeNativeSelection(status, original, {
          captureInstalled: async () => {
            throw new Error('V1 cannot acquire V2 support');
          },
        }),
    });
    const status = await service.install(sources, { generation: 'v1' });
    expect(status).toMatchObject({
      installed: true,
      state: 'ready',
      source: 'app-managed',
      version: '1.19.5',
    });
    expect(status.binaryPath).toBeUndefined();
    expect((await sources.current()).revision).toBe(status.sourceRevision);
    expect((await desktop.captureProviderManagement('TEST-context', f.root)).targetId).not.toBe(
      oldTarget.targetId
    );
    expect(
      (await desktop.restoreProviderManagement('TEST-context', oldTarget.targetId)).profileId
    ).toBe(oldTarget.profileId);
    expect(await service.selectInstalled(sources)).toEqual(status);
    expect(await readFile(marker, 'utf8')).toBe('x');
    expect(install).toHaveBeenCalledExactlyOnceWith({ generation: 'v1' });
    await desktop.shutdown();
    const restarted = f.open();
    expect(
      (await (await restarted.captureRuntimeSources('TEST-context', f.root, 'opencode')).current())
        .revision
    ).toBe(status.sourceRevision);
  },
  20000
);

it.skipIf(process.platform === 'win32')(
  'installer lost ACK reports its original publication even when a later selection is current',
  async () => {
    const f = await fixture('opencode'),
      desktop = f.open();
    const sources = await desktop.captureRuntimeSources('TEST-context', f.root, 'opencode');
    const binaryPath = join(f.root, 'TEST-installed-B'),
      nextPath = join(f.root, 'TEST-installed-C');
    await writeFile(binaryPath, '#!/bin/sh\nprintf "1.19.5\\n"\n', { mode: 0o700 });
    await writeFile(nextPath, '#!/bin/sh\nprintf "1.19.6\\n"\n', { mode: 0o700 });
    const native: OpenCodeRuntimeStatus = {
      installed: true,
      source: 'path',
      state: 'ready',
      version: '1.19.5',
      binaryPath,
    };
    let originalRevision: string | undefined;
    const service = new CapturedOpenCodeRuntimeInstaller({
      native: {
        install: async () => native,
        getReadinessStatus: async () => native,
      },
      captureSelection: (status, original) =>
        captureOpenCodeNativeSelection(status, original, {
          captureInstalled: async () => {
            throw new Error('Unexpected V2 support');
          },
        }),
    });
    const result = await service.install(
      {
        ...sources,
        publish: async (input) => {
          const first = await sources.publish(input);
          originalRevision = first.selection!.revision;
          await sources.publish({
            commandId: 'TEST-independent-C',
            expectedRevision: originalRevision,
            nativeSelection: {
              sourceKind: 'override',
              nativeCli: {
                executable: { path: nextPath, sha256: digest(await readFile(nextPath)) },
                version: '1.19.6',
                generation: 'v1',
              },
            },
          });
          throw new Error('TEST-publication-ACK-lost');
        },
      },
      { generation: 'v1' }
    );
    expect(result).toMatchObject({
      state: 'ready',
      version: '1.19.5',
      sourceRevision: originalRevision,
    });
    expect((await sources.current()).cliVersion).toBe('1.19.6');
    expect(result.sourceRevision).not.toBe((await sources.current()).revision);
  },
  20000
);

it.skipIf(process.platform === 'win32')(
  'restarted installer resumes the Host snapshot before any new acquisition',
  async () => {
    const f = await fixture('opencode'),
      desktop = f.open();
    const sources = await desktop.captureRuntimeSources('TEST-context', f.root, 'opencode');
    const original = await sources.current(),
      binaryPath = join(f.root, 'TEST-interrupted-selection');
    const bytes = '#!/bin/sh\nprintf "1.19.5\\n"\n';
    await expect(
      sources.publish({
        commandId: 'TEST-original-install',
        expectedRevision: original.revision,
        nativeSelection: {
          sourceKind: 'app-managed',
          nativeCli: {
            executable: { path: binaryPath, sha256: digest(bytes) },
            version: '1.19.5',
            generation: 'v1',
          },
        },
      })
    ).rejects.toThrow();
    expect((await sources.lookup('TEST-original-install'))?.phase).toBe('prepared');
    await desktop.shutdown();
    await writeFile(binaryPath, bytes, { mode: 0o700 });
    const install = vi.fn(async (): Promise<OpenCodeRuntimeStatus> => {
      throw new Error('New acquisition forbidden');
    });
    const service = new CapturedOpenCodeRuntimeInstaller({
      native: { install, getReadinessStatus: install },
      captureSelection: async () => {
        throw new Error('Original candidate must come from Host');
      },
    });
    const restartedSources = await f
      .open()
      .captureRuntimeSources('TEST-context', f.root, 'opencode');
    const status = await service.install(restartedSources, { generation: 'v1' });
    expect(status).toMatchObject({ state: 'ready', version: '1.19.5' });
    expect(install).not.toHaveBeenCalled();
    expect((await restartedSources.lookup('TEST-original-install'))?.selection?.revision).toBe(
      status.sourceRevision
    );
  },
  20000
);
