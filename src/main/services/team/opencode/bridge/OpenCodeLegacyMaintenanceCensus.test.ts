// @vitest-environment node
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildMemberWorkSyncRuntimeTurnSettledEnvironment } from '@features/member-work-sync/main';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TeamMembersMetaStore } from '../../TeamMembersMetaStore';
import { TeamMetaStore } from '../../TeamMetaStore';

import {
  createLegacyOpenCodeMaintenanceRequirement,
  inspectLegacyOpenCodeMaintenance,
  type LegacyMaintenanceCensusInput,
} from './OpenCodeLegacyMaintenanceCensus';
import { cleanupLegacyOpenCodeLifecycle } from './OpenCodeLifecycleCleanup';
import { runOpenCodeLifecycleCleanupTail } from './OpenCodeLifecycleCleanupTail';

const state = vi.hoisted(() => ({ teams: '' }));
vi.mock('@main/utils/pathDecoder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@main/utils/pathDecoder')>()),
  getTeamsBasePath: () => state.teams,
}));
vi.mock('./OpenCodeLifecycleCleanupTail', () => ({
  runOpenCodeLifecycleCleanupTail: vi.fn(async () => {}),
}));

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(): Promise<LegacyMaintenanceCensusInput> {
  const root = await mkdtemp(join(tmpdir(), 'TEST-legacy-maintenance-'));
  roots.push(root);
  return {
    teamsBasePath: join(root, 'legacy-teams'),
    multimodelDataPath: join(root, 'legacy-runtime'),
    attributionPath: join(root, 'legacy-attribution'),
    hasTrackedObligations: () => false,
  };
}

async function savedTeam(input: LegacyMaintenanceCensusInput): Promise<string> {
  state.teams = input.teamsBasePath;
  const team = 'TEST-saved-only';
  const path = join(input.teamsBasePath, team);
  await mkdir(path, { recursive: true });
  await new TeamMetaStore().writeMeta(team, { cwd: '/TEST/workspace', createdAt: 1 });
  await new TeamMembersMetaStore().writeMembers(team, [
    { name: 'alice', agentType: 'general-purpose', joinedAt: 1 },
  ]);
  return path;
}

describe('legacy native-maintenance census', () => {
  it('accepts finite configured product records with only exact roster-bound product identities', async () => {
    const input = await fixture();
    const path = await savedTeam(input);
    await writeFile(
      join(path, 'config.json'),
      JSON.stringify(
        {
          name: 'TEST-saved-only',
          projectPath: '/TEST/workspace',
          createdAt: 1,
          leadAgentId: 'team-lead@TEST-saved-only',
          members: [
            { name: 'team-lead', agentType: 'team-lead', agentId: 'team-lead@TEST-saved-only' },
            { name: 'alice', agentType: 'general-purpose', agentId: 'alice@TEST-saved-only' },
          ],
        },
        null,
        2
      )
    );
    expect(await inspectLegacyOpenCodeMaintenance(input)).toBe('absent');
  });

  it.each([
    'native-file',
    'hidden-file',
    'malformed',
    'unknown-field',
    'native-id',
    'symlink',
    'oversized',
    'null-config',
    'inbox',
    'duplicate-key',
  ] as const)('retains %s evidence beside saved metadata', async (kind) => {
    const input = await fixture();
    const path = await savedTeam(input);
    if (kind === 'native-file' || kind === 'hidden-file') {
      await writeFile(join(path, kind === 'native-file' ? 'launch-state.json' : '.unknown'), '{}');
    } else if (kind === 'symlink') {
      await rm(join(path, 'team.meta.json'));
      await symlink(join(path, 'members.meta.json'), join(path, 'team.meta.json'));
    } else if (kind === 'null-config') {
      await writeFile(join(path, 'config.json'), 'null');
    } else if (kind === 'inbox') {
      await mkdir(join(path, 'inboxes'));
      await writeFile(join(path, 'inboxes', 'alice.json'), '[]');
    } else if (kind === 'duplicate-key') {
      await writeFile(
        join(path, 'team.meta.json'),
        '{\n  "version": 1,\n  "cwd": "/TEST/workspace",\n  "createdAt": 1,\n  "createdAt": 1\n}'
      );
    } else {
      const value =
        kind === 'malformed'
          ? '{'
          : kind === 'oversized'
            ? ' '.repeat(256 * 1024 + 1)
            : JSON.stringify(
                {
                  version: 1,
                  cwd: '/TEST/workspace',
                  createdAt: 1,
                  ...(kind === 'native-id'
                    ? { leadSessionId: 'native-session' }
                    : { unknown: true }),
                },
                null,
                2
              );
      await writeFile(join(path, 'team.meta.json'), value);
    }
    expect(await inspectLegacyOpenCodeMaintenance(input)).not.toBe('absent');
  });

  it.each(['registry', 'lock', 'attribution', 'tracked'] as const)(
    'saved-only records do not suppress independent %s obligations',
    async (kind) => {
      const input = await fixture();
      await savedTeam(input);
      if (kind === 'tracked') input.hasTrackedObligations = () => true;
      else {
        const path =
          kind === 'attribution'
            ? join(input.attributionPath, 'owner.json')
            : join(
                input.multimodelDataPath,
                'opencode',
                kind === 'registry' ? 'host-registry.json' : 'host-startup-locks/owner.lock'
              );
        await mkdir(join(path, '..'), { recursive: true });
        await writeFile(path, 'opaque retained evidence');
      }
      expect(await inspectLegacyOpenCodeMaintenance(input)).toBe('present');
    }
  );

  it('actual Desktop save-only metadata causes zero native bridge calls at startup and shutdown', async () => {
    const input = await fixture();
    state.teams = input.teamsBasePath;
    const team = 'TEST-saved-only';
    await mkdir(join(input.teamsBasePath, team), { recursive: true });
    await new TeamMetaStore().writeMeta(team, {
      cwd: '/TEST/workspace',
      providerId: 'anthropic',
      providerBackendId: 'cli-sdk',
      model: 'claude-sonnet-4-6',
      effort: 'low',
      fastMode: 'off',
      createdAt: 1,
    });
    await new TeamMembersMetaStore().writeMembers(team, [
      {
        name: 'alice',
        role: 'TEST developer',
        agentType: 'general-purpose',
        joinedAt: 1,
        providerId: 'anthropic',
        color: 'blue',
      },
    ]);
    const required = createLegacyOpenCodeMaintenanceRequirement(() => input);
    const bridge = {
      cleanupOpenCodeHosts: vi.fn(async () => ({
        cleaned: 0,
        remaining: 0,
        diagnostics: [],
        hosts: [],
      })),
    };
    vi.mocked(runOpenCodeLifecycleCleanupTail).mockClear();
    for (const reason of ['startup', 'shutdown'] as const)
      await cleanupLegacyOpenCodeLifecycle({
        reason,
        bridge,
        nativeMaintenanceRequired: required,
        appStartedAtMs: 123,
        managedHostInstanceId: 'TEST-instance',
        profileScope: 'TEST-profile',
        logInfo: vi.fn(),
        ports: { logSweepResult: vi.fn(), logWarning: vi.fn(), logError: vi.fn() },
      });
    expect(bridge.cleanupOpenCodeHosts).not.toHaveBeenCalled();
    expect(runOpenCodeLifecycleCleanupTail).toHaveBeenCalledTimes(2);
    expect(runOpenCodeLifecycleCleanupTail).toHaveBeenLastCalledWith(
      expect.objectContaining({
        reason: 'shutdown',
        registryMaintenanceSkipped: true,
        appStartedAtMs: 123,
        managedHostInstanceId: 'TEST-instance',
        profileScope: 'TEST-profile',
      })
    );
  });

  it('the actual startup hook installer does not invent native legacy work or latch cleanup at Quit', async () => {
    const input = await fixture();
    await buildMemberWorkSyncRuntimeTurnSettledEnvironment({
      teamsBasePath: input.teamsBasePath,
      provider: 'opencode',
    });
    const required = createLegacyOpenCodeMaintenanceRequirement(() => input);
    expect(await inspectLegacyOpenCodeMaintenance(input)).toBe('absent');
    expect(await required()).toBe(false);
    expect(await required()).toBe(false);
    await mkdir(join(input.teamsBasePath, 'TEST-real-legacy-archive'));
    expect(await required()).toBe(true);
  });

  it.each(['pending-report', 'unknown-hidden', 'prototype-name'] as const)(
    'retains %s beside shared hook infrastructure instead of blanket-skipping hidden state',
    async (kind) => {
      const input = await fixture();
      await buildMemberWorkSyncRuntimeTurnSettledEnvironment({
        teamsBasePath: input.teamsBasePath,
        provider: 'opencode',
      });
      const file =
        kind === 'pending-report'
          ? join(input.teamsBasePath, '.member-work-sync/runtime-hooks/incoming/TEST-event.json')
          : join(input.teamsBasePath, kind === 'unknown-hidden' ? '.unknown-legacy' : '__proto__');
      await writeFile(file, 'TEST retained evidence');
      expect(await inspectLegacyOpenCodeMaintenance(input)).toBe('present');
    }
  );

  it('does not trust a symlink in the known scaffold', async () => {
    const input = await fixture();
    await mkdir(input.teamsBasePath);
    await mkdir(input.multimodelDataPath);
    await symlink(input.multimodelDataPath, join(input.teamsBasePath, '.member-work-sync'), 'dir');
    expect(await inspectLegacyOpenCodeMaintenance(input)).toBe('unknown');
  });

  it('proves missing/empty legacy roots absent while unrelated Host storage exists', async () => {
    const input = await fixture();
    await mkdir(join(roots.at(-1)!, 'host-only', 'runtime-sessions'), { recursive: true });
    expect(await inspectLegacyOpenCodeMaintenance(input)).toBe('absent');
    for (const path of [input.teamsBasePath, input.multimodelDataPath, input.attributionPath])
      await mkdir(path);
    expect(await inspectLegacyOpenCodeMaintenance(input)).toBe('absent');
  });

  it.each(['archive', 'registry', 'lock', 'attribution'] as const)(
    'retains %s legacy evidence independently of any Host selection',
    async (kind) => {
      const input = await fixture();
      const path =
        kind === 'archive'
          ? join(input.teamsBasePath, 'old-archive', 'config.json')
          : kind === 'registry'
            ? join(input.multimodelDataPath, 'opencode', 'host-registry.json')
            : kind === 'lock'
              ? join(input.multimodelDataPath, 'opencode', 'host-startup-locks', 'old.lock')
              : join(input.attributionPath, 'v1', 'hosts', 'old.json');
      await mkdir(join(path, '..'), { recursive: true });
      // Even corrupt opaque state is presence, never an empty/normalized fake receipt.
      await writeFile(path, 'opaque-or-corrupt-legacy-evidence');
      expect(await inspectLegacyOpenCodeMaintenance(input)).toBe('present');
    }
  );

  it('does not follow symlink roots or treat non-directories as absent', async () => {
    const input = await fixture();
    await mkdir(input.multimodelDataPath);
    await symlink(input.multimodelDataPath, input.teamsBasePath, 'dir');
    expect(await inspectLegacyOpenCodeMaintenance(input)).toBe('unknown');
    await rm(input.teamsBasePath);
    await writeFile(input.attributionPath, 'not a directory');
    expect(await inspectLegacyOpenCodeMaintenance(input)).toBe('unknown');
  });

  it('captures pending/locked owner work before teardown and retains it after removal', async () => {
    const input = await fixture();
    let tracked = true;
    input.hasTrackedObligations = () => tracked;
    const required = createLegacyOpenCodeMaintenanceRequirement(() => input);
    const beforeStopAll = required();
    tracked = false;
    expect(await beforeStopAll).toBe(true);
    expect(await required()).toBe(true);
  });

  it('rechecks a newly visible legacy owner and retains unknown evidence', async () => {
    const input = await fixture();
    let calls = 0;
    input.hasTrackedObligations = () => ++calls > 1;
    expect(await inspectLegacyOpenCodeMaintenance(input)).toBe('present');
    const required = createLegacyOpenCodeMaintenanceRequirement(() => {
      throw new Error('TEST unavailable');
    });
    expect(await required()).toBe(true);
  });
});
