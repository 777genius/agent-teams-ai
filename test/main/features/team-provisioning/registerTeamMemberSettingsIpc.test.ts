import { TEAM_UPDATE_MEMBER_SETTINGS } from '@features/team-provisioning/contracts';
import {
  registerTeamMemberSettingsIpc,
  removeTeamMemberSettingsIpc,
} from '@features/team-provisioning/main/composition/TeamMemberSettingsIpcBoundary';
import { describe, expect, it, vi } from 'vitest';

import type { TeamMemberSettingsFeatureApi } from '@features/team-provisioning/main';
import type { IpcMain } from 'electron';

function request() {
  return {
    commandId: ' command-1 ',
    idempotencyKey: ' idem-1 ',
    teamName: ' team-a ',
    memberName: ' Alice ',
    expectedFingerprint: ' fingerprint ',
    targetKind: 'member',
    settings: {
      role: ' builder ',
      workflow: null,
      isolation: 'worktree',
      providerId: 'codex',
      providerBackendId: 'cli-sdk',
      model: ' model ',
      effort: 'high',
      fastMode: 'on',
      mcpPolicy: {
        mode: 'strictAllowlist',
        scopes: { user: true, project: false },
        serverNames: [' beta ', 'alpha', 'alpha'],
      },
    },
  };
}

describe('registerTeamMemberSettingsIpc', () => {
  it('validates and normalizes untrusted input into a standard success result', async () => {
    let handler: ((event: unknown, value: unknown) => Promise<unknown>) | undefined;
    const ipcMain = {
      handle: vi.fn((_channel, next) => {
        handler = next;
      }),
      removeHandler: vi.fn(),
    } as unknown as IpcMain;
    const updateMemberSettings = vi.fn(async (value) => ({
      outcome: 'completed' as const,
      effect: 'persisted_only' as const,
      memberName: value.memberName,
      previousFingerprint: value.expectedFingerprint,
      currentFingerprint: 'next',
      replayed: false,
    }));
    registerTeamMemberSettingsIpc(ipcMain, { updateMemberSettings });

    const result = await handler?.({}, request());

    expect(ipcMain.handle).toHaveBeenCalledWith(TEAM_UPDATE_MEMBER_SETTINGS, expect.any(Function));
    expect(updateMemberSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: 'command-1',
        teamName: 'team-a',
        memberName: 'Alice',
        settings: expect.objectContaining({
          role: 'builder',
          model: 'model',
          mcpPolicy: expect.objectContaining({ serverNames: ['alpha', 'beta'] }),
        }),
      })
    );
    expect(result).toEqual({
      success: true,
      data: expect.objectContaining({ outcome: 'completed' }),
    });
  });

  it.each([
    ['teamName', '../outside'],
    ['memberName', '../outside'],
  ] as const)('rejects path traversal in %s before calling the feature', async (field, value) => {
    let handler: ((event: unknown, value: unknown) => Promise<unknown>) | undefined;
    const ipcMain = {
      handle: vi.fn((_channel, next) => {
        handler = next;
      }),
      removeHandler: vi.fn(),
    } as unknown as IpcMain;
    const updateMemberSettings = vi.fn();
    registerTeamMemberSettingsIpc(ipcMain, { updateMemberSettings });

    const result = await handler?.({}, { ...request(), [field]: value });

    expect(result).toMatchObject({ success: false });
    expect(updateMemberSettings).not.toHaveBeenCalled();
  });

  it.each(['lead', 'team lead', 'team-lead', 'orchestrator'])(
    'rejects the reserved role %s before calling the feature',
    async (role) => {
      let handler: ((event: unknown, value: unknown) => Promise<unknown>) | undefined;
      const ipcMain = {
        handle: vi.fn((_channel, next) => {
          handler = next;
        }),
        removeHandler: vi.fn(),
      } as unknown as IpcMain;
      const updateMemberSettings = vi.fn();
      registerTeamMemberSettingsIpc(ipcMain, { updateMemberSettings });

      const value = request();
      value.settings.role = ` ${role.toUpperCase()} `;
      const result = await handler?.({}, value);

      expect(result).toEqual({
        success: false,
        error: 'settings.role is reserved for the team lead',
      });
      expect(updateMemberSettings).not.toHaveBeenCalled();
    }
  );

  it('accepts only model and effort for explicit lead intent', async () => {
    let handler: ((event: unknown, value: unknown) => Promise<unknown>) | undefined;
    const ipcMain = {
      handle: vi.fn((_channel, next) => {
        handler = next;
      }),
      removeHandler: vi.fn(),
    } as unknown as IpcMain;
    const updateMemberSettings = vi.fn(async () => ({
      outcome: 'completed' as const,
      effect: 'lead_restart_started' as const,
      memberName: 'Lead',
      previousFingerprint: 'before',
      currentFingerprint: 'after',
      replayed: false,
    }));
    registerTeamMemberSettingsIpc(ipcMain, { updateMemberSettings });

    await expect(
      handler?.(
        {},
        {
          ...request(),
          targetKind: 'lead',
          settings: undefined,
          leadRuntime: { model: 'claude-opus-4-1', effort: 'high' },
        }
      )
    ).resolves.toMatchObject({ success: true });
    expect(updateMemberSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        targetKind: 'lead',
        leadRuntime: { model: 'claude-opus-4-1', effort: 'high' },
      })
    );

    await expect(
      handler?.(
        {},
        {
          ...request(),
          targetKind: 'lead',
          settings: undefined,
          leadRuntime: { model: 'claude-opus-4-1', effort: 'high', role: 'lead' },
        }
      )
    ).resolves.toMatchObject({ success: false });
  });

  it('rejects partial settings and removes the registered handler', async () => {
    let handler: ((event: unknown, value: unknown) => Promise<unknown>) | undefined;
    const ipcMain = {
      handle: vi.fn((_channel, next) => {
        handler = next;
      }),
      removeHandler: vi.fn(),
    } as unknown as IpcMain;
    const feature: TeamMemberSettingsFeatureApi = { updateMemberSettings: vi.fn() };
    registerTeamMemberSettingsIpc(ipcMain, feature);
    const invalid = request();
    delete (invalid.settings as Partial<typeof invalid.settings>).workflow;

    await expect(handler?.({}, invalid)).resolves.toEqual({
      success: false,
      error: 'settings.workflow is required; use null to clear it',
    });
    expect(feature.updateMemberSettings).not.toHaveBeenCalled();

    removeTeamMemberSettingsIpc(ipcMain);
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(TEAM_UPDATE_MEMBER_SETTINGS);
  });
});
