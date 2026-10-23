import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listGatewayProfiles: vi.fn(),
  listGatewayBindings: vi.fn(),
  saveGatewayProfile: vi.fn(),
  deleteGatewayProfile: vi.fn(),
}));

vi.mock('@renderer/api', () => ({
  api: { gatewayProvider: mocks },
}));

vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open?: boolean; children?: React.ReactNode }) =>
    open ? React.createElement('div', { 'data-testid': 'dialog' }, children) : null,
  DialogContent: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('div', null, children),
  DialogHeader: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('div', null, children),
  DialogTitle: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('h2', null, children),
  DialogDescription: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('p', null, children),
  DialogFooter: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

vi.mock('@renderer/components/ui/checkbox', () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked?: boolean;
    onCheckedChange?: (value: boolean) => void;
  } & Record<string, unknown>) =>
    React.createElement('input', {
      ...props,
      checked,
      type: 'checkbox',
      onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
        onCheckedChange?.(event.target.checked),
    }),
}));

import { GatewayProvidersSettingsSection } from '../GatewayProvidersSettingsSection';

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

function renderSection(): {
  host: HTMLDivElement;
  root: ReturnType<typeof createRoot>;
} {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(React.createElement(GatewayProvidersSettingsSection));
  });
  return { host, root };
}

function buttonByText(host: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label
  );
  if (!button) throw new Error(`Button "${label}" not found`);
  return button;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('GatewayProvidersSettingsSection', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.listGatewayProfiles.mockResolvedValue([profile]);
    mocks.listGatewayBindings.mockResolvedValue([binding]);
  });

  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  it('lists profiles with binding counts and keeps history visible after deletion', async () => {
    mocks.listGatewayProfiles.mockResolvedValue([profile]);
    mocks.deleteGatewayProfile.mockResolvedValue(undefined);
    const { host, root } = renderSection();
    await settle();

    expect(host.textContent).toContain('Gateway providers');
    expect(host.textContent).toContain('Team Gateway');
    expect(host.textContent).toContain('https://gw.example.com');
    expect(host.textContent).toContain('Bound teammates: 1');
    expect(host.textContent).toContain(
      'Deleting a profile does not hide historical usage sources from reports and budgets.'
    );

    mocks.listGatewayProfiles.mockResolvedValue([]);
    await act(async () => {
      buttonByText(host, 'Delete').click();
    });

    expect(mocks.deleteGatewayProfile).toHaveBeenCalledWith('prof-1');
    expect(host.textContent).not.toContain('Team Gateway');

    act(() => {
      root.unmount();
    });
  });

  it('creates a profile including the private-network consent', async () => {
    mocks.saveGatewayProfile.mockResolvedValue(profile);
    const { host, root } = renderSection();
    await settle();

    await act(async () => {
      buttonByText(host, 'Add profile').click();
    });

    const dialog = document.body.querySelector('[data-testid="dialog"]')!;
    setInputValue(dialog.querySelector<HTMLInputElement>('#gateway-profile-name')!, 'Personal GW');
    setInputValue(
      dialog.querySelector<HTMLInputElement>('#gateway-profile-url')!,
      'https://personal.example.com'
    );
    const checkbox = dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    act(() => {
      checkbox.click();
    });
    await act(async () => {
      buttonByText(dialog as HTMLElement, 'Save').click();
    });

    expect(mocks.saveGatewayProfile).toHaveBeenCalledWith({
      id: undefined,
      displayName: 'Personal GW',
      baseUrl: 'https://personal.example.com',
      allowPrivateNetwork: true,
    });
    expect(document.body.querySelector('[data-testid="dialog"]')).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it('surfaces the server error and explains the next step when a bound URL is saved', async () => {
    mocks.saveGatewayProfile.mockRejectedValue(
      new Error(
        'Unbind teammates from this profile before changing its URL, or create another profile.'
      )
    );
    const { host, root } = renderSection();
    await settle();

    await act(async () => {
      buttonByText(host, 'Edit').click();
    });

    const dialog = document.body.querySelector('[data-testid="dialog"]')!;
    setInputValue(
      dialog.querySelector<HTMLInputElement>('#gateway-profile-url')!,
      'https://moved.example.com'
    );
    await act(async () => {
      buttonByText(dialog as HTMLElement, 'Save').click();
    });

    expect(mocks.saveGatewayProfile).toHaveBeenCalledWith({
      id: 'prof-1',
      displayName: 'Team Gateway',
      baseUrl: 'https://moved.example.com',
      allowPrivateNetwork: false,
    });
    expect(dialog.textContent).toContain(
      'Unbind teammates from this profile before changing its URL, or create another profile.'
    );
    expect(dialog.textContent).toContain(
      'This profile still has teammates bound to it. Unbind them first, or create another profile for the new URL.'
    );

    act(() => {
      root.unmount();
    });
  });

  it('does not block deletion itself and only surfaces the server rule', async () => {
    mocks.deleteGatewayProfile.mockRejectedValue(
      new Error('Unbind teammates from this profile before deleting it.')
    );
    const { host, root } = renderSection();
    await settle();

    await act(async () => {
      buttonByText(host, 'Delete').click();
    });

    expect(mocks.deleteGatewayProfile).toHaveBeenCalledWith('prof-1');
    expect(host.textContent).toContain('Unbind teammates from this profile before deleting it.');
    expect(host.textContent).toContain('Team Gateway');

    act(() => {
      root.unmount();
    });
  });
});
