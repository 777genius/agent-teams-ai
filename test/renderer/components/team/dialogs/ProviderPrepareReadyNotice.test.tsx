import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { ProviderPrepareReadyNotice } from '@renderer/components/team/dialogs/ProviderPrepareReadyNotice';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string) =>
      key.endsWith('readyWithNotes') ? 'Ready with notes.' : 'All selected providers are ready.',
  }),
}));
vi.mock('@renderer/components/team/dialogs/ProvisioningProviderStatusList', () => ({
  ProvisioningProviderStatusList: () => null,
}));

describe('ProviderPrepareReadyNotice', () => {
  beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
  afterEach(() => vi.unstubAllGlobals());
  it.each([
    ['All selected providers are ready.', [], 0],
    ['  All selected providers are ready.  ', [], 0],
    ['Ready with notes.', ['Optional note'], 0],
    ['Selected model was verified.', [], 1],
  ] as const)(
    'does not repeat the heading but retains distinct detail: %s',
    async (message, warnings, count) => {
      const host = document.createElement('div');
      const root = createRoot(host);
      try {
        await act(async () => {
          root.render(
            <ProviderPrepareReadyNotice
              checks={[]}
              message={message}
              warnings={[...warnings]}
              onOpenProviderSettings={() => {}}
            />
          );
        });
        expect(host.querySelectorAll('p.mt-0\\.5')).toHaveLength(count);
        if (count) expect(host.textContent).toContain(message);
      } finally {
        await act(async () => root.unmount());
      }
    }
  );
});
