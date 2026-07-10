/* eslint-disable security/detect-non-literal-fs-filename -- Test paths are owned by the harness temp workspace. */
import { readFile } from 'fs/promises';
import { describe, expect, it, vi } from 'vitest';

import { track } from './builderTestContext';
import {
  HARNESS_DEFAULT_NOW_ISO,
  HARNESS_DEFAULT_TEAM_NAME,
  makeLaunchState,
  makeOpenCodeEvidence,
  makeProvisioningRun,
  makeRuntimeSnapshot,
  makeTeamCreateRequest,
  memberFixture,
  teamConfigFixture,
  teamMetaFixture,
  TeamProvisioningHarnessBuilder,
  toMetaMembers,
} from './index';

import type { TeamProvisioningConfigFacadeReader } from '@main/services/team/provisioning/TeamProvisioningConfigFacade';
import type { TeamProvisioningConfigMaintenanceMembersMetaStore } from '@main/services/team/provisioning/TeamProvisioningConfigMaintenance';
import type { TeamMetaStore } from '@main/services/team/TeamMetaStore';

describe('TeamProvisioningHarnessBuilder fake stores and facade ports', () => {
  it('provides deterministic defaults through fake stores, clock, and uuid hooks', async () => {
    const harness = await track(TeamProvisioningHarnessBuilder.create().build());

    expect(harness.teamName).toBe(HARNESS_DEFAULT_TEAM_NAME);
    expect(harness.clock.nowIso()).toBe(HARNESS_DEFAULT_NOW_ISO);
    expect(harness.uuid.next()).toBe('harness-uuid-1');
    expect(harness.uuid.next()).toBe('harness-uuid-2');
    expect(harness.uuid.generated()).toEqual(['harness-uuid-1', 'harness-uuid-2']);

    const config = await harness.stores.configReader.getConfig(HARNESS_DEFAULT_TEAM_NAME);
    expect(config).toMatchObject({
      name: HARNESS_DEFAULT_TEAM_NAME,
      projectPath: harness.paths.projectPath,
      leadSessionId: 'harness-lead-session',
    });
    expect(config?.members?.map((member) => `${member.name}:${member.providerId}`)).toEqual([
      'Lead:codex',
      'Builder:codex',
    ]);

    const persistedConfig = JSON.parse(
      await readFile(harness.paths.configPath(HARNESS_DEFAULT_TEAM_NAME), 'utf8')
    ) as unknown;
    expect(persistedConfig).toEqual(config);
    await expect(
      harness.stores.teamMetaStore.getMeta(HARNESS_DEFAULT_TEAM_NAME)
    ).resolves.toMatchObject({ cwd: harness.paths.projectPath, providerId: 'codex' });
    await expect(
      harness.stores.membersMetaStore.getMembers(HARNESS_DEFAULT_TEAM_NAME)
    ).resolves.toEqual([
      expect.objectContaining({
        name: 'Builder',
        agentType: 'general-purpose',
        providerBackendId: 'codex-native',
      }),
    ]);
  });

  it('normalizes direct builder fixtures before persisting config and members metadata', async () => {
    const teamName = 'topology-normalization-team';
    const harness = await track(
      TeamProvisioningHarnessBuilder.create()
        .withTeam(teamName, {
          name: teamName,
          projectPath: '/tmp/agent-teams-harness/topology',
          members: [
            {
              name: 'Captain',
              agentType: 'team-lead',
              providerId: 'codex',
              providerBackendId: 'adapter',
            },
            {
              name: 'Duplicate Captain',
              agentType: 'orchestrator',
              providerId: 'opencode',
              providerBackendId: 'opencode-cli',
            },
            { name: 'Builder', providerId: 'codex', providerBackendId: 'adapter' },
            { name: 'Runtime', providerId: 'opencode', providerBackendId: 'codex-native' },
          ],
        })
        .withTeamMeta(teamName, {
          cwd: '/tmp/agent-teams-harness/topology',
          providerId: 'codex',
          providerBackendId: 'opencode-cli',
          createdAt: Date.parse(HARNESS_DEFAULT_NOW_ISO),
        })
        .withMembersMeta(
          teamName,
          [
            memberFixture.lead(),
            { name: 'Meta Lead', agentType: 'lead', providerId: 'opencode' },
            { name: 'Builder', providerId: 'codex', providerBackendId: 'adapter' },
            { name: 'Runtime', providerId: 'opencode', providerBackendId: 'codex-native' },
          ],
          { providerBackendId: 'opencode-cli' }
        )
        .build()
    );

    const config = await harness.stores.configReader.getConfigSnapshot(teamName);
    expect(config?.members).toEqual([
      expect.objectContaining({
        name: 'Captain',
        agentType: 'team-lead',
        providerBackendId: 'codex-native',
      }),
      expect.objectContaining({
        name: 'Builder',
        agentType: 'general-purpose',
        providerBackendId: 'codex-native',
      }),
      expect.objectContaining({
        name: 'Runtime',
        agentType: 'general-purpose',
      }),
    ]);
    expect(config?.members?.[2]).not.toHaveProperty('providerBackendId');
    const persistedTeamMeta = await harness.stores.teamMetaStore.getMeta(teamName);
    expect(persistedTeamMeta).toMatchObject({ providerId: 'codex' });
    expect(persistedTeamMeta).not.toHaveProperty('providerBackendId');
    await expect(harness.stores.membersMetaStore.getMeta(teamName)).resolves.toMatchObject({
      providerBackendId: undefined,
      members: [
        expect.objectContaining({ name: 'Builder', agentType: 'general-purpose' }),
        expect.objectContaining({ name: 'Runtime', agentType: 'general-purpose' }),
      ],
    });

    const persistedMembersMeta = JSON.parse(
      await readFile(harness.paths.membersMetaPath(teamName), 'utf8')
    ) as { members: { name: string; agentType?: string }[] };
    expect(persistedMembersMeta.members).toEqual([
      expect.objectContaining({ name: 'Builder', agentType: 'general-purpose' }),
      expect.objectContaining({ name: 'Runtime', agentType: 'general-purpose' }),
    ]);
  });

  it('exposes explicit fake store ports for migrated provisioning helpers', async () => {
    const harness = await track(TeamProvisioningHarnessBuilder.create().build());
    const configReaderPort: TeamProvisioningConfigFacadeReader = harness.stores.configReader;
    const membersMetaPort: TeamProvisioningConfigMaintenanceMembersMetaStore =
      harness.stores.membersMetaStore;
    const teamMetaReadPort: Pick<TeamMetaStore, 'getMeta'> = harness.stores.teamMetaStore;

    expect(Object.keys(harness.stores.configReader).sort()).toEqual([
      'getConfig',
      'getConfigSnapshot',
      'getConfigVerified',
      'readTeamConfigRaw',
    ]);
    expect(Object.keys(harness.stores.membersMetaStore).sort()).toEqual([
      'getMembers',
      'getMeta',
      'writeMembers',
    ]);
    expect(Object.keys(harness.stores.teamMetaStore).sort()).toEqual(['getMeta']);
    expect(Object.keys(harness.stores.inboxReader).sort()).toEqual(['listInboxNames']);
    expect(Object.keys(harness.stores.launchStateStore).sort()).toEqual(['read']);
    expect(Object.keys(harness.stores.bootstrapStateStore).sort()).toEqual(['read']);
    expect(Object.keys(harness.stores.runtimeStore).sort()).toEqual(['read']);
    expect(Object.keys(harness.facades).sort()).toEqual([
      'configFacade',
      'launchExpectedMembersPorts',
    ]);
    expect('updateConfig' in harness.stores.configReader).toBe(false);
    expect('writeMeta' in harness.stores.teamMetaStore).toBe(false);

    await expect(configReaderPort.getConfig(HARNESS_DEFAULT_TEAM_NAME)).resolves.toMatchObject({
      name: HARNESS_DEFAULT_TEAM_NAME,
    });
    await expect(teamMetaReadPort.getMeta(HARNESS_DEFAULT_TEAM_NAME)).resolves.toMatchObject({
      cwd: harness.paths.projectPath,
    });

    await membersMetaPort.writeMembers(
      'port-team',
      [
        memberFixture.lead(),
        memberFixture.codex(' beta ', { role: ' Builder ' }),
        memberFixture.codex('alpha'),
        memberFixture.codex('alpha-2'),
        memberFixture.codex('   '),
      ],
      { providerBackendId: 'adapter' }
    );

    await expect(membersMetaPort.getMembers('port-team')).resolves.toEqual([
      expect.objectContaining({ name: 'alpha' }),
      expect.objectContaining({ name: 'beta', role: 'Builder' }),
    ]);
    await expect(harness.stores.membersMetaStore.getMeta('port-team')).resolves.toMatchObject({
      providerBackendId: 'codex-native',
    });
  });

  it('seeds sidecar state files for extracted provisioning service port tests', async () => {
    const teamName = 'sidecar-fixture-team';
    const launchState = { teamName, members: [{ name: 'Worker', phase: 'registered' }] };
    const bootstrapState = { teamName, checkpoint: 'runtime-ready' };
    const runtimeStore = { sessions: [{ memberName: 'Worker', laneId: 'lane-worker' }] };
    const inboxMessages = [{ id: 'message-1', from: 'user', text: 'fixture inbox message' }];
    const harness = await track(
      TeamProvisioningHarnessBuilder.create()
        .withTeam(teamName)
        .withMembersMeta(teamName, [memberFixture.codex('Worker')])
        .withLaunchState(teamName, launchState)
        .withBootstrapState(teamName, bootstrapState)
        .withRuntimeStore(teamName, runtimeStore)
        .withInbox(teamName, 'Worker', inboxMessages)
        .build()
    );
    const ports = harness.facades.launchExpectedMembersPorts;

    await expect(ports.readLaunchState(teamName)).resolves.toEqual(launchState);
    await expect(ports.readBootstrapLaunchSnapshot(teamName)).resolves.toEqual(bootstrapState);
    await expect(ports.getMembers(teamName)).resolves.toEqual([
      expect.objectContaining({ name: 'Worker' }),
    ]);
    await expect(ports.listInboxNames(teamName)).resolves.toEqual(['Worker']);
    await expect(harness.stores.runtimeStore.read(teamName)).resolves.toEqual(runtimeStore);
    expect(JSON.parse(await readFile(harness.paths.inboxPath(teamName, 'Worker'), 'utf8'))).toEqual(
      inboxMessages
    );
  });

  it('wires config facade launch-member discovery to harness config, meta, and inbox fixtures', async () => {
    const teamName = 'facade-inbox-team';
    const harness = await track(
      TeamProvisioningHarnessBuilder.create()
        .withTeam(teamName)
        .withMembersMeta(teamName, [])
        .withInbox(teamName, 'alice')
        .build()
    );

    const configRaw = await harness.stores.configReader.readTeamConfigRaw(teamName);

    expect(harness.facades.configFacade.readPersistedTeamProjectPath(teamName)).toBe(
      harness.paths.projectPath
    );
    await expect(harness.stores.inboxReader.listInboxNames(teamName)).resolves.toEqual(['alice']);
    await expect(
      harness.facades.configFacade.resolveLaunchExpectedMembers(
        teamName,
        configRaw ?? '{}',
        'codex'
      )
    ).resolves.toMatchObject({
      source: 'inboxes',
      members: [expect.objectContaining({ name: 'alice' })],
    });
  });

  it('lets config facade materialize repair members into harness members metadata', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(987_654);
    const teamName = 'facade-repair-team';
    const harness = await track(
      TeamProvisioningHarnessBuilder.create()
        .withTeam(teamName, teamConfigFixture.basic({ teamName }))
        .withMembersMeta(teamName, [])
        .build()
    );

    try {
      await harness.facades.configFacade.materializeLaunchCompatibilityRepair(
        { teamName, cwd: harness.paths.projectPath, providerBackendId: 'codex-native' },
        {
          level: 'repairable',
          rosterSource: 'config',
          repairAction: 'materialize-members-meta',
          members: [{ name: 'Builder', role: 'Engineer' }],
          warnings: [],
          blockers: [],
        }
      );

      await expect(harness.stores.membersMetaStore.getMembers(teamName)).resolves.toEqual([
        expect.objectContaining({ name: 'Builder', role: 'Engineer', joinedAt: 987_654 }),
      ]);
      const persistedMeta = JSON.parse(
        await readFile(harness.paths.membersMetaPath(teamName), 'utf8')
      ) as unknown;
      expect(persistedMeta).toMatchObject({
        providerBackendId: 'codex-native',
        members: [expect.objectContaining({ name: 'Builder', joinedAt: 987_654 })],
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('honors explicit team fixtures and deterministic uuid sequences', async () => {
    const teamName = 'alpha-team';
    const alice = memberFixture.opencode('alice', { role: 'Runtime Engineer' });
    const bob = memberFixture.anthropic('bob', { model: 'harness-anthropic-model' });
    const harness = await track(
      TeamProvisioningHarnessBuilder.create()
        .withClock('2026-02-03T04:05:06.000Z')
        .withUuidSequence(['run-alpha', 'run-beta'])
        .withTeam(
          teamName,
          teamConfigFixture.basic({
            teamName,
            projectPath: '/tmp/agent-teams-harness/alpha',
            members: [memberFixture.lead(), alice],
          })
        )
        .withTeamMeta(
          teamName,
          teamMetaFixture.basic({
            displayName: 'Alpha Team',
            cwd: '/tmp/agent-teams-harness/alpha',
          })
        )
        .withMembersMeta(teamName, [alice, bob])
        .build()
    );

    await expect(harness.stores.configReader.getConfigSnapshot(teamName)).resolves.toMatchObject({
      name: teamName,
      members: [expect.objectContaining({ name: 'Lead' }), alice],
    });
    await expect(harness.stores.teamMetaStore.getMeta(teamName)).resolves.toMatchObject({
      displayName: 'Alpha Team',
      cwd: '/tmp/agent-teams-harness/alpha',
    });
    await expect(harness.stores.membersMetaStore.getMembers(teamName)).resolves.toEqual([
      expect.objectContaining({ name: alice.name, providerId: alice.providerId, role: alice.role }),
      expect.objectContaining({ name: bob.name, providerId: bob.providerId, model: bob.model }),
    ]);
    expect(harness.clock.nowIso()).toBe('2026-02-03T04:05:06.000Z');
    expect(harness.uuid.next()).toBe('run-alpha');
    expect(harness.uuid.next()).toBe('run-beta');
    expect(harness.uuid.next()).toBe('harness-uuid-3');
  });

  it('provides typed domain fixtures for extracted service tests', async () => {
    const teamName = 'typed-fixture-team';
    const request = makeTeamCreateRequest({
      teamName,
      cwd: '/tmp/agent-teams-harness/typed-fixture',
      members: [memberFixture.lead(), memberFixture.opencode('Runtime')],
    });
    const run = makeProvisioningRun({
      runId: 'typed-fixture-run',
      request,
      expectedMembers: ['Runtime'],
    });
    const launchState = makeLaunchState({
      teamName,
      expectedMembers: ['Runtime'],
      members: {
        Runtime: {
          name: 'Runtime',
          providerId: 'opencode',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          lastEvaluatedAt: HARNESS_DEFAULT_NOW_ISO,
          diagnostics: [],
        },
      },
    });
    const runtimeSnapshot = makeRuntimeSnapshot({
      teamName,
      runId: run.runId,
      members: {
        Runtime: {
          memberName: 'Runtime',
          alive: true,
          restartable: true,
          providerId: 'opencode',
          providerBackendId: 'opencode-cli',
          updatedAt: HARNESS_DEFAULT_NOW_ISO,
        },
      },
    });
    const openCodeEvidence = makeOpenCodeEvidence({ memberName: 'Runtime' });
    const harness = await track(
      TeamProvisioningHarnessBuilder.create()
        .withTeam(
          teamName,
          teamConfigFixture.basic({
            teamName,
            projectPath: request.cwd,
            members: toMetaMembers(request.members),
          })
        )
        .withLaunchState(teamName, launchState)
        .withRuntimeStore(teamName, { runtimeSnapshot, openCodeEvidence })
        .build()
    );

    expect(run).toMatchObject({
      runId: 'typed-fixture-run',
      teamName,
      expectedMembers: ['Runtime'],
      deterministicBootstrap: true,
    });
    await expect(harness.stores.launchStateStore.read(teamName)).resolves.toMatchObject({
      teamName,
      expectedMembers: ['Runtime'],
      members: { Runtime: expect.objectContaining({ launchState: 'confirmed_alive' }) },
    });
    await expect(harness.stores.runtimeStore.read(teamName)).resolves.toMatchObject({
      runtimeSnapshot: { teamName, runId: 'typed-fixture-run' },
      openCodeEvidence: expect.objectContaining({ memberName: 'Runtime' }),
    });
  });
});
