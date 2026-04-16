import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface StoreState {
  installCustomMcpServer: ReturnType<typeof vi.fn>;
}

const storeState = {} as StoreState;
const lookupMock = vi.fn();

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: StoreState) => unknown) => selector(storeState),
}));

vi.mock('@renderer/api', () => ({
  api: {
    apiKeys: {
      lookup: (...args: unknown[]) => lookupMock(...args),
    },
  },
}));

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    type = 'button',
    disabled,
  }: React.PropsWithChildren<{
    onClick?: () => void;
    type?: 'button' | 'submit' | 'reset';
    disabled?: boolean;
  }>) =>
    React.createElement(
      'button',
      {
        type,
        disabled,
        onClick,
      },
      children
    ),
}));

vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: ({ open, children }: React.PropsWithChildren<{ open: boolean }>) =>
    open ? React.createElement('div', null, children) : null,
  DialogContent: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  DialogHeader: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  DialogTitle: ({ children }: React.PropsWithChildren) => React.createElement('h2', null, children),
  DialogDescription: ({ children }: React.PropsWithChildren) =>
    React.createElement('p', null, children),
}));

vi.mock('@renderer/components/ui/input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) =>
    React.createElement('input', props),
}));

vi.mock('@renderer/components/ui/label', () => ({
  Label: ({ children }: React.PropsWithChildren) => React.createElement('label', null, children),
}));

vi.mock('@renderer/components/ui/select', () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: React.PropsWithChildren<{ value: string; onValueChange: (value: string) => void }>) =>
    React.createElement(
      'select',
      {
        'data-testid': 'scope-select',
        value,
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) => onValueChange(event.target.value),
      },
      children
    ),
  SelectTrigger: ({ children }: React.PropsWithChildren) =>
    React.createElement(React.Fragment, null, children),
  SelectValue: () => null,
  SelectContent: ({ children }: React.PropsWithChildren) =>
    React.createElement(React.Fragment, null, children),
  SelectItem: ({
    children,
    value,
    disabled,
  }: React.PropsWithChildren<{ value: string; disabled?: boolean }>) =>
    React.createElement('option', { value, disabled }, children),
}));

vi.mock('lucide-react', () => {
  const Icon = (props: React.SVGProps<SVGSVGElement>) => React.createElement('svg', props);
  return {
    Plus: Icon,
    Server: Icon,
    Trash2: Icon,
  };
});

import { CustomMcpServerDialog } from '@renderer/components/extensions/mcp/CustomMcpServerDialog';

function setNativeValue(
  element: HTMLInputElement | HTMLSelectElement,
  value: string,
  eventName: 'input' | 'change'
): void {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  descriptor?.set?.call(element, value);
  element.dispatchEvent(new Event(eventName, { bubbles: true }));
}

describe('CustomMcpServerDialog project scope', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.installCustomMcpServer = vi.fn().mockResolvedValue(undefined);
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([]);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('disables project scope without an active project', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(CustomMcpServerDialog, {
          open: true,
          onClose: vi.fn(),
          projectPath: null,
        })
      );
      await Promise.resolve();
    });

    const projectOption = host.querySelector('option[value="project"]') as HTMLOptionElement;
    expect(projectOption.disabled).toBe(true);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('passes projectPath for project-scoped custom installs', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onClose = vi.fn();
    const projectPath = '/tmp/custom-mcp-project';

    await act(async () => {
      root.render(
        React.createElement(CustomMcpServerDialog, {
          open: true,
          onClose,
          projectPath,
        })
      );
      await Promise.resolve();
    });

    const nameInput = host.querySelector('#custom-name') as HTMLInputElement;
    const packageInput = host.querySelector('#custom-npm') as HTMLInputElement;
    const scopeSelect = host.querySelector('[data-testid="scope-select"]') as HTMLSelectElement;

    await act(async () => {
      setNativeValue(nameInput, 'custom-context7', 'input');
      setNativeValue(packageInput, '@upstash/context7-mcp', 'input');
      setNativeValue(scopeSelect, 'project', 'change');
      await Promise.resolve();
    });

    const installButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'Install'
    ) as HTMLButtonElement;
    expect(installButton.disabled).toBe(false);

    await act(async () => {
      installButton.click();
      await Promise.resolve();
    });

    expect(storeState.installCustomMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: 'custom-context7',
        scope: 'project',
        projectPath,
      })
    );
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
