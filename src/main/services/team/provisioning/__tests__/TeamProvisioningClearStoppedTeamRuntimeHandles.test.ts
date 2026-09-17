import { describe, expect, it, vi } from 'vitest';

import { TeamConfigReader } from '../../TeamConfigReader';
import { getTeamDataWorkerClient } from '../../TeamDataWorkerClient';
import {
  createNodeClearStoppedTeamLiveRuntimeHandlesPorts,
  persistClearedStoppedTeamLiveRuntimeHandles,
  stripStoppedTeamLiveRuntimeHandlesFromConfig,
} from '../TeamProvisioningClearStoppedTeamRuntimeHandles';

const MIXED_STOPPED_CONFIG = {
  name: 'mixed-v2150-20260917',
  leadAgentId: 'team-lead@mixed-v2150-20260917',
  members: [
    {
      agentId: 'team-lead@mixed-v2150-20260917',
      name: 'team-lead',
      tmuxPaneId: '',
      providerId: 'anthropic',
      sessionId: 'lead-session',
    },
    {
      name: 'alice',
      providerId: 'anthropic',
      tmuxPaneId: 'process:11497',
      runtimePid: 11497,
      backendType: 'process',
      bootstrapRunId: '81bc7f8b-fd2c-47e6-b720-91927c98a0b7',
      isActive: false,
    },
    {
      name: 'cody',
      providerId: 'codex',
      tmuxPaneId: 'process:12052',
      runtimePid: 12052,
      runtimeSessionId: 'cody-session',
      backendType: 'process',
      isActive: true,
    },
    {
      name: 'oscar',
      providerId: 'opencode',
      model: 'opencode/big-pickle',
    },
  ],
};

describe('TeamProvisioningClearStoppedTeamRuntimeHandles', () => {
  it('strips leftover process handles after Stop without dropping roster identity', () => {
    const stripped = stripStoppedTeamLiveRuntimeHandlesFromConfig(MIXED_STOPPED_CONFIG);

    expect(stripped.changed).toBe(true);
    expect(stripped.parsed).toEqual({
      name: 'mixed-v2150-20260917',
      leadAgentId: 'team-lead@mixed-v2150-20260917',
      members: [
        {
          agentId: 'team-lead@mixed-v2150-20260917',
          name: 'team-lead',
          tmuxPaneId: '',
          providerId: 'anthropic',
          sessionId: 'lead-session',
        },
        {
          name: 'alice',
          providerId: 'anthropic',
          backendType: 'process',
          bootstrapRunId: '81bc7f8b-fd2c-47e6-b720-91927c98a0b7',
          isActive: false,
        },
        {
          name: 'cody',
          providerId: 'codex',
          backendType: 'process',
          isActive: false,
        },
        {
          name: 'oscar',
          providerId: 'opencode',
          model: 'opencode/big-pickle',
        },
      ],
    });
  });

  it('does not rewrite config that already has no live process handles', () => {
    const idle = {
      members: [{ name: 'oscar', providerId: 'opencode' }],
    };
    expect(stripStoppedTeamLiveRuntimeHandlesFromConfig(idle)).toEqual({
      parsed: idle,
      changed: false,
    });
    expect(stripStoppedTeamLiveRuntimeHandlesFromConfig(null)).toEqual({
      parsed: null,
      changed: false,
    });
  });

  it('clears leftover isActive after Stop even when process handles are already gone', () => {
    const leftover = {
      members: [{ name: 'cody', providerId: 'codex', isActive: true }],
    };
    expect(stripStoppedTeamLiveRuntimeHandlesFromConfig(leftover)).toEqual({
      changed: true,
      parsed: {
        members: [{ name: 'cody', providerId: 'codex', isActive: false }],
      },
    });
  });

  it('persists the stripped config and invalidates caches', () => {
    const writes: string[] = [];
    const invalidated: string[] = [];
    const lockCalls: string[] = [];

    const changed = persistClearedStoppedTeamLiveRuntimeHandles('mixed-v2150-20260917', {
      readTeamConfigJson: () => JSON.stringify(MIXED_STOPPED_CONFIG),
      writeTeamConfigJson: (_teamName, contents) => {
        writes.push(contents);
      },
      invalidateTeamConfig: (teamName) => {
        invalidated.push(teamName);
      },
      withTeamConfigLock: (teamName, operation) => {
        lockCalls.push(teamName);
        return operation();
      },
    });

    expect(changed).toBe(true);
    expect(lockCalls).toEqual(['mixed-v2150-20260917']);
    expect(invalidated).toEqual(['mixed-v2150-20260917']);
    expect(JSON.parse(writes[0] ?? '{}')).toMatchObject({
      members: [
        { name: 'team-lead', sessionId: 'lead-session' },
        { name: 'alice', bootstrapRunId: '81bc7f8b-fd2c-47e6-b720-91927c98a0b7' },
        { name: 'cody', isActive: false },
        { name: 'oscar', providerId: 'opencode' },
      ],
    });
    expect(writes[0]).not.toContain('runtimePid');
    expect(writes[0]).not.toContain('process:11497');
  });

  it('leaves corrupt or missing config untouched', () => {
    const writeTeamConfigJson = vi.fn();
    const invalidateTeamConfig = vi.fn();

    expect(
      persistClearedStoppedTeamLiveRuntimeHandles('team-a', {
        readTeamConfigJson: () => null,
        writeTeamConfigJson,
        invalidateTeamConfig,
      })
    ).toBe(false);
    expect(
      persistClearedStoppedTeamLiveRuntimeHandles('team-a', {
        readTeamConfigJson: () => '{not-json',
        writeTeamConfigJson,
        invalidateTeamConfig,
      })
    ).toBe(false);
    expect(writeTeamConfigJson).not.toHaveBeenCalled();
    expect(invalidateTeamConfig).not.toHaveBeenCalled();
  });

  it('invalidates main and worker-backed team config caches through the node adapter', () => {
    const mainInvalidation = vi.spyOn(TeamConfigReader, 'invalidateTeam').mockImplementation(() => {
      return undefined;
    });
    const workerInvalidation = vi
      .spyOn(getTeamDataWorkerClient(), 'invalidateTeamConfig')
      .mockImplementation(() => {
        return undefined;
      });

    createNodeClearStoppedTeamLiveRuntimeHandlesPorts().invalidateTeamConfig('team-a');

    expect(mainInvalidation).toHaveBeenCalledOnce();
    expect(mainInvalidation).toHaveBeenCalledWith('team-a');
    expect(workerInvalidation).toHaveBeenCalledOnce();
    expect(workerInvalidation).toHaveBeenCalledWith('team-a');

    mainInvalidation.mockRestore();
    workerInvalidation.mockRestore();
  });
});
