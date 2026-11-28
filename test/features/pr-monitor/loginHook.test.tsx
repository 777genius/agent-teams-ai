import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

const signOut = vi.hoisted(() => vi.fn());
vi.mock('@renderer/api', () => ({ api: { prMonitor: { signOut } } }));
vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: { activeContextId: string }) => unknown) =>
    selector({ activeContextId: 'local' }),
}));
vi.mock('@renderer/store/utils/contextScopedRequestEpoch', () => ({
  captureContextScopedRequestEpoch: () => 1,
  subscribeContextScopedRequestEpoch: () => () => undefined,
}));

import { useGitHubLogin } from '../../../src/features/pr-monitor/renderer/hooks/useGitHubLogin';

describe('native login interaction', () => {
  it('invalidates observations if credential deletion fails after authority was retired', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    signOut.mockRejectedValue(new Error('TEST store failure'));
    const changed = vi.fn();
    let latest!: ReturnType<typeof useGitHubLogin>;
    function Probe() {
      latest = useGitHubLogin('TEST-project', true, changed);
      return null;
    }
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      await act(async () => root.render(<Probe />));
      await act(async () => latest.signOut());
      expect(changed).toHaveBeenCalledOnce();
      expect(latest.error?.message).toBe('Could not sign out. Try again.');
      expect(latest.busy).toBe(false);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
