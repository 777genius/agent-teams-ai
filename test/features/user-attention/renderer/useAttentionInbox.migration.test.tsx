import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { useAttentionInbox } from '../../../../src/features/user-attention/renderer/hooks/useAttentionInbox';
import { getReadSet } from '../../../../src/renderer/utils/teamMessageReadStorage';
import { afterEach, describe, expect, it, vi } from 'vitest';

const snapshotState = vi.hoisted(() => ({
  value: {
    contextId: 'attention-legacy-fixture',
    contextEpoch: 3,
    snapshot: {
      contextId: 'attention-legacy-fixture',
      complete: true,
      teams: [
        {
          teamName: 'legacy',
          teamDisplayName: 'Legacy',
          tasks: [],
          messages: [
            { messageId: 'legacy-read', from: 'alice', to: 'user',
              text: 'Already read', timestamp: '2026-11-23T12:00:00Z', read: true },
            { messageId: 'group-read', from: 'alice', to: 'user',
              text: '@user group', timestamp: '2026-11-23T12:01:00Z', read: true,
              groupChatId: 'design', groupMessageId: 'group-read' },
          ],
        },
        {
          teamName: 'finalized',
          teamDisplayName: 'Finalized',
          tasks: [],
          messages: [
            { messageId: 'fresh-after-finalization', from: 'bob', to: 'user',
              text: 'Check me', timestamp: '2026-11-23T12:02:00Z', read: true },
          ],
        },
      ],
    },
    loading: false,
    error: null,
    version: 1,
  },
}));

vi.mock('@renderer/store', () => ({
  useStore: (select: (state: { activeContextId: string }) => unknown) =>
    select({ activeContextId: 'attention-legacy-fixture' }),
}));
vi.mock('@renderer/store/utils/contextScopedRequestEpoch', () => ({
  captureContextScopedRequestEpoch: () => 3,
  subscribeContextScopedRequestEpoch: () => () => {},
}));
vi.mock('@features/user-attention/renderer/hooks/attentionSnapshotStore', () => ({
  getAttentionStoreState: () => snapshotState.value,
  subscribeAttention: () => () => {},
  setAttentionContext: () => {},
  refreshAttention: () => {},
}));

function Consumer(): React.JSX.Element {
  const value = useAttentionInbox();
  return <div>{value.model?.taskCount ?? 0}</div>;
}

afterEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('Attention read-state migration parity with Messenger', () => {
  it('seeds existing direct read keys without finalizing or touching groups', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    localStorage.clear();
    localStorage.setItem('team-messages-read-backfill:finalized', '1');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<Consumer />));

    expect(getReadSet('legacy').has('legacy-read')).toBe(true);
    expect(getReadSet(JSON.stringify(['group', 'attention-legacy-fixture', 'legacy']))
      .has('group-read')).toBe(false);
    expect(localStorage.getItem('team-messages-read-backfill:legacy')).toBeNull();
    expect(getReadSet('finalized').has('fresh-after-finalization')).toBe(false);

    await act(async () => root.unmount());
  });
});
