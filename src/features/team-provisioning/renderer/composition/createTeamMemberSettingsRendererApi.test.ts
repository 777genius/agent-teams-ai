import { describe, expect, it, vi } from 'vitest';

import { createTeamMemberSettingsRendererApi } from './createTeamMemberSettingsRendererApi';

describe('createTeamMemberSettingsRendererApi', () => {
  it('forwards member settings saves through the composed legacy API', async () => {
    const result = {
      outcome: 'completed',
      effect: 'persisted_only',
      memberName: 'alice',
      previousFingerprint: 'before',
      currentFingerprint: 'after',
      replayed: false,
    } as const;
    const updateMemberSettings = vi.fn().mockResolvedValue(result);
    const api = createTeamMemberSettingsRendererApi({ teams: { updateMemberSettings } });
    const request: Parameters<typeof api.updateMemberSettings>[0] = {
      teamName: 'alpha',
      memberName: 'alice',
      commandId: 'command-1',
      idempotencyKey: 'settings:alpha:alice:1',
      expectedFingerprint: 'before',
      targetKind: 'member',
      settings: {
        role: 'developer',
        workflow: null,
        isolation: null,
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5',
        effort: 'high',
        fastMode: 'inherit',
        mcpPolicy: null,
      },
    };

    await expect(api.updateMemberSettings(request)).resolves.toBe(result);
    expect(updateMemberSettings).toHaveBeenCalledOnce();
    expect(updateMemberSettings).toHaveBeenCalledWith(request);
  });
});
