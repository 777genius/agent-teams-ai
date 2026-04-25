import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProviderModelBadges } from '@renderer/components/runtime/ProviderModelBadges';

function render(element: React.ReactElement): HTMLDivElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(element);
  });
  return host;
}

describe('ProviderModelBadges', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('does not render stale availability chips for OpenCode models', () => {
    const host = render(
      <ProviderModelBadges
        providerId="opencode"
        models={['openrouter/openai/gpt-oss-20b:free']}
        modelAvailability={[
          {
            modelId: 'openrouter/openai/gpt-oss-20b:free',
            status: 'unknown',
            reason: 'old bulk check failed',
            checkedAt: '2026-04-25T00:00:00.000Z',
          },
        ]}
      />
    );

    expect(host.textContent).toContain('gpt-oss');
    expect(host.textContent).not.toContain('Check failed');
  });

  it('keeps availability chips for providers that still support explicit badge checks', () => {
    const host = render(
      <ProviderModelBadges
        providerId="codex"
        models={['gpt-5-codex']}
        modelAvailability={[
          {
            modelId: 'gpt-5-codex',
            status: 'unknown',
            reason: 'probe timeout',
            checkedAt: '2026-04-25T00:00:00.000Z',
          },
        ]}
      />
    );

    expect(host.textContent).toContain('Check failed');
  });

  it('collapses long model lists and expands them into a bounded scroll area', () => {
    const models = Array.from(
      { length: 18 },
      (_, index) => `model-${String(index + 1).padStart(2, '0')}`
    );
    const host = render(
      <ProviderModelBadges providerId="codex" models={models} collapseAfter={15} />
    );

    expect(host.textContent).toContain('model-15');
    expect(host.textContent).not.toContain('model-16');
    expect(host.textContent).toContain('+3 more');

    const moreButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('+3 more')
    );
    expect(moreButton).toBeTruthy();

    act(() => {
      moreButton?.click();
    });

    expect(host.textContent).toContain('model-18');
    expect(host.textContent).toContain('Hide');
    const list = host.firstElementChild?.firstElementChild as HTMLElement | null;
    expect(list?.style.maxHeight).toBe('200px');
    expect(list?.style.overflowY).toBe('auto');

    const hideButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Hide')
    );
    expect(hideButton).toBeTruthy();

    act(() => {
      hideButton?.click();
    });

    expect(host.textContent).not.toContain('model-16');
    expect(host.textContent).toContain('+3 more');
  });
});
