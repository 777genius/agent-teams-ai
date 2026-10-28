import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listGatewayProfiles: vi.fn(),
  listGatewayBindings: vi.fn(),
  probeGatewayModels: vi.fn(),
  bindGatewayMember: vi.fn(),
  unbindGatewayMember: vi.fn(),
}));

vi.mock('@renderer/api', () => ({
  api: { gatewayProvider: mocks },
}));

vi.mock('@renderer/components/ui/select', async () => {
  const reactModule = await import('react');
  const SelectContext = reactModule.createContext<{
    onValueChange?: (value: string) => void;
  }>({});
  return {
    Select: ({
      value,
      onValueChange,
      children,
    }: {
      value?: string;
      onValueChange?: (value: string) => void;
      children?: React.ReactNode;
    }) =>
      reactModule.createElement(
        'div',
        { 'data-testid': 'select', 'data-value': value ?? '' },
        reactModule.createElement(SelectContext.Provider, { value: { onValueChange } }, children)
      ),
    SelectTrigger: ({ children, id }: { children?: React.ReactNode; id?: string }) =>
      reactModule.createElement('button', { type: 'button', id }, children),
    SelectContent: ({ children }: { children?: React.ReactNode }) =>
      reactModule.createElement('div', null, children),
    SelectItem: ({ value, children }: { value: string; children?: React.ReactNode }) => {
      const SelectItemButton = (): React.ReactElement => {
        const ctx = reactModule.useContext(SelectContext);
        return reactModule.createElement(
          'button',
          {
            type: 'button',
            'data-testid': 'select-item',
            'data-value': value,
            onClick: () => ctx.onValueChange?.(value),
          },
          children
        );
      };
      return reactModule.createElement(SelectItemButton);
    },
    SelectValue: ({ placeholder }: { placeholder?: string }) =>
      reactModule.createElement('span', null, placeholder ?? ''),
  };
});

import { MemberGatewaySelector } from '../MemberGatewaySelector';

const profile = {
  id: 'prof-1',
  displayName: 'Team Gateway',
  baseUrl: 'https://gw.example.com',
  allowPrivateNetwork: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const binding = {
  teamName: 'alpha',
  memberName: 'alice',
  profileId: 'prof-1',
  profileDisplayName: 'Team Gateway',
  gatewayUsageRef: 'usage-ref',
  boundAt: '2026-01-02T00:00:00.000Z',
  credentialStatus: 'ready' as const,
};

function renderSelector(props: Partial<React.ComponentProps<typeof MemberGatewaySelector>> = {}): {
  host: HTMLDivElement;
  root: ReturnType<typeof createRoot>;
  onModelChange: ReturnType<typeof vi.fn>;
} {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const onModelChange = vi.fn();
  act(() => {
    root.render(
      React.createElement(MemberGatewaySelector, {
        teamName: 'alpha',
        memberName: 'alice',
        onModelChange,
        ...props,
      })
    );
  });
  return { host, root, onModelChange };
}

function buttonByText(host: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label
  );
  if (!button) throw new Error(`Button "${label}" not found`);
  return button;
}

function clickSelectItem(host: HTMLElement, value: string): void {
  const item = Array.from(
    host.querySelectorAll<HTMLButtonElement>('button[data-testid="select-item"]')
  ).find((candidate) => candidate.getAttribute('data-value') === value);
  if (!item) throw new Error(`Select item "${value}" not found`);
  act(() => {
    item.click();
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('MemberGatewaySelector', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.listGatewayProfiles.mockResolvedValue([profile]);
    mocks.listGatewayBindings.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  it('probes the key, lists gateway models, binds, and never keeps the key in the DOM', async () => {
    mocks.probeGatewayModels.mockResolvedValue({ models: ['claude-sonnet-4', 'claude-opus-4'] });
    mocks.bindGatewayMember.mockResolvedValue(binding);
    const onBindingPendingChange = vi.fn();
    const { host, root, onModelChange } = renderSelector({ onBindingPendingChange });
    await settle();

    clickSelectItem(host, 'prof-1');
    const keyInput = host.querySelector<HTMLInputElement>('input[type="password"]')!;
    act(() => {
      keyInput.value = 'sk-secret-123';
    });
    await act(async () => {
      buttonByText(host, 'Check key and load models').click();
    });

    expect(mocks.probeGatewayModels).toHaveBeenCalledWith({
      profileId: 'prof-1',
      apiKey: 'sk-secret-123',
    });
    expect(host.textContent).toContain('claude-sonnet-4');
    expect(keyInput.value).toBe('');
    expect(document.body.innerHTML).not.toContain('sk-secret-123');

    clickSelectItem(host, 'claude-sonnet-4');
    await act(async () => {
      buttonByText(host, 'Bind teammate').click();
    });

    expect(mocks.bindGatewayMember).toHaveBeenCalledWith({
      teamName: 'alpha',
      memberName: 'alice',
      profileId: 'prof-1',
      apiKey: 'sk-secret-123',
    });
    expect(onModelChange).toHaveBeenCalledWith('claude-sonnet-4');
    expect(onBindingPendingChange.mock.calls).toEqual([[true], [false]]);
    expect(onModelChange.mock.invocationCallOrder[0]).toBeLessThan(
      onBindingPendingChange.mock.invocationCallOrder[1]
    );
    expect(document.body.innerHTML).not.toContain('sk-secret-123');

    act(() => {
      root.unmount();
    });
  });

  it('shows an inline authorization error for an invalid key', async () => {
    mocks.probeGatewayModels.mockRejectedValue(new Error('Gateway request failed (HTTP 401).'));
    const { host, root } = renderSelector();
    await settle();

    clickSelectItem(host, 'prof-1');
    act(() => {
      // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- deliberately invalid test input
      host.querySelector<HTMLInputElement>('input[type="password"]')!.value = 'sk-bad';
    });
    await act(async () => {
      buttonByText(host, 'Check key and load models').click();
    });

    expect(host.textContent).toContain('Key authorization was rejected.');
    expect(
      host.querySelector('button[data-testid="select-item"][data-value="claude-sonnet-4"]')
    ).toBeNull();
    expect(document.body.innerHTML).not.toContain('sk-bad');

    act(() => {
      root.unmount();
    });
  });

  it('reports an empty model catalog without offering manual model input', async () => {
    mocks.probeGatewayModels.mockResolvedValue({ models: [] });
    const { host, root } = renderSelector();
    await settle();

    clickSelectItem(host, 'prof-1');
    act(() => {
      // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- deliberately invalid test input
      host.querySelector<HTMLInputElement>('input[type="password"]')!.value = 'sk-empty';
    });
    await act(async () => {
      buttonByText(host, 'Check key and load models').click();
    });

    expect(host.textContent).toContain('The model catalog is empty.');
    expect(host.querySelector('#member-alice-gateway-model')).toBeNull();
    expect(
      Array.from(host.querySelectorAll('button')).some(
        (button) => button.textContent?.trim() === 'Bind teammate'
      )
    ).toBe(false);
    expect(
      Array.from(host.querySelectorAll('input')).filter((input) => input.type !== 'password')
    ).toHaveLength(0);

    act(() => {
      root.unmount();
    });
  });

  it('shows binding status and unbinds the teammate', async () => {
    mocks.listGatewayBindings.mockResolvedValue([binding]);
    mocks.unbindGatewayMember.mockResolvedValue(undefined);
    const { host, root } = renderSelector();
    await settle();

    expect(host.textContent).toContain('Bound to Team Gateway');
    expect(host.textContent).toContain('key stored');

    await act(async () => {
      buttonByText(host, 'Unbind').click();
    });

    expect(mocks.unbindGatewayMember).toHaveBeenCalledWith({
      teamName: 'alpha',
      memberName: 'alice',
      expectedBinding: { gatewayUsageRef: binding.gatewayUsageRef, boundAt: binding.boundAt },
    });

    act(() => {
      root.unmount();
    });
  });

  it('spells out next-launch-only semantics and the rename re-bind rule', async () => {
    mocks.listGatewayBindings.mockResolvedValue([binding]);
    const { host, root } = renderSelector({ originalName: 'alice-old' });
    await settle();

    expect(host.textContent).toContain(
      'Changes apply on the next team launch only; a running team keeps its current gateway route.'
    );
    expect(host.textContent).toContain(
      'Renaming a teammate removes the gateway binding. After saving, bind again manually with a new key'
    );

    act(() => {
      root.unmount();
    });
  });
});
