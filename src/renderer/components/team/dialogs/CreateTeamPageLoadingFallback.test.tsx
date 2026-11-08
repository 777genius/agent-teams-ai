import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { describe, expect, it, vi } from 'vitest';

import { CreateTeamPageLoadingFallback } from './CreateTeamPageLoadingFallback';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

describe('CreateTeamPageLoadingFallback', () => {
  it('matches the creation page shell and keeps an accessible, inert form skeleton', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const onClose = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(React.createElement(CreateTeamPageLoadingFallback, {
        isCopy: false, onClose,
      })));
      const page = host.querySelector('[data-testid="create-team-page"]');
      expect(page?.getAttribute('aria-busy')).toBe('true');
      expect(page?.querySelector('[role="status"]')).not.toBeNull();
      expect(page?.querySelectorAll('[data-testid="create-team-loading-member"]')).toHaveLength(2);
      expect(page?.querySelector('.max-w-\\[24rem\\]')).not.toBeNull();
      expect(page?.querySelector('input,select,textarea')).toBeNull();
      const back = page?.querySelector<HTMLButtonElement>('button');
      await act(async () => back?.click());
      expect(onClose).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
