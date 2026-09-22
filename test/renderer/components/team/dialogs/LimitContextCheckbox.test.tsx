import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LimitContextCheckbox } from '@renderer/components/team/dialogs/LimitContextCheckbox';

vi.mock('@renderer/components/ui/checkbox', () => ({
  Checkbox: ({
    checked,
    disabled,
    id,
    onCheckedChange,
  }: {
    checked?: boolean;
    disabled?: boolean;
    id?: string;
    onCheckedChange?: (checked: boolean) => void;
  }) =>
    React.createElement('input', {
      checked: Boolean(checked),
      disabled,
      id,
      type: 'checkbox',
      onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
        onCheckedChange?.(event.target.checked),
    }),
}));

vi.mock('@renderer/components/ui/label', () => ({
  Label: ({
    children,
    ...props
  }: React.LabelHTMLAttributes<HTMLLabelElement> & { children: React.ReactNode }) =>
    React.createElement('label', props, children),
}));

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  TooltipProvider: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

function renderLimitContextCheckbox(
  overrides: Partial<React.ComponentProps<typeof LimitContextCheckbox>> = {}
): { host: HTMLDivElement; root: ReturnType<typeof createRoot> } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);

  act(() => {
    root.render(
      React.createElement(LimitContextCheckbox, {
        id: 'limit-context',
        checked: false,
        onCheckedChange: () => undefined,
        ...overrides,
      })
    );
  });

  return { host, root };
}

describe('LimitContextCheckbox', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders disabled always-200K state as checked and disabled', () => {
    const { host, root } = renderLimitContextCheckbox({ checked: false, disabled: true });

    const checkbox = host.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(true);
    expect(host.textContent).toContain('always 200K for this model');

    act(() => {
      root.unmount();
    });
  });

  it('preserves the real checked state when enabled', () => {
    const { host, root } = renderLimitContextCheckbox({ checked: false, disabled: false });

    const checkbox = host.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(false);

    act(() => {
      root.unmount();
    });
  });
});
