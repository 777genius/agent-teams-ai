import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { expect, it, vi } from 'vitest';

import { RuntimeProviderModelTestResult } from '../../../../src/features/runtime-provider-management/renderer/ui/RuntimeProviderModelTestResult';

it.each([true, false])(
  'exposes the actual result independently of message wording (%s)',
  async (ok) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          <RuntimeProviderModelTestResult
            result={{
              providerId: 'opencode',
              modelId: 'opencode/big-pickle',
              ok,
              availability: 'unknown',
              message: 'A different translated message',
              diagnostics: [],
            }}
            formatMessage={(message) => ({ summary: message, details: null })}
          />
        )
      );
      expect(host.firstElementChild?.getAttribute('data-result-status')).toBe(
        ok ? 'success' : 'error'
      );
      expect(host.textContent).toContain('A different translated message');
    } finally {
      await act(async () => root.unmount());
    }
  }
);
