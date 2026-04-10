import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  Tooltip: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: unknown) => unknown) =>
    selector({
      cliStatus: null,
      appConfig: { general: { multimodelEnabled: true } },
    }),
}));

import { TeamModelSelector } from '@renderer/components/team/dialogs/TeamModelSelector';
import { GPT_5_1_CODEX_MINI_UI_DISABLED_REASON } from '@renderer/utils/teamModelAvailability';

describe('TeamModelSelector disabled Codex models', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders GPT-5.1 Codex Mini as disabled with an explanation tooltip', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'codex',
          onProviderChange: () => undefined,
          value: '',
          onValueChange: () => undefined,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('GPT-5.1 Codex Mini');
    expect(host.textContent).toContain('Disabled');
    expect(host.textContent).toContain(GPT_5_1_CODEX_MINI_UI_DISABLED_REASON);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('normalizes a stale disabled selection back to default', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onValueChange = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'codex',
          onProviderChange: () => undefined,
          value: 'gpt-5.1-codex-mini',
          onValueChange,
        })
      );
      await Promise.resolve();
    });

    expect(onValueChange).toHaveBeenCalledWith('');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
