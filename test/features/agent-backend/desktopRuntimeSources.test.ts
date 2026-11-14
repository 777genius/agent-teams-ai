// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, expect, it, vi } from 'vitest';

import { DesktopBackendFeature } from '../../../src/features/agent-backend/main/composition/DesktopBackendFeature';
import { CapturedCodexRuntimeInstaller } from '../../../src/features/codex-runtime-installer/main/application/CapturedCodexRuntimeInstaller';
import { captureCodexNativeSelection } from '../../../src/features/codex-runtime-installer/main/infrastructure/captureCodexNativeSelection';
import { CapturedOpenCodeRuntimeInstaller } from '../../../src/features/opencode-runtime-installer/main/application/CapturedOpenCodeRuntimeInstaller';
import { captureOpenCodeNativeSelection } from '../../../src/features/opencode-runtime-installer/main/infrastructure/captureOpenCodeNativeSelection';

import type { CapturedRuntimeSources } from '../../../src/features/agent-backend/main';
import type { ProviderManagementOperation } from '../../../src/features/agent-backend/main/infrastructure/CapturedProviderManagement';
import type { DesktopBackendDescriptor } from '../../../src/features/agent-backend/main/infrastructure/loadDesktopBackendDescriptor';
import type { CapturedCodexInstallRequest } from '../../../src/features/codex-runtime-installer/main/application/CapturedCodexRuntimeInstaller';
import type { TeamHostProfile } from '@agent-teams/legacy-agent-host/team-host';
import type { CodexRuntimeStatus } from '@features/codex-runtime-installer/contracts';
import type { OpenCodeRuntimeStatus } from '@shared/types';

const roots: string[] = [],
  features: DesktopBackendFeature[] = [];
afterEach(async () => {
  for (const feature of features.splice(0)) await feature.shutdown();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

async function fixture(
  runtimeId: 'claude' | 'opencode' | 'codex' = 'claude',
  withPreferences = false,
  aliases = 0,
  interruptPrepared = false
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-desktop-sources-')));
  roots.push(root);
  await mkdir(join(root, '.claude'), { mode: 0o700 });
  const preferencePaths = {
    projectRoot: join(root, 'preferences'),
    globalRoot: join(root, 'global-preferences'),
  };
  if (withPreferences)
    for (const path of Object.values(preferencePaths)) await mkdir(path, { mode: 0o700 });
  const nodeExecutable = await realpath(process.env.AGENT_BACKEND_TEST_NODE ?? process.execPath);
  const nodeSha256 = digest(await readFile(nodeExecutable));
  const hostEntry = join(root, 'TEST-host.mjs'),
    profileFile = join(root, 'TEST-private-profile.json');
  const hostUrl = pathToFileURL(
    join(process.cwd(), 'packages/legacy-agent-host/dist/composition/TeamHost.js')
  ).href;
  const commandStoreUrl = pathToFileURL(
    join(
      process.cwd(),
      'packages/legacy-agent-host/dist/adapters/providers/FileManagementCommandStore.js'
    )
  ).href;
  const source = `import { readFileSync } from 'node:fs';
import { createTeamHost } from ${JSON.stringify(hostUrl)};
${
  interruptPrepared
    ? `import { FileManagementCommandStore } from ${JSON.stringify(commandStoreUrl)};
const originalWrite = FileManagementCommandStore.prototype.write;
FileManagementCommandStore.prototype.write = function(record) {
  originalWrite.call(this, record);
  if (record.kind === 'runtime.source' && record.commandId === 'TEST-original-install' && record.phase === 'prepared')
    throw new Error('TEST interruption after original durable prepared intent');
};`
    : ''
}
const server = createTeamHost(JSON.parse(readFileSync(${JSON.stringify(profileFile)}, 'utf8')), { input: process.stdin, output: process.stdout });
void server.closed.then(() => process.exit(0));`;
  await writeFile(hostEntry, source, { mode: 0o600 });
  const bytes =
    runtimeId === 'claude'
      ? '#!/bin/sh\nprintf "2.1.34 (Claude Code)\\n"\n'
      : runtimeId === 'codex'
        ? '#!/bin/sh\nprintf "codex-cli 0.162.0\\n"\n'
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
  const scope = {
    teamId: 'TEST-source-team',
    projectId: 'TEST-project',
    workspaceId: 'TEST-workspace',
    runId: 'TEST-run',
    memberId: 'TEST-human',
    generation: '0',
  };
  const profile: TeamHostProfile = {
    schemaVersion: 1,
    principalId: 'TEST-human',
    teams: aliases
      ? [
          {
            binding: { backendId: owner.ownerId, teamId: scope.teamId, teamName: 'source-team' },
            scope,
            members: [{ memberId: 'lead', name: 'captain', role: 'lead' }],
            grants: [],
          },
        ]
      : [],
    ...(withPreferences ? { creation: { contextIds: ['TEST-context'] } } : {}),
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
  if (runtimeId === 'codex')
    profile.management = [
      {
        provider: 'codex',
        protocolRevision: '0.162.0',
        profileId: 'TEST-management',
        configRevision: 'TEST-config',
        accountBinding: 'TEST-account',
        cwd: root,
        executable: original,
        environment: { HOME: root, CODEX_HOME: root, PATH: '/usr/bin:/bin' },
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
    ...(withPreferences ? { preferences: preferencePaths } : {}),
  };
  const descriptor: DesktopBackendDescriptor = {
    schemaVersion: 1,
    defaultOwner: binding.owner,
    owners: [owner],
    handles: Array.from({ length: aliases }, (_, index) => ({
      handleId: `TEST-source-alias-${index}`,
      owner: binding.owner,
      contextId: binding.contextId,
      label: 'Source Team',
      members: [{ memberId: 'lead', label: 'captain' }],
      scope,
    })),
    ...(withPreferences
      ? { creation: { owner: binding.owner, contextIds: ['TEST-context'] } }
      : {}),
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
  return { root, original, replacement, binding, owner, open, preferencePaths };
}

function codexRequest(
  sources: CapturedRuntimeSources,
  binaryPath: string,
  current = () => true
): CapturedCodexInstallRequest {
  const check = () => {
    if (!current()) throw new Error('TEST original context revoked');
  };
  return {
    sources: Promise.resolve(sources),
    resolver: {
      fingerprint: digest(binaryPath),
      assertAuthority: check,
      assertCurrent: check,
      acceptAcquired: () => {
        throw new Error('TEST no package acquisition');
      },
      resolve: async () => {
        const original = await captureCodexNativeSelection(binaryPath, check);
        return {
          selection: {
            sourceKind: 'app-managed',
            nativeCli: { executable: original.executable, version: '0.162.0' },
          },
          assertCurrent: original.assertCurrent,
        };
      },
    },
  };
}

function capturedCodexInstaller() {
  const progress: CodexRuntimeStatus[] = [];
  const acquire = vi.fn(async (): Promise<never> => {
    throw new Error('TEST no new acquisition');
  });
  return {
    progress,
    acquire,
    service: new CapturedCodexRuntimeInstaller({
      installCaptured: acquire,
      readLatestVersion: async () => '0.169.0',
      publishCapturedStatus: (status) => {
        progress.push(status);
      },
    }),
  };
}

it('first launch preparation captures stored preferences through the real Main/Host source owner and restart keeps retained A', async () => {
  const f = await fixture('opencode', true),
    desktop = f.open();
  const globalFile = join(f.preferencePaths.globalRoot, 'global-runtime-preferences.json');
  const projectFile = join(f.preferencePaths.projectRoot, 'agent-teams-runtime-preferences.json');
  const limits = { contextTokens: 32000, outputTokens: 1000 };
  await writeFile(
    globalFile,
    JSON.stringify({
      schemaVersion: 2,
      defaultModelId: 'TEST-local/global',
      modelLimitOverrides: { 'TEST-local/global': limits },
      unrelated: 'TEST-preserved-global',
    }),
    { mode: 0o600 }
  );
  await writeFile(
    projectFile,
    JSON.stringify({
      schemaVersion: 2,
      defaultModelId: 'TEST-local/project',
      modelLimitOverrides: {
        'TEST-local/global': { ...limits, outputTokens: 500, updatedAt: 'TEST-time' },
      },
      unrelated: 'TEST-not-a-native-field',
    }),
    { mode: 0o600 }
  );
  await desktop.refreshLaunchConfiguration('TEST-context', f.root, { isCurrent: () => true });
  const sources = await desktop.captureRuntimeSources('TEST-context', f.root, 'opencode');
  const original = await sources.current();
  expect(original.preferencesDigest).toMatch(/^[a-f0-9]{64}$/);
  const target = await desktop.captureProviderManagement('TEST-context', f.root);
  const before = JSON.parse(await readFile(join(f.root, 'runtime-sources/index.json'), 'utf8'));
  expect(before.records).toHaveLength(1);
  expect(before.records[0].candidate.openCodePreferences).toEqual({
    defaultModelId: 'TEST-local/project',
    modelLimitOverrides: { 'TEST-local/global': { ...limits, outputTokens: 500 } },
  });
  expect(JSON.stringify(before)).not.toContain('TEST-not-a-native-field');
  expect(JSON.stringify(before)).not.toContain('TEST-time');
  await desktop.refreshLaunchConfiguration('TEST-context', f.root, { isCurrent: () => true });
  expect(await sources.current()).toEqual(original);
  await writeFile(
    projectFile,
    JSON.stringify({ schemaVersion: 2, defaultModelId: null, modelLimitOverrides: {} }),
    { mode: 0o600 }
  );
  const next = await target.refreshConfiguration!();
  expect(next.profileId).not.toBe(target.profileId);
  expect(target.isCurrent()).toBe(true);
  const published = await sources.current();
  expect(published.preferencesDigest).not.toBe(original.preferencesDigest);
  const after = JSON.parse(await readFile(join(f.root, 'runtime-sources/index.json'), 'utf8'));
  expect(after.records[1].candidate.openCodePreferences).toEqual({
    defaultModelId: 'TEST-local/global',
    modelLimitOverrides: { 'TEST-local/global': limits },
  });
  await desktop.shutdown();
  const restarted = f.open();
  expect(
    (await restarted.restoreProviderManagement('TEST-context', target.targetId)).profileId
  ).toBe(target.profileId);
  await restarted.refreshLaunchConfiguration('TEST-context', f.root, { isCurrent: () => true });
  expect(
    await (await restarted.captureRuntimeSources('TEST-context', f.root, 'opencode')).current()
  ).toEqual(published);
}, 20000);

it('real Main/Host publication preserves legacy target bytes and restores every retained target after restart', async () => {
  const f = await fixture('claude', false, 257),
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
  const sourceIndex = JSON.parse(
    await readFile(join(f.root, 'runtime-sources/index.json'), 'utf8')
  );
  expect(sourceIndex.records[0].grant.teamScopes).toEqual([
    { teamId: 'TEST-source-team', projectId: 'TEST-project', workspaceId: 'TEST-workspace' },
  ]);
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

    const codex = await fixture('codex'),
      codexDesktop = codex.open();
    const codexSources = await codexDesktop.captureRuntimeSources(
      'TEST-context',
      codex.root,
      'codex'
    );
    const before = await codexSources.current();
    const priorTarget = await codexDesktop.captureProviderManagement(
      'TEST-context',
      codex.root,
      undefined,
      'codex'
    );
    const captured = capturedCodexInstaller();
    expect(
      await captured.service.getStatus(codexRequest(codexSources, codex.original.path))
    ).toMatchObject({
      state: 'ready',
      source: 'captured-host',
      version: '0.162.0',
      sourceRevision: before.revision,
      updateAvailable: true,
    });
    expect(await codexSources.recover()).toBeNull();
    expect(
      await captured.service.getStatus(codexRequest(codexSources, codex.replacement.path))
    ).toMatchObject({
      sourceRevision: before.revision,
      installed: false,
    });
    expect(await codexSources.current()).toEqual(before);
    const publish = vi.fn(codexSources.publish),
      scoped = { ...codexSources, publish };
    const next = await captured.service.selectInstalled(
      codexRequest(scoped, codex.replacement.path)
    );
    expect(next).toMatchObject({ state: 'ready', version: '0.162.0', source: 'app-managed' });
    expect(next.sourceRevision).not.toBe(before.revision);
    expect(next.binaryPath).toBeUndefined();
    expect(JSON.stringify(next)).not.toMatch(/nativeExecutableDigest|TEST-cli|sha256/);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(
      await captured.service.selectInstalled(codexRequest(scoped, codex.replacement.path))
    ).toEqual(next);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(
      (await codexDesktop.restoreProviderManagement('TEST-context', priorTarget.targetId)).targetId
    ).toBe(priorTarget.targetId);
    expect(
      (await codexDesktop.captureProviderManagement('TEST-context', codex.root, undefined, 'codex'))
        .targetId
    ).not.toBe(priorTarget.targetId);
    const indexBytes = await readFile(join(codex.root, 'runtime-sources/index.json'), 'utf8');
    expect(indexBytes).not.toContain('nativeExecutableDigest');
    await codexDesktop.shutdown();
    const coldCodex = codex.open(),
      coldSources = await coldCodex.captureRuntimeSources('TEST-context', codex.root, 'codex');
    const coldPublish = vi.fn(coldSources.publish),
      coldInstaller = capturedCodexInstaller();
    expect(
      await coldInstaller.service.selectInstalled(
        codexRequest({ ...coldSources, publish: coldPublish }, codex.replacement.path)
      )
    ).toEqual(next);
    expect(coldPublish).not.toHaveBeenCalled();
    expect(coldInstaller.acquire).not.toHaveBeenCalled();
    expect(await readFile(join(codex.root, 'runtime-sources/index.json'), 'utf8')).toBe(indexBytes);
    await expect(
      coldCodex.captureRuntimeSources('TEST-foreign', codex.root, 'codex')
    ).rejects.toThrow();
    let foreground = true;
    const staleSources = {
      ...coldSources,
      current: async () => {
        const value = await coldSources.current();
        foreground = false;
        return value;
      },
    };
    await expect(
      coldInstaller.service.selectInstalled(
        codexRequest(staleSources, codex.replacement.path, () => foreground)
      )
    ).rejects.toThrow('revoked');
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

    const codex = await fixture('codex'),
      c = codex.open();
    const cs = await c.captureRuntimeSources('TEST-context', codex.root, 'codex');
    const retained = capturedCodexInstaller();
    const publish = vi.fn(async (input: Parameters<typeof cs.publish>[0]) => {
      await cs.publish(input);
      throw new Error('TEST original Codex publication ACK lost');
    });
    const lookup = vi.fn(cs.lookup);
    const codexResult = await retained.service.selectInstalled(
      codexRequest({ ...cs, publish, lookup }, codex.replacement.path)
    );
    expect(codexResult).toMatchObject({ state: 'ready', version: '0.162.0' });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledExactlyOnceWith(publish.mock.calls[0][0].commandId);
    expect(retained.acquire).not.toHaveBeenCalled();
    expect((await cs.current()).revision).toBe(codexResult.sourceRevision);
  },
  20000
);

it.skipIf(process.platform === 'win32')(
  'restarted installer resumes the Host snapshot before any new acquisition',
  async () => {
    const f = await fixture('opencode', false, 0, true),
      desktop = f.open();
    const sources = await desktop.captureRuntimeSources('TEST-context', f.root, 'opencode');
    const original = await sources.current(),
      binaryPath = join(f.root, 'TEST-interrupted-selection');
    const bytes = '#!/bin/sh\nprintf "1.19.5\\n"\n';
    await writeFile(binaryPath, bytes, { mode: 0o700 });
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

    const codex = await fixture('codex', false, 0, true),
      c = codex.open();
    const cs = await c.captureRuntimeSources('TEST-context', codex.root, 'codex');
    const seed = await cs.current();
    await expect(
      cs.publish({
        commandId: 'TEST-original-install',
        expectedRevision: seed.revision,
        nativeSelection: {
          sourceKind: 'app-managed',
          nativeCli: { executable: codex.replacement, version: '0.162.0' },
        },
      })
    ).rejects.toThrow();
    expect((await cs.lookup('TEST-original-install'))?.phase).toBe('prepared');
    await c.shutdown();
    const cold = codex.open(),
      originalSources = await cold.captureRuntimeSources('TEST-context', codex.root, 'codex');
    const recovered = capturedCodexInstaller();
    const request = codexRequest(originalSources, codex.original.path);
    request.resolver.resolve = vi.fn(async () => {
      throw new Error("TEST recovery cannot resolve today's candidate");
    });
    const recoveredStatus = await recovered.service.install(request);
    expect(recoveredStatus).toMatchObject({
      state: 'ready',
      source: 'app-managed',
      version: '0.162.0',
    });
    expect(recovered.acquire).not.toHaveBeenCalled();
    expect(request.resolver.resolve).not.toHaveBeenCalled();
    expect((await originalSources.lookup('TEST-original-install'))?.selection?.revision).toBe(
      recoveredStatus.sourceRevision
    );
  },
  20000
);
