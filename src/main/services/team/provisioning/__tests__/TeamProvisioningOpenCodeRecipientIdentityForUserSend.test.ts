import { describe, expect, it, vi } from 'vitest';

import { materializeTeamProvisioningLaunchRoster } from '../TeamProvisioningLaunchRosterMaterialization';
import {
  resolveOpenCodeRecipientIdentityForUserSend,
  type OpenCodeRecipientIdentityForUserSendPorts,
} from '../TeamProvisioningOpenCodeRecipientIdentityForUserSend';
import { resolveRuntimeRecipientProviderIdFromSources } from '../TeamProvisioningRuntimeRecipientResolution';

import type { TeamProvisioningLaunchRosterInput } from '../TeamProvisioningLaunchRosterMaterialization';
import type { TeamConfig, TeamMember, TeamProvisioningProgress } from '@shared/types';

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
});
