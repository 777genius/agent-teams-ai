import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updateMemberSettings = vi.hoisted(() => vi.fn());

vi.mock('@renderer/api', () => ({ api: { teams: { updateMemberSettings } } }));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@renderer/components/ui/button', () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement('button', { ...props, type: 'button' }),
}));
vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: ({
    children,
    onOpenChange,
  }: {
    children: React.ReactNode;
    onOpenChange: (open: boolean) => void;
  }) =>
    React.createElement(
      'div',
      null,
      React.createElement(
        'button',
        { type: 'button', 'data-testid': 'dismiss', onClick: () => onOpenChange(false) },
        'dismiss'
      ),
      children
    ),
  DialogContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  DialogDescription: ({ children }: { children: React.ReactNode }) =>
    React.createElement('p', null, children),
  DialogFooter: ({ children }: { children: React.ReactNode }) =>
    React.createElement('footer', null, children),
  DialogHeader: ({ children }: { children: React.ReactNode }) =>
    React.createElement('header', null, children),
  DialogTitle: ({ children }: { children: React.ReactNode }) =>
    React.createElement('h2', null, children),
}));
vi.mock('@renderer/components/team/members/MembersEditorSection', () => ({
  createMemberDraftsFromInputs: (members: Array<Record<string, unknown>>) =>
    members.map((member) => ({
      id: member.name,
      name: member.name,
      originalName: member.name,
      roleSelection: member.role ?? '',
      customRole: '',
      workflow: member.workflow,
      providerId: member.providerId,
      providerBackendId: member.providerBackendId,
      model: member.model ?? '',
      effort: member.effort,
      fastMode: member.fastMode,
      mcpPolicy: member.mcpPolicy,
      isolation: member.isolation,
    })),
  MembersEditorSection: ({
    members,
    onChange,
    singleMemberMode,
    inheritedProviderId,
    leadRuntimeSettingsOnly,
  }: {
    members: Array<Record<string, unknown>>;
    onChange: (members: Array<Record<string, unknown>>) => void;
    singleMemberMode?: boolean;
    inheritedProviderId?: string;
    leadRuntimeSettingsOnly?: boolean;
  }) =>
    React.createElement(
      React.Fragment,
      null,
      React.createElement(
        'button',
        {
          type: 'button',
          'data-testid': 'editor',
          'data-single': String(singleMemberMode),
          'data-inherited-provider': inheritedProviderId,
          'data-lead-runtime-only': String(leadRuntimeSettingsOnly),
          onClick: () => onChange([{ ...members[0], roleSelection: 'reviewer' }]),
        },
        'editor'
      ),
      React.createElement(
        'button',
        {
          type: 'button',
          'data-testid': 'reserved-editor',
          onClick: () =>
            onChange([{ ...members[0], roleSelection: '__custom__', customRole: 'Team Lead' }]),
        },
        'reserved editor'
      ),
      React.createElement(
        'button',
        {
          type: 'button',
          'data-testid': 'model-editor',
          onClick: () => onChange([{ ...members[0], model: 'claude-opus-4-1' }]),
        },
        'model editor'
      )
    ),
}));

import { EditTeamMemberDialog } from './EditTeamMemberDialog';

import type { ResolvedTeamMember } from '@shared/types';

const member: ResolvedTeamMember = {
  name: 'alice',
  agentId: 'agent-1',
  agentType: 'developer',
  status: 'idle',
  currentTaskId: null,
  taskCount: 0,
  lastActiveAt: null,
  messageCount: 0,
  role: 'developer',
  providerId: 'anthropic',
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let onClose: ReturnType<typeof vi.fn>;
let onRefresh: ReturnType<typeof vi.fn>;
let onRelaunchRequired: ReturnType<typeof vi.fn>;

function render(overrides: Partial<React.ComponentProps<typeof EditTeamMemberDialog>> = {}): void {
  root.render(
    <EditTeamMemberDialog
      open
      teamName="alpha"
      member={member}
      isTeamAlive={false}
      isTeamProvisioning={false}
      isMixedTeam={false}
      onClose={onClose}
      onRefresh={onRefresh}
      onRelaunchRequired={onRelaunchRequired}
      {...overrides}
    />
  );
}

function saveButton(): HTMLButtonElement {
  return Array.from(host.querySelectorAll('button')).find((button) =>
    button.textContent?.includes('editTeam.actions.save')
  )!;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001');
  updateMemberSettings.mockReset();
  onClose = vi.fn();
  onRefresh = vi.fn(async () => {});
  onRelaunchRequired = vi.fn();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('EditTeamMemberDialog', () => {
  it('saves one draft with stable command identity and closes a no-op after refresh', async () => {
    updateMemberSettings.mockResolvedValue({
      outcome: 'completed',
      effect: 'no_changes',
      memberName: 'alice',
      previousFingerprint: 'same',
      currentFingerprint: 'same',
    });
    act(() => render());
    expect(host.querySelector('[data-testid="editor"]')?.getAttribute('data-single')).toBe('true');
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="editor"]')?.click());
    await act(async () => saveButton().click());

    expect(updateMemberSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: '00000000-0000-4000-8000-000000000001',
        idempotencyKey: '00000000-0000-4000-8000-000000000001',
        teamName: 'alpha',
        memberName: 'alice',
      })
    );
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('sends explicit model/effort-only intent for a lead without reserved role fields', async () => {
    updateMemberSettings.mockResolvedValue({
      outcome: 'completed',
      effect: 'lead_restart_started',
      memberName: 'team-lead',
      previousFingerprint: 'old',
      currentFingerprint: 'new',
    });
    act(() =>
      render({
        isLead: true,
        isTeamAlive: true,
        leadProviderId: 'anthropic',
        member: { ...member, name: 'team-lead', agentType: 'team-lead', role: 'Team Lead' },
      })
    );
    expect(
      host.querySelector('[data-testid="editor"]')?.getAttribute('data-lead-runtime-only')
    ).toBe('true');
    expect(host.textContent).toContain('editTeam.leadRestartWarning');
    expect(host.textContent).not.toContain('editTeam.memberRestartWarning');
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="model-editor"]')?.click());
    await act(async () => saveButton().click());

    expect(updateMemberSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        targetKind: 'lead',
        leadRuntime: { model: 'claude-opus-4-1', effort: null },
      })
    );
    expect(updateMemberSettings.mock.calls[0]?.[0]).not.toHaveProperty('settings');
    expect(onRefresh).toHaveBeenCalledWith({
      model: 'claude-opus-4-1',
      effort: null,
    });
  });

  it('preserves effective lead runtime values when configured settings are partial', async () => {
    updateMemberSettings.mockResolvedValue({
      outcome: 'completed',
      effect: 'lead_restart_started',
      memberName: 'team-lead',
      previousFingerprint: 'old',
      currentFingerprint: 'new',
    });
    act(() =>
      render({
        isLead: true,
        isTeamAlive: true,
        leadProviderId: 'codex',
        member: {
          ...member,
          name: 'team-lead',
          agentType: 'team-lead',
          providerId: 'codex',
          model: 'gpt-5.6-sol',
          effort: 'high',
          configuredRuntimeSettings: {},
        },
      })
    );
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="model-editor"]')?.click());
    await act(async () => saveButton().click());

    expect(updateMemberSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        leadRuntime: { model: 'claude-opus-4-1', effort: 'high' },
      })
    );
  });

  it('refreshes and stays open on conflict', async () => {
    updateMemberSettings.mockResolvedValue({
      outcome: 'target_conflict',
      memberName: 'alice',
      expectedFingerprint: 'old',
      actualFingerprint: 'new',
    });
    act(() => render());
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="editor"]')?.click());
    await act(async () => saveButton().click());
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(onRefresh).toHaveBeenCalledWith(undefined);
    expect(onClose).not.toHaveBeenCalled();
    expect(host.textContent).toContain('editTeam.errors.settingsChanged');
  });

  it('stays open and allows a fresh command after a busy result', async () => {
    updateMemberSettings.mockResolvedValue({
      outcome: 'busy',
      teamName: 'alpha',
      memberName: 'alice',
      replayed: false,
    });
    act(() => render());
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="editor"]')?.click());
    await act(async () => saveButton().click());
    expect(onClose).not.toHaveBeenCalled();
    expect(host.textContent).toContain('editTeam.errors.saveFailed');
  });

  it('refreshes and stays open when recovery is required', async () => {
    updateMemberSettings.mockResolvedValue({
      outcome: 'completed',
      effect: 'recovery_required',
      memberName: 'alice',
      previousFingerprint: 'old',
      currentFingerprint: 'old',
    });
    act(() => render());
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="editor"]')?.click());
    await act(async () => saveButton().click());
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(host.textContent).toContain('editTeam.errors.saveFailed');
  });

  it('uses a fresh command identity when retrying a rolled-back lead restart', async () => {
    vi.mocked(globalThis.crypto.randomUUID)
      .mockReset()
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000001')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000002');
    updateMemberSettings.mockResolvedValue({
      outcome: 'completed',
      effect: 'lead_restart_rolled_back',
      memberName: 'team-lead',
      previousFingerprint: 'old',
      currentFingerprint: 'old',
    });
    act(() =>
      render({
        isLead: true,
        isTeamAlive: true,
        leadProviderId: 'anthropic',
        member: { ...member, name: 'team-lead', agentType: 'team-lead' },
      })
    );
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="model-editor"]')?.click());

    await act(async () => saveButton().click());
    await act(async () => saveButton().click());

    expect(updateMemberSettings.mock.calls.map(([request]) => request.commandId)).toEqual([
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
    ]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('refreshes current truth after a failed mutation', async () => {
    updateMemberSettings.mockRejectedValue(new Error('failed'));
    act(() => render());
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="editor"]')?.click());
    await act(async () => saveButton().click());
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('stays open and does not repeat refresh when refresh fails after a successful save', async () => {
    updateMemberSettings.mockResolvedValue({
      outcome: 'completed',
      effect: 'persisted_only',
      memberName: 'alice',
      previousFingerprint: 'old',
      currentFingerprint: 'new',
    });
    onRefresh.mockRejectedValue(new Error('offline'));
    act(() => render());
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="editor"]')?.click());
    await act(async () => saveButton().click());

    expect(updateMemberSettings).toHaveBeenCalledOnce();
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(host.textContent).toContain('editTeam.errors.changesSavedRefreshFailed');
  });

  it('does not claim settings were saved when refresh fails after a no-op result', async () => {
    updateMemberSettings.mockResolvedValue({
      outcome: 'completed',
      effect: 'no_changes',
      memberName: 'alice',
      previousFingerprint: 'same',
      currentFingerprint: 'same',
    });
    onRefresh.mockRejectedValue(new Error('offline'));
    act(() => render());
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="editor"]')?.click());
    await act(async () => saveButton().click());

    expect(host.textContent).toContain('editTeam.errors.saveFailed');
    expect(host.textContent).not.toContain('editTeam.errors.changesSavedRefreshFailed');
  });

  it('switches unsafe live edits to the existing relaunch action without mutation', () => {
    act(() => render({ isTeamAlive: true, isMixedTeam: true }));
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="editor"]')?.click());
    const relaunch = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('activity.actions.restartTeam')
    )!;
    act(() => relaunch.click());
    expect(updateMemberSettings).not.toHaveBeenCalled();
    expect(onRelaunchRequired).toHaveBeenCalledOnce();
  });

  it('blocks close while saving', async () => {
    let resolve!: (value: unknown) => void;
    updateMemberSettings.mockReturnValue(new Promise((done) => (resolve = done)));
    act(() => render());
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="editor"]')?.click());
    act(() => saveButton().click());
    expect(saveButton().disabled).toBe(true);
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="dismiss"]')?.click());
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      resolve({
        outcome: 'completed',
        effect: 'persisted_only',
        memberName: 'alice',
        previousFingerprint: 'old',
        currentFingerprint: 'new',
      });
      await Promise.resolve();
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('disables save for a normalized no-op', () => {
    act(() => render());
    expect(saveButton().disabled).toBe(true);
  });

  it('disables save for a reserved role', () => {
    act(() => render());
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="reserved-editor"]')?.click());
    expect(saveButton().disabled).toBe(true);
  });

  it('uses the lead provider for inherited model controls', () => {
    act(() => render({ leadProviderId: 'codex' }));
    expect(
      host.querySelector('[data-testid="editor"]')?.getAttribute('data-inherited-provider')
    ).toBe('codex');
  });

  it('does not persist effective inherited runtime values as explicit overrides', async () => {
    updateMemberSettings.mockResolvedValue({
      outcome: 'completed',
      effect: 'persisted_only',
      memberName: 'alice',
      previousFingerprint: 'old',
      currentFingerprint: 'new',
      replayed: false,
    });
    act(() =>
      render({
        leadProviderId: 'codex',
        member: {
          ...member,
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'effective-model',
          selectedFastMode: 'on',
          configuredRuntimeSettings: {},
        },
      })
    );
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="editor"]')?.click());
    await act(async () => saveButton().click());

    expect(updateMemberSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({
          providerId: null,
          providerBackendId: null,
          model: null,
          fastMode: null,
        }),
      })
    );
  });

  it('shows the current task warning and the exact OpenCode lane action', () => {
    act(() =>
      render({
        isTeamAlive: true,
        member: {
          ...member,
          providerId: 'opencode',
          configuredRuntimeSettings: { providerId: 'opencode' },
          laneId: 'secondary-1',
          laneKind: 'secondary',
          currentTaskId: 'task-42',
        },
      })
    );
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="editor"]')?.click());
    expect(host.textContent).toContain('detail.actions.task: task-42');
    expect(host.textContent).toContain('liveRuntimeStatus.lane');
  });

  it('updates the task warning from live props without resetting the open draft', async () => {
    updateMemberSettings.mockResolvedValue({
      outcome: 'completed',
      effect: 'persisted_only',
      memberName: 'alice',
      previousFingerprint: 'old',
      currentFingerprint: 'new',
      replayed: false,
    });
    act(() => render({ isTeamAlive: true }));
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="editor"]')?.click());
    act(() => render({ isTeamAlive: true, member: { ...member, currentTaskId: 'task-42' } }));

    expect(host.textContent).toContain('detail.actions.task: task-42');
    await act(async () => saveButton().click());
    expect(updateMemberSettings).toHaveBeenCalledWith(
      expect.objectContaining({ settings: expect.objectContaining({ role: 'reviewer' }) })
    );
  });

  it('keeps a disappeared target visible as stale and disables save', () => {
    act(() => render({ targetAvailable: false }));
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="editor"]')?.click());
    expect(host.textContent).toContain('editTeam.errors.settingsChanged');
    expect(saveButton().disabled).toBe(true);
  });
});
