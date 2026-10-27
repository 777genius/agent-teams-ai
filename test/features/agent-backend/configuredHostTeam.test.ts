// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  hostTeamSelectionKey,
  TeamCreationRefusal,
} from '../../../src/features/agent-backend/contracts';
import {
  CapturedHostClient,
  createConfiguredHostTeam,
  DesktopBackendFeature,
} from '../../../src/features/agent-backend/main';

import type {
  DesktopBackendDescriptor,
  DesktopBackendFeatureOptions,
} from '../../../src/features/agent-backend/main';
import type { TeamCreateConfigRequest } from '../../../src/shared/types/team';

const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const roots: string[] = [],
  features: DesktopBackendFeature[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const feature of features.splice(0)) await feature.shutdown();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-configured-team-')));
  roots.push(root);
  for (const name of ['home', 'store', 'workspace', 'tmp']) await mkdir(join(root, name));
  const node = await realpath(process.env.AGENT_BACKEND_TEST_NODE ?? process.execPath);
  const host = await realpath(join(process.cwd(), 'packages/legacy-agent-host/dist/cli.js'));
  const owner = {
    ownerId: 'TEST-registry-owner',
    revision: '1',
    storageRoot: join(root, 'store'),
    profileId: 'TEST-registry-profile',
    protocolVersion: 1,
    buildId: 'TEST-registry-build',
    nodeSha256: digest(await readFile(node)),
    hostEntrySha256: digest(await readFile(host)),
  };
  const profilePath = join(root, 'profile.json');
  const profileBytes = JSON.stringify({
    schemaVersion: 1,
    owner,
    principalId: 'TEST-human',
    teams: [],
    creation: { contextIds: ['local'] },
  });
  await writeFile(profilePath, profileBytes, { mode: 0o600 });
  const ref = { ownerId: owner.ownerId, revision: owner.revision };
  const descriptor: DesktopBackendDescriptor = {
    schemaVersion: 1,
    defaultOwner: ref,
    handles: [],
    creation: { owner: ref, contextIds: ['local'] },
    owners: [
      {
        ...ref,
        storageRoot: owner.storageRoot,
        profile: {
          profileId: owner.profileId,
          nodeExecutable: node,
          nodeVersion: execFileSync(node, ['--version'], { env: {}, encoding: 'utf8' }).trim(),
          nodeSha256: owner.nodeSha256,
          hostEntry: host,
          hostEntrySha256: owner.hostEntrySha256,
          expectedBuildId: owner.buildId,
          cwd: root,
          env: {
            HOME: join(root, 'home'),
            TMPDIR: join(root, 'tmp'),
            LEGACY_AGENT_HOST_PROFILE_PATH: profilePath,
            LEGACY_AGENT_HOST_PROFILE_SHA256: digest(profileBytes),
          },
          startupTimeoutMs: 5000,
          requestTimeoutMs: 5000,
          writeTimeoutMs: 1000,
          shutdownTimeoutMs: 3000,
        },
      },
    ],
  };
  const descriptorPath = join(root, 'descriptor.json'),
    descriptorBytes = JSON.stringify(descriptor);
  await writeFile(descriptorPath, descriptorBytes, { mode: 0o600 });
  const options: DesktopBackendFeatureOptions = {
    descriptor: { path: descriptorPath, sha256: digest(descriptorBytes) },
    bindingDirectory: join(root, 'bindings'),
  };
  const feature = () => {
    const value = new DesktopBackendFeature(options);
    features.push(value);
    return value;
  };
  const request: TeamCreateConfigRequest = {
    command: { commandId: 'TEST-save-original', idempotencyKey: 'TEST-save-original' },
    teamName: 'test-created',
    cwd: join(root, 'workspace'),
    displayName: 'TEST saved team',
    providerId: 'anthropic',
    model: 'TEST-model',
    effort: 'medium',
    skipPermissions: false,
    prompt: 'TEST prompt',
    extraCliArgs: undefined,
    members: [
      { name: 'reviewer', role: 'Reviewer', workflow: 'TEST workflow', model: 'TEST-other-model' },
    ],
  };
  return { root, feature, request };
}

describe('existing Create-config to actual Host registry', () => {
  it.each([undefined, 1] as const)(
    'saves one captured product intent with runtime version %s, exposes only its canonical binding and reconstructs it cold',
    async (runtimeSelectionVersion) => {
      const f = await fixture(),
        first = f.feature();
      // Match CreateTeamDialog: this key is present even for an unversioned draft.
      f.request.runtimeSelectionVersion = runtimeSelectionVersion;
      const originalRequest = CapturedHostClient.prototype.request;
      let lost = false;
      const observed: string[] = [];
      vi.spyOn(CapturedHostClient.prototype, 'request').mockImplementation(async function (
        this: CapturedHostClient,
        method,
        params,
        options
      ) {
        const result = await originalRequest.call(this, method, params, options);
        if (method.startsWith('team.registry.')) observed.push(method);
        if (method === 'team.registry.create' && !lost) {
          lost = true;
          throw new Error('TEST lost response after Host commit');
        }
        return result;
      });
      const saved = await createConfiguredHostTeam({
        feature: first,
        contextId: 'local',
        request: f.request,
        guard: { isCurrent: () => true },
      });
      expect(observed).toEqual(['team.registry.create', 'team.registry.lookup']);
      const bindings = (await first.discoverBindings('local')).bindings;
      expect(bindings).toHaveLength(1);
      const handle = bindings[0]!.handle;
      expect(saved.teamName).toBe(hostTeamSelectionKey(handle.handleId));
      expect(first.authorizeHandle('local', handle)).toBe(true);
      expect(first.authorizeHandle('ssh:foreign', handle)).toBe(false);
      expect(JSON.stringify(bindings)).not.toContain(f.root);
      const roster = await first.facade.invoke({
        handle,
        commandId: 'TEST-read',
        operation: 'team.roster.read',
        payload: {},
      });
      expect(roster).toMatchObject({
        ok: true,
        value: {
          savedSettings: {
            prompt: 'TEST prompt',
            skipPermissions: false,
            ...(runtimeSelectionVersion === undefined ? {} : { runtimeSelectionVersion }),
          },
          members: [
            { name: 'team-lead', role: 'lead' },
            {
              name: 'reviewer',
              role: 'member',
              settings: { role: 'Reviewer', workflow: 'TEST workflow' },
            },
          ],
        },
      });
      expect(
        await createConfiguredHostTeam({
          feature: first,
          contextId: 'local',
          request: f.request,
          guard: { isCurrent: () => true },
        })
      ).toEqual(saved);
      await expect(
        createConfiguredHostTeam({
          feature: first,
          contextId: 'local',
          request: { ...f.request, prompt: 'changed intent' },
          guard: { isCurrent: () => true },
        })
      ).rejects.toThrow();
      await first.shutdown();
      const cold = f.feature();
      expect((await cold.discoverBindings('local')).bindings).toEqual(bindings);
      expect(cold.authorizeHandle('local', handle)).toBe(true);
      expect(await readdir(join(f.root, 'store/teams'))).toEqual(['test-created']);
    }
  );

  it('does not publish a binding after context switches across Host commit; cold discovery recovers only original creation', async () => {
    const f = await fixture(),
      first = f.feature();
    let current = true;
    const originalRequest = CapturedHostClient.prototype.request;
    vi.spyOn(CapturedHostClient.prototype, 'request').mockImplementation(async function (
      this: CapturedHostClient,
      method,
      params,
      options
    ) {
      const result = await originalRequest.call(this, method, params, options);
      if (method === 'team.registry.create') current = false;
      return result;
    });
    await expect(
      createConfiguredHostTeam({
        feature: first,
        contextId: 'local',
        request: f.request,
        guard: { isCurrent: () => current },
      })
    ).rejects.toThrow();
    expect(first.listBindings('local').bindings).toEqual([]);
    await first.shutdown();
    const cold = f.feature();
    expect((await cold.discoverBindings('local')).bindings).toHaveLength(1);
    expect((await cold.discoverBindings('foreign')).bindings).toEqual([]);
    await expect(
      createConfiguredHostTeam({
        feature: cold,
        contextId: 'foreign',
        request: f.request,
        guard: { isCurrent: () => true },
      })
    ).rejects.toThrow();
    expect(await readdir(join(f.root, 'store/teams'))).toEqual(['test-created']);
  });

  it.each(['absent', 'unavailable', 'changed-owner'] as const)(
    'releases a Host configuration refusal only after its original owner lookup is absent (%s)',
    async (lookup) => {
      const f = await fixture(),
        feature = f.feature();
      let current = true;
      const original = CapturedHostClient.prototype.request;
      const observed: { method: string; params: unknown }[] = [];
      vi.spyOn(CapturedHostClient.prototype, 'request').mockImplementation(async function (
        this: CapturedHostClient,
        method,
        params,
        options
      ) {
        if (method === 'team.registry.create') {
          observed.push({ method, params });
          return { ok: false, code: 'conflict', outcome: 'rejected' };
        }
        if (method === 'team.registry.lookup') {
          observed.push({ method, params });
          if (lookup === 'unavailable') return { ok: false, code: 'hold', outcome: 'unknown' };
          const result = await original.call(this, method, params, options);
          if (lookup === 'changed-owner') current = false;
          return result;
        }
        return original.call(this, method, params, options);
      });
      const result = createConfiguredHostTeam({
        feature,
        contextId: 'local',
        request: f.request,
        guard: { isCurrent: () => current },
      });
      if (lookup === 'absent') await expect(result).rejects.toBeInstanceOf(TeamCreationRefusal);
      else await expect(result).rejects.not.toBeInstanceOf(TeamCreationRefusal);
      expect(observed.map((row) => row.method)).toEqual([
        'team.registry.create',
        'team.registry.lookup',
      ]);
      const originalParams = observed[0]!.params as Record<string, unknown>;
      expect(observed[1]!.params).toEqual({
        owner: originalParams.owner,
        commandId: originalParams.commandId,
        payload: { contextId: 'local', expected: originalParams.payload },
      });
      expect(feature.listBindings('local').bindings).toEqual([]);
    }
  );

  it('rejects missing identity and private/native selectors before invoking the creation port', async () => {
    const createConfiguredTeam = vi.fn(),
      request = {
        command: { commandId: 'TEST', idempotencyKey: 'TEST' },
        teamName: 'test-created',
        cwd: '/TEST/workspace',
        members: [],
      };
    for (const invalid of [
      { ...request, ownerId: 'foreign' },
      ...[0, 2, '1', null].map((runtimeSelectionVersion) => ({
        ...request,
        runtimeSelectionVersion,
      })),
      { ...request, command: undefined },
      { ...request, members: [{ name: 'worker', nativeSessionId: 'foreign' }] },
    ])
      await expect(
        createConfiguredHostTeam({
          feature: { createConfiguredTeam },
          contextId: 'local',
          request: invalid,
          guard: { isCurrent: () => true },
        })
      ).rejects.toThrow();
    expect(createConfiguredTeam).not.toHaveBeenCalled();
  });
});
