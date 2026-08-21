import {
  TEAM_UPDATE_MEMBER_SETTINGS,
  type UpdateMemberSettingsRequest,
  type UpdateMemberSettingsResult,
} from '@features/team-provisioning/contracts';
import {
  createTeamMemberSettingsBridge,
  type InvokeIpcWithResult,
} from '@features/team-provisioning/preload';
import { describe, expect, it, vi } from 'vitest';

const request: UpdateMemberSettingsRequest = {
  commandId: 'command-1',
  idempotencyKey: 'member-settings-1',
  teamName: 'team-a',
  memberName: 'worker',
  expectedFingerprint: 'fingerprint-before',
  settings: {
    role: 'Implement the assigned slice',
    workflow: null,
    isolation: 'worktree',
    providerId: 'codex',
    providerBackendId: 'codex-native',
    model: 'gpt-5.6-sol',
    effort: 'medium',
    fastMode: 'inherit',
    mcpPolicy: null,
  },
};

describe('createTeamMemberSettingsBridge', () => {
  it('invokes the member settings channel once with the unchanged request', async () => {
    const result: UpdateMemberSettingsResult = {
      outcome: 'completed',
      effect: 'persisted_only',
      memberName: 'worker',
      previousFingerprint: 'fingerprint-before',
      currentFingerprint: 'fingerprint-after',
      replayed: false,
    };
    const invokeMock = vi.fn(async () => result);
    const invoke = invokeMock as InvokeIpcWithResult;
    const bridge = createTeamMemberSettingsBridge(invoke);

    await expect(bridge.updateMemberSettings(request)).resolves.toBe(result);

    expect(invokeMock).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith(TEAM_UPDATE_MEMBER_SETTINGS, request);
  });

  it('propagates invoker errors to the caller', async () => {
    const failure = new Error('ipc failed');
    const invokeMock = vi.fn(async () => {
      throw failure;
    });
    const invoke = invokeMock as InvokeIpcWithResult;
    const bridge = createTeamMemberSettingsBridge(invoke);

    await expect(bridge.updateMemberSettings(request)).rejects.toBe(failure);
  });
});
