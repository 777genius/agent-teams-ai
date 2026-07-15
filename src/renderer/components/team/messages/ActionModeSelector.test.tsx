/* eslint-disable @typescript-eslint/naming-convention -- mocked component exports mirror the production API. */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('span', null, children),
  TooltipProvider: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

import { ActionModeSelector } from './ActionModeSelector';

describe('ActionModeSelector', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('keeps radio semantics in the flat segmented layout', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onChange = vi.fn();

    act(() => {
      root.render(<ActionModeSelector value="delegate" onChange={onChange} showDelegate />);
    });

    const group = host.querySelector('[role="radiogroup"]');
    const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    const delegateButton = buttons.find((button) => button.textContent === 'Delegate');
    const askButton = buttons.find((button) => button.textContent === 'Ask');

    expect(group?.className).toContain('message-composer-action-modes');
    expect(group?.className).not.toContain('rounded-full');
    expect(buttons).toHaveLength(3);
    expect(delegateButton?.getAttribute('aria-checked')).toBe('true');
    expect(delegateButton?.className).toContain('after:opacity-100');

    act(() => {
      askButton?.click();
    });
    expect(onChange).toHaveBeenCalledWith('ask');

    act(() => {
      root.unmount();
    });
  });

  it('hides delegate when unavailable and disables every visible mode', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    act(() => {
      root.render(
        <ActionModeSelector value="do" onChange={vi.fn()} showDelegate={false} disabled />
      );
    });

    const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    expect(buttons.map((button) => button.textContent)).toEqual(['Do', 'Ask']);
    expect(buttons.every((button) => button.disabled)).toBe(true);

    act(() => {
      root.unmount();
    });
  });
});
