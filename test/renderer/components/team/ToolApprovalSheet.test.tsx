import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolApprovalRequest } from '@shared/types';

const mocks = vi.hoisted(() => ({
  pendingApprovals: [] as ToolApprovalRequest[],
  respond: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@renderer/hooks/useTheme', () => ({ useTheme: () => ({ isLight: false }) }));
vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      pendingApprovals: mocks.pendingApprovals,
      respondToToolApproval: mocks.respond,
      updateToolApprovalSettings: vi.fn(),
      teams: [],
      selectedTeamName: null,
      selectedTeamData: null,
      toolApprovalSettings: {},
      toolApprovalSettingsByTeam: {},
    }),
}));
vi.mock('@renderer/store/slices/teamSlice', () => ({
  selectResolvedMembersForTeamName: () => [],
}));
vi.mock('@renderer/store/team/teamToolApprovalSettings', () => ({
  resolveToolApprovalSettingsForTeam: () => ({
    timeoutAction: 'wait',
    timeoutSeconds: 60,
  }),
}));
vi.mock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
vi.mock('@renderer/constants/teamColors', () => ({
  getTeamColorSet: () => ({ text: '#fff', border: '#fff' }),
  getThemedBadge: () => '#000',
}));
vi.mock('@renderer/utils/syntaxHighlighter', () => ({ highlightLines: () => ['command'] }));
vi.mock('@renderer/components/team/dialogs/ToolApprovalSettingsPanel', () => ({
  ToolApprovalSettingsContent: () => null,
  ToolApprovalSettingsToggle: () => null,
}));
vi.mock('@renderer/components/team/ToolApprovalDiffPreview', () => ({
  ToolApprovalDiffPreview: () => null,
}));
vi.mock('@renderer/components/team/MemberBadge', () => ({ MemberBadge: () => null }));
vi.mock('@renderer/components/team/editor/FileIcon', () => ({ FileIcon: () => null }));

import { ToolApprovalSheet } from '@renderer/components/team/ToolApprovalSheet';

const approval: ToolApprovalRequest = {
  requestId: 'request-1',
  runId: 'run-1',
  teamName: 'test-team',
  source: 'lead',
  toolName: 'Bash',
  toolInput: { command: 'pwd' },
  receivedAt: new Date().toISOString(),
};

describe('ToolApprovalSheet keyboard handling', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.pendingApprovals = [];
    mocks.respond.mockClear();
    host = document.createElement('div');
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });

  it.each(['Enter', 'Escape'])(
    'does not intercept %s while no approval is visible',
    async (key) => {
      await act(async () => root.render(<ToolApprovalSheet />));

      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      document.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(false);
      expect(mocks.respond).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['Enter', true],
    ['Escape', false],
  ])('keeps active approval %s handling', async (key, allow) => {
    mocks.pendingApprovals = [approval];
    await act(async () => root.render(<ToolApprovalSheet />));

    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    await act(async () => document.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(true);
    expect(mocks.respond).toHaveBeenCalledWith(
      approval.teamName,
      approval.runId,
      approval.requestId,
      allow,
      undefined
    );
  });
});
