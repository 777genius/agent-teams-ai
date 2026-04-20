import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CodexAccountSnapshotDto } from '@features/codex-account/contracts';

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

vi.mock('@renderer/components/ui/tabs', () => {
  let currentValue = '';
  let currentOnValueChange: ((value: string) => void) | null = null;

  return {
    Tabs: ({
      children,
      value,
      onValueChange,
    }: {
      children: React.ReactNode;
      value: string;
      onValueChange?: (value: string) => void;
    }) => {
      currentValue = value;
      currentOnValueChange = onValueChange ?? null;
      return React.createElement('div', { 'data-tabs-value': value }, children);
    },
    TabsList: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
    TabsTrigger: ({
      children,
      value,
      disabled,
      title,
    }: {
      children: React.ReactNode;
      value: string;
      disabled?: boolean;
      title?: string;
    }) =>
      React.createElement(
        'button',
        {
          type: 'button',
          disabled,
          title,
          'data-state': currentValue === value ? 'active' : 'inactive',
          onClick: () => {
            if (!disabled) {
              currentOnValueChange?.(value);
            }
          },
        },
        children
      ),
  };
});

const storeState = {
  cliStatus: null as unknown,
  cliStatusLoading: false,
  appConfig: { general: { multimodelEnabled: true } },
  fetchCliProviderStatus: vi.fn().mockResolvedValue(undefined),
};
const codexAccountHookState = {
  snapshot: null as CodexAccountSnapshotDto | null,
  loading: false,
  error: null as string | null,
  refresh: vi.fn(() => Promise.resolve(undefined)),
  startChatgptLogin: vi.fn(() => Promise.resolve(true)),
  cancelChatgptLogin: vi.fn(() => Promise.resolve(true)),
  logout: vi.fn(() => Promise.resolve(true)),
};

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: unknown) => unknown) => selector(storeState),
}));

vi.mock('@features/codex-account/renderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@features/codex-account/renderer')>();
  return {
    ...actual,
    useCodexAccountSnapshot: () => codexAccountHookState,
  };
});

import { TeamModelSelector } from '@renderer/components/team/dialogs/TeamModelSelector';

describe('TeamModelSelector disabled Codex models', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    storeState.cliStatus = null;
    storeState.cliStatusLoading = false;
    storeState.fetchCliProviderStatus.mockClear();
    codexAccountHookState.snapshot = null;
    codexAccountHookState.loading = false;
    codexAccountHookState.error = null;
    codexAccountHookState.refresh.mockClear();
    codexAccountHookState.startChatgptLogin.mockClear();
    codexAccountHookState.cancelChatgptLogin.mockClear();
    codexAccountHookState.logout.mockClear();
  });

  it('shows only Default while Codex runtime models are still loading', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatusLoading = true;
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

    expect(host.textContent).toContain('Default');
    expect(host.textContent).not.toContain('5.1 Codex Mini');
    expect(host.textContent).not.toContain('5.3 Codex Spark');

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

  it('normalizes a stale 5.3 Codex Spark selection back to default', async () => {
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
          value: 'gpt-5.3-codex-spark',
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

  it('uses the runtime-reported Codex list and clears stale unsupported selections', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      providers: [
        {
          providerId: 'codex',
          models: ['gpt-5.4', 'gpt-5.3-codex'],
        },
      ],
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onValueChange = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'codex',
          onProviderChange: () => undefined,
          value: 'gpt-5.2-codex',
          onValueChange,
        })
      );
      await Promise.resolve();
    });

    expect(onValueChange).toHaveBeenCalledWith('');
    expect(host.textContent).toContain('5.4');
    expect(host.textContent).toContain('5.3 Codex');
    expect(host.textContent).not.toContain('5.2 Codex');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps the runtime-reported Codex model list visible during a background refresh', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      providers: [
        {
          providerId: 'codex',
          models: ['gpt-5.4', 'gpt-5.3-codex'],
        },
      ],
    };
    storeState.cliStatusLoading = true;

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

    expect(host.textContent).toContain('5.4');
    expect(host.textContent).toContain('5.3 Codex');
    expect(host.textContent).not.toContain('Explicit models load from the current runtime');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows 5.2 Codex as a disabled tile when the runtime still reports it', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      providers: [
        {
          providerId: 'codex',
          models: ['gpt-5.4', 'gpt-5.2-codex'],
          modelVerificationState: 'idle',
          modelAvailability: [],
        },
      ],
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onValueChange = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'codex',
          onProviderChange: () => undefined,
          value: '',
          onValueChange,
        })
      );
      await Promise.resolve();
    });

    const disabledButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('5.2 Codex')
    );

    expect(disabledButton).not.toBeNull();
    expect(disabledButton?.getAttribute('aria-disabled')).toBe('true');
    expect(disabledButton?.textContent).toContain('Disabled');
    expect(disabledButton?.getAttribute('title')).toContain(
      'Temporarily disabled for team agents - this model is not currently available on the Codex native runtime.'
    );

    await act(async () => {
      disabledButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onValueChange).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps 5.1 Codex Max selectable on the native Codex path', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      providers: [
        {
          providerId: 'codex',
          authMethod: 'api_key',
          backend: {
            kind: 'codex-native',
            label: 'Codex native',
            endpointLabel: 'codex exec --json',
          },
          models: ['gpt-5.4', 'gpt-5.1-codex-max'],
          modelVerificationState: 'idle',
          modelAvailability: [],
        },
      ],
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onValueChange = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'codex',
          onProviderChange: () => undefined,
          value: '',
          onValueChange,
        })
      );
      await Promise.resolve();
    });

    const button = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('5.1 Codex Max')
    );

    expect(button).not.toBeNull();
    expect(button?.getAttribute('aria-disabled')).toBe('false');
    expect(button?.textContent).not.toContain('Disabled');

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onValueChange).toHaveBeenCalledWith('gpt-5.1-codex-max');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('disables 5.1 Codex Max when the live Codex snapshot says ChatGPT account mode', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      providers: [
        {
          providerId: 'codex',
          authMethod: null,
          backend: null,
          models: ['gpt-5.4', 'gpt-5.1-codex-max'],
          modelVerificationState: 'idle',
          modelAvailability: [],
        },
      ],
    };
    codexAccountHookState.snapshot = {
      preferredAuthMode: 'chatgpt',
      effectiveAuthMode: 'chatgpt',
      launchAllowed: true,
      launchIssueMessage: null,
      launchReadinessState: 'ready_chatgpt',
      appServerState: 'healthy',
      appServerStatusMessage: null,
      managedAccount: {
        type: 'chatgpt',
        email: 'user@example.com',
        planType: 'pro',
      },
      apiKey: {
        available: false,
        source: null,
        sourceLabel: null,
      },
      requiresOpenaiAuth: false,
      localAccountArtifactsPresent: false,
      login: {
        status: 'idle',
        error: null,
        startedAt: null,
      },
      rateLimits: null,
      updatedAt: new Date().toISOString(),
    };

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

    expect(host.textContent).toContain('5.4');
    const disabledButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('5.1 Codex Max')
    );
    expect(disabledButton).not.toBeNull();
    expect(disabledButton?.getAttribute('aria-disabled')).toBe('true');
    expect(disabledButton?.textContent).toContain('Disabled');
    expect(disabledButton?.getAttribute('title')).toContain(
      'Temporarily disabled for team agents - this model is not currently available on the Codex native runtime.'
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps runtime model buttons selectable without starting automatic model probes', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      providers: [
        {
          providerId: 'codex',
          models: ['gpt-5.4', 'gpt-5.4-mini'],
          modelVerificationState: 'idle',
          modelAvailability: [],
        },
      ],
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onValueChange = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'codex',
          onProviderChange: () => undefined,
          value: '',
          onValueChange,
        })
      );
      await Promise.resolve();
    });

    expect(storeState.fetchCliProviderStatus).not.toHaveBeenCalled();

    const gpt54Button = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('5.4')
    );
    expect(gpt54Button?.getAttribute('aria-disabled')).toBe('false');

    await act(async () => {
      gpt54Button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onValueChange).toHaveBeenCalledWith('gpt-5.4');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('highlights the specific model tile when preflight found a model issue', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      providers: [
        {
          providerId: 'codex',
          models: ['gpt-5.4', 'gpt-5.2-codex'],
          modelVerificationState: 'idle',
          modelAvailability: [],
        },
      ],
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'codex',
          onProviderChange: () => undefined,
          value: 'gpt-5.2-codex',
          onValueChange: () => undefined,
          modelIssueReasonByValue: {
            'gpt-5.2-codex': 'Not available on this Codex native runtime',
          },
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Issue');
    const issueButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('5.2 Codex')
    );
    expect(issueButton?.className).toContain('border-red-500/40');
    expect(issueButton?.getAttribute('title')).toBe(
      'Not available on this Codex native runtime'
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows OpenCode as an in-development provider and keeps it non-selectable', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onProviderChange = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'anthropic',
          onProviderChange,
          value: '',
          onValueChange: () => undefined,
          disableGeminiOption: true,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('OpenCode');
    expect(host.textContent).not.toContain('Gemini in development');

    const buttons = Array.from(host.querySelectorAll('button'));
    const openCodeButton = buttons.find((button) => button.textContent?.includes('OpenCode'));
    expect(openCodeButton).not.toBeNull();
    expect(openCodeButton?.hasAttribute('disabled')).toBe(true);
    expect(openCodeButton?.getAttribute('title')).toContain('OpenCode in development');

    await act(async () => {
      openCodeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onProviderChange).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('switches providers through tabs instead of a dropdown', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onProviderChange = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'anthropic',
          onProviderChange,
          value: '',
          onValueChange: () => undefined,
        })
      );
      await Promise.resolve();
    });

    const buttons = Array.from(host.querySelectorAll('button'));
    const codexTab = buttons.find((button) => button.textContent?.trim() === 'Codex');
    expect(codexTab).not.toBeNull();
    expect(host.textContent).toContain('Anthropic');
    expect(host.textContent).toContain('Codex');

    await act(async () => {
      codexTab?.click();
      await Promise.resolve();
    });

    expect(onProviderChange).toHaveBeenCalledWith('codex');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
