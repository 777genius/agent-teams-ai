import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemberDraft } from './membersEditorTypes';

const leadRowMockState = vi.hoisted(() => ({
  lastLeadProps: null as {
    showAnthropicContextLimit?: boolean;
    disableAnthropicContextLimit?: boolean;
  } | null,
}));

vi.mock('./LeadModelRow', () => ({
  LeadModelRow: (props: {
    showAnthropicContextLimit?: boolean;
    disableAnthropicContextLimit?: boolean;
  }) => {
    leadRowMockState.lastLeadProps = props;
    return React.createElement(
      'div',
      { 'data-testid': 'lead-model-row' },
      String(props.showAnthropicContextLimit)
    );
  },
}));

vi.mock('./MembersEditorSection', () => ({
  MembersEditorSection: ({ headerExtra }: { headerExtra?: React.ReactNode }) =>
    React.createElement('div', null, headerExtra),
}));

import { TeamRosterEditorSection } from './TeamRosterEditorSection';

function renderTeamRosterEditorSection(overrides: {
  providerId?: React.ComponentProps<typeof TeamRosterEditorSection>['providerId'];
  model?: string;
  members?: MemberDraft[];
  syncModelsWithTeammates?: boolean;
  forceInheritedModelSettings?: boolean;
  hideMembersContent?: boolean;
}): { host: HTMLDivElement; root: ReturnType<typeof createRoot> } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);

  act(() => {
    root.render(
      React.createElement(TeamRosterEditorSection, {
        members: overrides.members ?? [],
        onMembersChange: () => undefined,
        inheritedProviderId: overrides.providerId ?? 'codex',
        inheritedModel: '',
        providerId: overrides.providerId ?? 'codex',
        model: overrides.model ?? '',
        limitContext: false,
        onProviderChange: () => undefined,
        onModelChange: () => undefined,
        onEffortChange: () => undefined,
        onLimitContextChange: () => undefined,
        syncModelsWithTeammates: overrides.syncModelsWithTeammates ?? false,
        onSyncModelsWithTeammatesChange: () => undefined,
        forceInheritedModelSettings: overrides.forceInheritedModelSettings,
        hideMembersContent: overrides.hideMembersContent,
      })
    );
  });

  return { host, root };
}

describe('TeamRosterEditorSection', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    leadRowMockState.lastLeadProps = null;
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('shows the Anthropic context control for explicit Anthropic teammates under a non-Anthropic lead', () => {
    const { root } = renderTeamRosterEditorSection({
      providerId: 'codex',
      members: [
        {
          id: 'member-1',
          name: 'alice',
          roleSelection: 'developer',
          customRole: '',
          providerId: 'anthropic',
          model: 'sonnet',
        },
      ],
    });

    expect(leadRowMockState.lastLeadProps?.showAnthropicContextLimit).toBe(true);

    act(() => {
      root.unmount();
    });
  });

  it('hides the Anthropic context control when teammates are synced to a non-Anthropic lead', () => {
    const { root } = renderTeamRosterEditorSection({
      providerId: 'codex',
      syncModelsWithTeammates: true,
      members: [
        {
          id: 'member-1',
          name: 'alice',
          roleSelection: 'developer',
          customRole: '',
          providerId: 'anthropic',
          model: 'sonnet',
        },
      ],
    });

    expect(leadRowMockState.lastLeadProps?.showAnthropicContextLimit).toBe(false);

    act(() => {
      root.unmount();
    });
  });

  it('ignores stale Anthropic teammate drafts when member content is hidden', () => {
    const { root } = renderTeamRosterEditorSection({
      providerId: 'codex',
      hideMembersContent: true,
      members: [
        {
          id: 'member-1',
          name: 'alice',
          roleSelection: 'developer',
          customRole: '',
          providerId: 'anthropic',
          model: 'sonnet',
        },
      ],
    });

    expect(leadRowMockState.lastLeadProps?.showAnthropicContextLimit).toBe(false);

    act(() => {
      root.unmount();
    });
  });

  it('keeps the team-wide context control enabled for Anthropic teammate overrides under a Haiku lead', () => {
    const { root } = renderTeamRosterEditorSection({
      providerId: 'anthropic',
      model: 'haiku',
      members: [
        {
          id: 'member-1',
          name: 'alice',
          roleSelection: 'developer',
          customRole: '',
          providerId: 'anthropic',
          model: 'opus',
        },
      ],
    });

    expect(leadRowMockState.lastLeadProps?.showAnthropicContextLimit).toBe(true);
    expect(leadRowMockState.lastLeadProps?.disableAnthropicContextLimit).toBe(false);

    act(() => {
      root.unmount();
    });
  });

  it('keeps the team-wide context control enabled for inherited Anthropic model overrides under a Haiku lead', () => {
    const { root } = renderTeamRosterEditorSection({
      providerId: 'anthropic',
      model: 'haiku',
      members: [
        {
          id: 'member-1',
          name: 'alice',
          roleSelection: 'developer',
          customRole: '',
          model: 'opus',
        },
      ],
    });

    expect(leadRowMockState.lastLeadProps?.showAnthropicContextLimit).toBe(true);
    expect(leadRowMockState.lastLeadProps?.disableAnthropicContextLimit).toBe(false);

    act(() => {
      root.unmount();
    });
  });

  it('keeps the team-wide context control enabled for Anthropic provider defaults under a Haiku lead', () => {
    const { root } = renderTeamRosterEditorSection({
      providerId: 'anthropic',
      model: 'haiku',
      members: [
        {
          id: 'member-1',
          name: 'alice',
          roleSelection: 'developer',
          customRole: '',
          providerId: 'anthropic',
          model: '',
        },
      ],
    });

    expect(leadRowMockState.lastLeadProps?.showAnthropicContextLimit).toBe(true);
    expect(leadRowMockState.lastLeadProps?.disableAnthropicContextLimit).toBe(false);

    act(() => {
      root.unmount();
    });
  });

  it('keeps the team-wide context control disabled when teammates only inherit a Haiku lead', () => {
    const { root } = renderTeamRosterEditorSection({
      providerId: 'anthropic',
      model: 'haiku',
      members: [
        {
          id: 'member-1',
          name: 'alice',
          roleSelection: 'developer',
          customRole: '',
          model: '',
        },
      ],
    });

    expect(leadRowMockState.lastLeadProps?.showAnthropicContextLimit).toBe(true);
    expect(leadRowMockState.lastLeadProps?.disableAnthropicContextLimit).toBe(true);

    act(() => {
      root.unmount();
    });
  });
});
