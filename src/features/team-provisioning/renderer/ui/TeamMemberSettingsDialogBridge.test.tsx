import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dialogProps = vi.hoisted(() => vi.fn());

vi.mock('./EditTeamMemberDialog', () => ({
  EditTeamMemberDialog: (props: Record<string, unknown>) => {
    dialogProps(props);
    const [initialMember] = React.useState(props.member as ResolvedTeamMember);
    return React.createElement('div', {
      'data-testid': 'member-dialog',
      'data-agent-id': initialMember.agentId,
    });
  },
}));

import { TeamMemberSettingsDialogBridge } from './TeamMemberSettingsDialogBridge';

import type { ResolvedTeamMember } from '@shared/types';

const member: ResolvedTeamMember = {
  name: 'alice',
  agentType: 'developer',
  status: 'idle',
  currentTaskId: null,
  taskCount: 0,
  lastActiveAt: null,
  messageCount: 0,
  role: 'developer',
  providerId: 'codex',
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function render(members: readonly ResolvedTeamMember[]): void {
  root.render(
    <TeamMemberSettingsDialogBridge
      teamName="alpha"
      memberName="alice"
      members={members}
      isTeamAlive
      isTeamProvisioning={false}
      updateMemberSettings={vi.fn()}
      onClose={vi.fn()}
      onRefresh={vi.fn()}
      onRelaunchRequired={vi.fn()}
    />
  );
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  dialogProps.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('TeamMemberSettingsDialogBridge', () => {
  it('keeps the last target visible but stale when it disappears during editing', async () => {
    await act(async () => render([member]));
    expect(dialogProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ member, targetAvailable: true })
    );

    await act(async () => render([]));
    expect(host.querySelector('[data-testid="member-dialog"]')).not.toBeNull();
    expect(dialogProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ member, targetAvailable: false })
    );
  });

  it('remounts the dialog when a same-name target gets a new runtime identity', async () => {
    await act(async () => render([{ ...member, agentId: 'agent-1' }]));
    expect(host.querySelector('[data-testid="member-dialog"]')?.getAttribute('data-agent-id')).toBe(
      'agent-1'
    );

    await act(async () => render([{ ...member, agentId: 'agent-2' }]));
    expect(host.querySelector('[data-testid="member-dialog"]')?.getAttribute('data-agent-id')).toBe(
      'agent-2'
    );
  });
});
