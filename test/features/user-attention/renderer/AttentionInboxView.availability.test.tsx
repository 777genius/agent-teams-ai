import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { AttentionInboxView } from '../../../../src/features/user-attention/renderer/ui/AttentionInboxView';
import { expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ supported: false }));
vi.mock('@features/user-attention/renderer/hooks/useAttentionInbox', () => ({
  useAttentionInbox: () => ({
    supported: state.supported, model: null, loading: false, error: null, refresh: vi.fn(),
  }),
}));
vi.mock('@features/user-attention/renderer/hooks/useAttentionInboxNavigation', () => ({
  useAttentionInboxNavigation: () => ({
    onOpenTask: vi.fn(), onOpenChat: vi.fn(), onOpenFull: vi.fn(),
  }),
}));
vi.mock('@features/user-attention/renderer/ui/AttentionInboxPanel', () => ({
  AttentionInboxPanel: () => <div data-testid="attention-panel" />,
}));

it('omits the dashboard panel when the server has no Attention route', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => root.render(<AttentionInboxView variant="compact" />));
    expect(host.querySelector('[data-testid="attention-panel"]')).toBeNull();
    state.supported = true;
    await act(async () => root.render(<AttentionInboxView variant="compact" />));
    expect(host.querySelector('[data-testid="attention-panel"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    state.supported = false;
    vi.unstubAllGlobals();
  }
});
