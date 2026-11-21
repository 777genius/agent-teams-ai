import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const teams = vi.hoisted(() => ({
  getSavedRequest: vi.fn(),
  getMemberSettingsTarget: vi.fn(),
  updateMemberSettings: vi.fn(),
}));
const applyCommittedLeadRuntime = vi.hoisted(() => vi.fn());
const refreshAfterDefinitionEdit = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('@renderer/api', () => ({ api: { teams } }));
// Stable like the real `t` of react-i18next (the loader depends on it).
const translation = vi.hoisted(() => ({ t: (key: string) => key }));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => translation,
}));
vi.mock('@renderer/components/team/definitionEdit/definitionEditActions', () => ({
  refreshAfterDefinitionEdit,
}));
vi.mock('@features/team-provisioning/renderer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@features/team-provisioning/renderer')>()),
  applyCommittedLeadRuntime,
}));
vi.mock('@renderer/components/ui/button', () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement('button', { ...props, type: 'button' }),
}));
vi.mock('@renderer/components/ui/dialog', () => {
  const Wrap = ({ children }: { children?: React.ReactNode }) =>
    React.createElement('div', null, children);
  return {
    Dialog: Wrap,
    DialogContent: Wrap,
    DialogDescription: Wrap,
    DialogFooter: Wrap,
    DialogHeader: Wrap,
    DialogTitle: ({ children }: { children?: React.ReactNode }) =>
      React.createElement('h2', null, children),
  };
});
vi.mock('@renderer/components/team/members/MembersEditorSection', () => ({
  createMemberDraftsFromInputs: (members: Record<string, unknown>[]) =>
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
    leadRuntimeSettingsOnly,
  }: {
    members: Record<string, unknown>[];
    onChange: (members: Record<string, unknown>[]) => void;
    leadRuntimeSettingsOnly?: boolean;
  }) =>
    React.createElement(
      'button',
      {
        type: 'button',
        'data-testid': 'lead-model-editor',
        'data-lead-runtime-only': String(leadRuntimeSettingsOnly),
        onClick: () => onChange([{ ...members[0], model: 'model-two', effort: 'high' }]),
      },
      'editor'
    ),
}));

import {
  createMemberSettingsFingerprint,
  type MemberSettingsTargetSnapshot,
} from '@features/team-provisioning/core/domain/memberSettingsPolicy';

import { TeamMemberSettingsDialogRoute } from '@renderer/components/team/definitionEdit/TeamMemberSettingsDialogRoute';

import type { MemberSettingsTarget } from '@features/team-provisioning/contracts';

/** What main answers for the lead of a team definition: its launch settings, an offline lead. */
const leadTarget: MemberSettingsTarget = {
  name: 'team-lead',
  agentType: 'team-lead',
  agentId: null,
  joinedAt: null,
  settings: {
    role: null,
    workflow: null,
    isolation: null,
    providerId: 'anthropic',
    providerBackendId: null,
    model: 'model-one',
    effort: 'medium',
    fastMode: null,
    mcpPolicy: null,
  },
};

/** The fingerprint main compares for that target (the use case's own function). */
const mainFingerprint = createMemberSettingsFingerprint({
  ...leadTarget,
  teamIsAlive: false,
  leadProviderId: 'anthropic',
  teamIsMixed: false,
  runtimeLane: 'primary',
} satisfies MemberSettingsTargetSnapshot);

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let onClose: ReturnType<typeof vi.fn>;

const flush = async (): Promise<void> => {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  teams.getSavedRequest.mockReset().mockResolvedValue({
    teamName: 'builders',
    providerId: 'anthropic',
    model: 'model-one',
    effort: 'medium',
    members: [{ name: 'alice', role: 'Developer' }],
    savedSettingsFingerprint: 'definition-settings',
  });
  teams.getMemberSettingsTarget.mockReset().mockResolvedValue(leadTarget);
  teams.updateMemberSettings.mockReset().mockResolvedValue({
    outcome: 'completed',
    effect: 'persisted_only',
    memberName: 'team-lead',
    previousFingerprint: mainFingerprint,
    currentFingerprint: 'after',
    replayed: false,
  });
  applyCommittedLeadRuntime.mockReset();
  refreshAfterDefinitionEdit.mockClear();
  onClose = vi.fn();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

/**
 * The lead of a per-project team, edited from the screen of one project: the
 * dialog loads the lead from the team definition (not from the open copy),
 * sends exactly the fingerprint main compares (otherwise every save would be
 * an endless "settings changed"), writes to the logical team, and leaves the
 * launch dialog of the team (keyed by the team, not by the copy) on the saved
 * model and effort.
 */
describe('TeamMemberSettingsDialogRoute, the lead of a per-project team', () => {
  it('loads the definition lead, saves it with the fingerprint main compares, and updates the team launch defaults', async () => {
    act(() => {
      root.render(
        <TeamMemberSettingsDialogRoute
          teamName="ptc-a"
          logicalTeamName="builders"
          memberName="team-lead"
          members={[]}
          isTeamAlive={false}
          isTeamProvisioning={false}
          onClose={onClose}
          onRelaunchRequired={vi.fn()}
        />
      );
    });
    await flush();
    expect(teams.getMemberSettingsTarget).toHaveBeenCalledWith({
      teamName: 'builders',
      memberName: 'team-lead',
    });
    const editor = host.querySelector<HTMLButtonElement>('[data-testid="lead-model-editor"]');
    expect(editor?.dataset.leadRuntimeOnly).toBe('true');
    act(() => editor?.click());
    const save = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('editTeam.actions.save')
    );
    await act(async () => save?.click());
    await flush();

    expect(teams.updateMemberSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        teamName: 'builders',
        memberName: 'team-lead',
        targetKind: 'lead',
        leadRuntime: { model: 'model-two', effort: 'high' },
        expectedFingerprint: mainFingerprint,
      })
    );
    expect(applyCommittedLeadRuntime).toHaveBeenCalledWith('builders', {
      model: 'model-two',
      effort: 'high',
    });
    expect(refreshAfterDefinitionEdit).toHaveBeenCalledWith('ptc-a');
    expect(onClose).toHaveBeenCalled();
  });

  it('says that a member is missing from the team definition', async () => {
    teams.getMemberSettingsTarget.mockResolvedValue(null);
    act(() => {
      root.render(
        <TeamMemberSettingsDialogRoute
          teamName="ptc-a"
          logicalTeamName="builders"
          memberName="carol"
          members={[]}
          isTeamAlive={false}
          isTeamProvisioning={false}
          onClose={onClose}
          onRelaunchRequired={vi.fn()}
        />
      );
    });
    await flush();
    expect(host.textContent).toContain('detail.editDefinition.memberNotFound');
    expect(teams.updateMemberSettings).not.toHaveBeenCalled();
  });
});
