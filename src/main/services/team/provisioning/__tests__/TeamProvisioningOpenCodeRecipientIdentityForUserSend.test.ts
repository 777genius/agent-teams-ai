import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  materializeTeamProvisioningLaunchRoster,
  type TeamProvisioningLaunchRosterInput,
} from '../TeamProvisioningLaunchRosterMaterialization';
import {
  type OpenCodeRecipientIdentityForUserSendPorts,
  resolveOpenCodeRecipientIdentityForUserSend,
} from '../TeamProvisioningOpenCodeRecipientIdentityForUserSend';
import { resolveRuntimeRecipientProviderIdFromSources } from '../TeamProvisioningRuntimeRecipientResolution';

import type { PersistedTeamLaunchSnapshot, TeamConfig, TeamMember, TeamProvisioningProgress } from '@shared/types';

function createHarness() {
  let configRaw = JSON.stringify({
    name: 'alpha',
    members: [{ name: 'Lead', providerId: 'codex' }],
  });
  const metadata: TeamMember[] = [
    { name: 'Worker', providerId: 'opencode', model: 'openai/gpt-test' },
  ];
  const run = {
    runId: 'run-1',
    teamName: 'alpha',
    allEffectiveMembers: [
      { name: 'Worker', providerId: 'opencode' as const, model: 'openai/gpt-test' },
    ],
    cancelRequested: false,
    processKilled: false,
    progress: { state: 'ready' as TeamProvisioningProgress['state'] },
  };
  let trackedRunId: string | null = run.runId;
  let persistedLaunch: PersistedTeamLaunchSnapshot | null = {
    version: 2,
    teamName: 'alpha',
    updatedAt: '2026-11-06T20:00:00.000Z',
    publicationRunId: 'publication-1',
    launchPhase: 'finished',
    expectedMembers: ['Worker'],
    members: {
      Worker: {
        name: 'Worker',
        providerId: 'opencode',
        model: 'openai/gpt-test',
        laneId: 'secondary:opencode:worker',
        launchState: 'confirmed_alive',
        runtimeAlive: true,
        bootstrapConfirmed: true,
        agentToolAccepted: true,
        hardFailure: false,
        runtimeRunId: 'lane-run-1',
        runtimeSessionId: 'session-1',
        lastEvaluatedAt: '2026-11-06T20:00:00.000Z',
      },
    },
    summary: { confirmedCount: 1, pendingCount: 0, failedCount: 0, runtimeAlivePendingCount: 0 },
    teamLaunchState: 'clean_success',
  };
  const materialize = vi.fn(async (input: TeamProvisioningLaunchRosterInput) =>
    materializeTeamProvisioningLaunchRoster(input, {
      readConfig: async () => configRaw,
      readMetaMembers: async () => metadata,
      writeConfig: async (raw, beforeCommit) => {
        await beforeCommit();
        configRaw = raw;
      },
      invalidateTeam: vi.fn(),
      now: () => 123,
    })
  );
  const resolve = () =>
    resolveRuntimeRecipientProviderIdFromSources({
      memberName: 'Worker',
      config: JSON.parse(configRaw) as TeamConfig,
      metaMembers: metadata,
    });
  const ports: OpenCodeRecipientIdentityForUserSendPorts = {
    resolveProviderId: async (_teamName, memberName) =>
      resolveRuntimeRecipientProviderIdFromSources({
        memberName,
        config: JSON.parse(configRaw) as TeamConfig,
        metaMembers: metadata,
      }),
    getTrackedRunId: () => trackedRunId,
    getRun: (runId) => (runId === run.runId ? run : undefined),
    readMetaMembers: async () => metadata,
    readPersistedLaunchState: vi.fn(async () => persistedLaunch),
    isTeamOwned: vi.fn(async () => true),
    isTeamStopped: vi.fn(async () => false),
    isRuntimeReachable: vi.fn(() => true),
    resolveActiveLaneRunId: vi.fn(async () => 'lane-run-1'),
    hasCommittedRecipientSession: vi.fn(async () => true),
    getStopEpoch: vi.fn(() => '0'),
    materializeLaunchRoster: materialize,
  };
  return {
    input: { teamName: 'alpha', memberName: 'Worker' },
    metadata,
    run,
    ports,
    materialize,
    resolve,
    getConfig: () => JSON.parse(configRaw) as TeamConfig,
    getPersistedLaunch: () => persistedLaunch,
    setPersistedLaunch: (value: PersistedTeamLaunchSnapshot | null) => {
      persistedLaunch = value;
    },
    setConfig: (next: TeamConfig) => {
      configRaw = JSON.stringify(next);
    },
    setTrackedRunId: (id: string | null) => {
      trackedRunId = id;
    },
  };
}

describe('OpenCode explicit user-send identity repair', () => {
  it('keeps ordinary recipient queries read-only until an explicit user send', async () => {
    const h = createHarness();
    expect(h.resolve).toThrow('has no authoritative config identity');
    expect(h.materialize).not.toHaveBeenCalled();

    await expect(resolveOpenCodeRecipientIdentityForUserSend(h.input, h.ports)).resolves.toBe(
      'opencode'
    );
    expect(h.materialize).toHaveBeenCalledTimes(1);
    expect(h.resolve()).toBe('opencode');
    expect(h.getConfig().members).toContainEqual(
      expect.objectContaining({
        name: 'Worker',
        agentId: 'Worker@alpha',
        providerId: 'opencode',
        model: 'openai/gpt-test',
      })
    );

    await expect(resolveOpenCodeRecipientIdentityForUserSend(h.input, h.ports)).resolves.toBe(
      'opencode'
    );
    expect(h.materialize).toHaveBeenCalledTimes(1);
  });

  it('refuses metadata-only identities without a currently tracked runtime', async () => {
    const h = createHarness();
    h.setTrackedRunId(null);
    h.setPersistedLaunch(null);
    await expect(resolveOpenCodeRecipientIdentityForUserSend(h.input, h.ports)).rejects.toThrow(
      'has no authoritative config identity'
    );
    expect(h.materialize).not.toHaveBeenCalled();
  });

  it('refuses stopped, cancelled or superseded runtime identity', async () => {
    for (const cause of [
      'cancelRequested',
      'processKilled',
      'superseded',
      'cancelledProgress',
    ] as const) {
      const h = createHarness();
      if (cause === 'superseded') h.setTrackedRunId('run-2');
      else if (cause === 'cancelledProgress') h.run.progress.state = 'cancelled';
      else h.run[cause] = true;
      await expect(resolveOpenCodeRecipientIdentityForUserSend(h.input, h.ports)).rejects.toThrow(
        'has no authoritative config identity'
      );
      expect(h.materialize).not.toHaveBeenCalled();
    }
  });

  it('refuses mismatched model, removed recipient, or duplicate metadata', async () => {
    for (const cause of ['model', 'duplicate'] as const) {
      const h = createHarness();
      if (cause === 'model') h.metadata[0].model = 'openai/other-model';
      if (cause === 'duplicate') h.metadata.push({ ...h.metadata[0] });
      await expect(resolveOpenCodeRecipientIdentityForUserSend(h.input, h.ports)).rejects.toThrow(
        'has no authoritative config identity'
      );
      expect(h.materialize).not.toHaveBeenCalled();
    }
  });

  it('never materializes a removed member', async () => {
    const h = createHarness();
    h.metadata[0].removedAt = 123;
    await expect(resolveOpenCodeRecipientIdentityForUserSend(h.input, h.ports)).resolves.toBeUndefined();
    expect(h.materialize).not.toHaveBeenCalled();
  });

  it('can repair a metadata-only OpenCode model when its provider is inferred', async () => {
    const h = createHarness();
    h.metadata[0].providerId = undefined;
    await expect(resolveOpenCodeRecipientIdentityForUserSend(h.input, h.ports)).resolves.toBe('opencode');
    expect(h.materialize).toHaveBeenCalledTimes(1);
  });

  it('does not hide an existing config/metadata provider conflict', async () => {
    const h = createHarness();
    h.setConfig({
      name: 'alpha',
      members: [{ name: 'Worker', providerId: 'codex' }],
    } as TeamConfig);
    await expect(resolveOpenCodeRecipientIdentityForUserSend(h.input, h.ports)).rejects.toThrow(
      'Ambiguous runtime recipient provider identity'
    );
    expect(h.materialize).not.toHaveBeenCalled();
  });

  it('keeps the original identity error when the run is lost before publication', async () => {
    const h = createHarness();
    const originalMaterialize = h.ports.materializeLaunchRoster;
    h.ports.materializeLaunchRoster = async (input) => {
      h.run.cancelRequested = true;
      expect(input.isCurrentRun()).toBe(false);
      return false;
    };
    await expect(resolveOpenCodeRecipientIdentityForUserSend(h.input, h.ports)).rejects.toThrow(
      'has no authoritative config identity'
    );
    expect(originalMaterialize).not.toHaveBeenCalled();
  });

  it('does not repair a teammate while the primary team is still launching', async () => {
    const h = createHarness();
    h.run.progress.state = 'configuring';
    await expect(resolveOpenCodeRecipientIdentityForUserSend(h.input, h.ports)).rejects.toThrow(
      'has no authoritative config identity'
    );
    expect(h.materialize).not.toHaveBeenCalled();
  });

  it('recovers a restarted owned team only with matching durable lane evidence', async () => {
    const h = createHarness();
    h.setTrackedRunId(null);
    await expect(resolveOpenCodeRecipientIdentityForUserSend(h.input, h.ports)).resolves.toBe(
      'opencode'
    );
    expect(h.materialize).toHaveBeenCalledTimes(1);
    expect(h.getConfig().members).toContainEqual(
      expect.objectContaining({ name: 'Worker', providerId: 'opencode', model: 'openai/gpt-test' })
    );
    await expect(resolveOpenCodeRecipientIdentityForUserSend(h.input, h.ports)).resolves.toBe(
      'opencode'
    );
    expect(h.materialize).toHaveBeenCalledTimes(1);
  });

  it('refuses unproven persisted state, foreign ownership, stop, model drift or dead lanes', async () => {
    for (const cause of [
      'foreign',
      'stopped',
      'dead',
      'no-snapshot',
      'new-publication',
      'model-drift',
      'unconfirmed',
      'missing-session',
      'stale-lane',
      'uncommitted-session',
      'duplicate-expected',
    ] as const) {
      const h = createHarness();
      h.setTrackedRunId(null);
      const snapshot = h.getPersistedLaunch();
      if (!snapshot) throw new Error('test fixture missing');
      if (cause === 'foreign') vi.mocked(h.ports.isTeamOwned).mockResolvedValue(false);
      if (cause === 'stopped') vi.mocked(h.ports.isTeamStopped).mockResolvedValue(true);
      if (cause === 'dead') vi.mocked(h.ports.isRuntimeReachable).mockReturnValue(false);
      if (cause === 'no-snapshot') h.setPersistedLaunch(null);
      if (cause === 'new-publication') snapshot.publicationRunId = undefined;
      if (cause === 'model-drift') snapshot.members.Worker.model = 'openai/different';
      if (cause === 'unconfirmed') snapshot.members.Worker.bootstrapConfirmed = false;
      if (cause === 'missing-session') snapshot.members.Worker.runtimeSessionId = undefined;
      if (cause === 'stale-lane')
        vi.mocked(h.ports.resolveActiveLaneRunId).mockResolvedValue('old-run');
      if (cause === 'uncommitted-session')
        vi.mocked(h.ports.hasCommittedRecipientSession).mockResolvedValue(false);
      if (cause === 'duplicate-expected') snapshot.expectedMembers.push('worker');

      await expect(resolveOpenCodeRecipientIdentityForUserSend(h.input, h.ports)).rejects.toThrow(
        'has no authoritative config identity'
      );
      expect(h.materialize, cause).not.toHaveBeenCalled();
    }
  });

  it('rechecks a persisted session change at atomic commit rather than resurrecting stale identity', async () => {
    const h = createHarness();
    h.setTrackedRunId(null);
    const materialize = h.ports.materializeLaunchRoster;
    h.ports.materializeLaunchRoster = async (input) => {
      const snapshot = h.getPersistedLaunch();
      if (!snapshot) throw new Error('test fixture missing');
      snapshot.members.Worker.runtimeSessionId = 'replacement-session';
      return materialize(input);
    };
    await expect(resolveOpenCodeRecipientIdentityForUserSend(h.input, h.ports)).rejects.toThrow(
      'roster changed before config commit'
    );
    expect(h.resolve).toThrow('has no authoritative config identity');
  });

  it('refuses stale durable recipient when the committed session vanishes before write', async () => {
    const h = createHarness();
    h.setTrackedRunId(null);
    vi.mocked(h.ports.hasCommittedRecipientSession)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await expect(resolveOpenCodeRecipientIdentityForUserSend(h.input, h.ports)).rejects.toThrow(
      'roster changed before config commit'
    );
    expect(h.resolve).toThrow('has no authoritative config identity');
  });

  it.each(['model', 'provider', 'cwd'])(
    'refuses a stale durable %s when metadata changes after recipient verification',
    async (change) => {
      const h = createHarness();
      h.setTrackedRunId(null);
      const materialize = h.ports.materializeLaunchRoster;
      h.ports.materializeLaunchRoster = (input) => {
        if (change === 'model') h.metadata[0].model = 'openai/replaced';
        if (change === 'provider') h.metadata[0].providerId = 'codex';
        if (change === 'cwd') h.metadata[0].cwd = '/other-project';
        return materialize(input);
      };
      await expect(resolveOpenCodeRecipientIdentityForUserSend(h.input, h.ports)).rejects.toThrow(
        'roster changed before config commit'
      );
      expect(h.getConfig().members).toHaveLength(1);
    }
  );

  it('rechecks Stop generation and refuses stale persisted repair before writing', async () => {
    const h = createHarness();
    h.setTrackedRunId(null);
    let epoch = '0';
    vi.mocked(h.ports.getStopEpoch).mockImplementation(() => epoch);
    const materialize = h.ports.materializeLaunchRoster;
    h.ports.materializeLaunchRoster = (input) =>
      materialize({
        ...input,
        beforeCommit: async (currentMeta) => {
          epoch = '1';
          return (await input.beforeCommit?.(currentMeta)) ?? true;
        },
      });
    await expect(resolveOpenCodeRecipientIdentityForUserSend(h.input, h.ports)).rejects.toThrow(
      'roster changed before config commit'
    );
    expect(h.resolve).toThrow('has no authoritative config identity');
  });

  it('sandbox E2E: persists identity to disk and a fresh reader can route after restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opencode-recipient-identity-'));
    const configPath = join(dir, 'config.json');
    const h = createHarness();
    h.setTrackedRunId(null);
    try {
      await writeFile(configPath, JSON.stringify(h.getConfig()));
      h.ports.resolveProviderId = async (_team, name) => {
        const config = JSON.parse(await readFile(configPath, 'utf8')) as TeamConfig;
        return resolveRuntimeRecipientProviderIdFromSources({
          memberName: name,
          config,
          metaMembers: h.metadata,
        });
      };
      h.ports.materializeLaunchRoster = (input) =>
        materializeTeamProvisioningLaunchRoster(input, {
          readConfig: () => readFile(configPath, 'utf8'),
          readMetaMembers: async () => h.metadata,
          writeConfig: async (raw, beforeCommit) => {
            await beforeCommit();
            await writeFile(configPath, raw);
          },
          invalidateTeam: vi.fn(),
          now: () => 123,
        });

      await expect(resolveOpenCodeRecipientIdentityForUserSend(h.input, h.ports)).resolves.toBe(
        'opencode'
      );
      const freshDiskConfig = JSON.parse(await readFile(configPath, 'utf8')) as TeamConfig;
      expect(freshDiskConfig.members).toContainEqual(
        expect.objectContaining({
          name: 'Worker',
          agentId: 'Worker@alpha',
          providerId: 'opencode',
          model: 'openai/gpt-test',
        })
      );
      await expect(h.ports.resolveProviderId('alpha', 'Worker')).resolves.toBe('opencode');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

});
