import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type ComposerDraftAddressRequest,
  useComposerDraftAddressRequest,
} from './useComposerDraftAddressRequest';

import type { CrossTeamTarget } from '@shared/types';

const targets: CrossTeamTarget[] = [
  { teamName: 'remote-team', displayName: 'Remote', members: [{ name: 'bob' }] },
];

const request: ComposerDraftAddressRequest = {
  address: {
    contextId: 'context-a',
    teamName: 'local-team',
    target: { kind: 'cross-team', toTeam: 'remote-team', toMember: 'bob' },
  },
};

const Harness = ({
  value,
  lockedRecipient,
  selectTeam,
  selectMember,
}: {
  value: ComposerDraftAddressRequest;
  lockedRecipient?: string;
  selectTeam: (teamName: string | null) => void;
  selectMember: (memberName: string | null) => void;
}): null => {
  useComposerDraftAddressRequest({
    request: value,
    lockedRecipient,
    targets,
    selectTeam,
    selectMember,
  });
  return null;
};

describe('useComposerDraftAddressRequest', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('opens an available cross-team target through the current selector', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const selectTeam = vi.fn();
    const selectMember = vi.fn();
    await act(async () => {
      root.render(
        <Harness value={request} selectTeam={selectTeam} selectMember={selectMember} />
      );
    });
    expect(selectTeam).toHaveBeenCalledWith('remote-team');
    expect(selectMember).toHaveBeenCalledWith('bob');
    act(() => root.unmount());
  });

  it('does not replace a locked direct-message recipient', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const selectTeam = vi.fn();
    const selectMember = vi.fn();
    await act(async () => {
      root.render(
        <Harness
          value={request}
          lockedRecipient="alice"
          selectTeam={selectTeam}
          selectMember={selectMember}
        />
      );
    });
    expect(selectTeam).not.toHaveBeenCalled();
    expect(selectMember).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
