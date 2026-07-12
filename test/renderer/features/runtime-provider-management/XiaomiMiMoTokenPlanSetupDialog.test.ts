import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { XiaomiMiMoTokenPlanSetupDialog } from '../../../../src/features/runtime-provider-management/renderer/ui/XiaomiMiMoTokenPlanSetupDialog';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string, values?: { region?: string }) => {
      const labels: Record<string, string> = {
        'cliStatus.quickConnect.xiaomiSetupTitle': 'Connect Xiaomi MiMo Token Plan',
        'cliStatus.quickConnect.xiaomiSetupDescription': 'Paste the Dedicated Base URL.',
        'cliStatus.quickConnect.xiaomiBaseUrlLabel': 'Dedicated Base URL',
        'cliStatus.quickConnect.xiaomiBaseUrlHint': 'Copy the URL from the plan page.',
        'cliStatus.quickConnect.xiaomiOpenPlanPage': 'Open Token Plan page',
        'cliStatus.quickConnect.xiaomiRegionDetected': `${values?.region ?? ''} endpoint detected`,
        'cliStatus.quickConnect.xiaomiRegionAutomatic': 'Region is detected automatically.',
        'cliStatus.quickConnect.cancel': 'Cancel',
        'cliStatus.quickConnect.continue': 'Continue',
        'actions.close': 'Close',
      };
      return labels[key] ?? key;
    },
  }),
}));

describe('XiaomiMiMoTokenPlanSetupDialog', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  const enterBaseUrl = async (input: HTMLInputElement, value: string): Promise<void> => {
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('detects the OpenCode provider from the dashboard Base URL and continues', async () => {
    const onConnect = vi.fn();
    const onOpenChange = vi.fn();
    await act(async () => {
      root.render(
        React.createElement(XiaomiMiMoTokenPlanSetupDialog, {
          open: true,
          onOpenChange,
          onConnect,
          onOpenPlanPage: vi.fn(),
        })
      );
    });

    const input = document.querySelector<HTMLInputElement>('[data-testid="xiaomi-mimo-base-url"]');
    expect(input).not.toBeNull();
    if (!input) throw new Error('MiMo Base URL input was not rendered');
    await enterBaseUrl(input, 'https://token-plan-sgp.xiaomimimo.com/anthropic');

    expect(document.querySelector('[data-testid="xiaomi-mimo-detected-region"]')?.textContent).toContain(
      'Singapore endpoint detected'
    );
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="xiaomi-mimo-continue"]')?.click();
    });

    expect(onConnect).toHaveBeenCalledWith('xiaomi-token-plan-sgp');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('keeps an unrecognized URL inside the resolver instead of forwarding it', async () => {
    const onConnect = vi.fn();
    await act(async () => {
      root.render(
        React.createElement(XiaomiMiMoTokenPlanSetupDialog, {
          open: true,
          onOpenChange: vi.fn(),
          onConnect,
          onOpenPlanPage: vi.fn(),
        })
      );
    });

    const input = document.querySelector<HTMLInputElement>('[data-testid="xiaomi-mimo-base-url"]');
    if (!input) throw new Error('MiMo Base URL input was not rendered');
    await enterBaseUrl(input, 'https://example.com/v1');
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="xiaomi-mimo-continue"]')?.click();
    });

    expect(document.querySelector('[role="alert"]')?.textContent).toContain('not recognized');
    expect(onConnect).not.toHaveBeenCalled();
  });
});
