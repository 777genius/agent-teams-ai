import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { expect, it, vi } from 'vitest';

import { ProviderCatalogDiagnostics } from './ProviderCatalogDiagnostics';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string) =>
      (
        ({
          'providerModelBadges.checkFailed': 'Check failed',
          'actions.showMore': 'Show more',
          'actions.showLess': 'Show less',
        }) as Record<string, string>
      )[key] ?? key,
  }),
}));

it('keeps long diagnostics out of the summary and exposes all details in a bounded keyboard-accessible disclosure', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const message = 'provider: timeout with diagnostic details '.repeat(100);
  try {
    await act(async () => root.render(<ProviderCatalogDiagnostics message={message} />));
    const trigger = host.querySelector('button')!;
    expect(trigger.textContent).toBe('Check failedShow more');
    expect(host.textContent).not.toContain(message);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      trigger.focus();
      trigger.click();
    });
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const details = host.querySelector('pre')!;
    expect(details.textContent).toBe(message);
    expect(details.tabIndex).toBe(0);
    expect(details.className).toContain('max-h-48');
    expect(details.className).toContain('overflow-auto');
    expect(details.className).toContain('[overflow-wrap:anywhere]');
    await act(async () => trigger.click());
    expect(host.textContent).not.toContain(message);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
