import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
  TooltipContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('span', null, children),
}));

import { MemberQuickActions } from './MemberQuickActions';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('MemberQuickActions', () => {
  it('stops row click propagation and invokes targeted edit', () => {
    const onRowClick = vi.fn();
    const onEditMember = vi.fn();
    act(() => {
      root.render(
        <div role="button" tabIndex={0} onClick={onRowClick} onKeyDown={vi.fn()}>
          <MemberQuickActions onEditMember={onEditMember} />
        </div>
      );
    });

    act(() => {
      host.querySelector<HTMLButtonElement>('[aria-label="toolApproval.settings"]')?.click();
    });
    expect(onEditMember).toHaveBeenCalledOnce();
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('hides edit without a callback and disables it during provisioning', () => {
    act(() => root.render(<MemberQuickActions />));
    expect(host.querySelector('[aria-label="toolApproval.settings"]')).toBeNull();

    const onEditMember = vi.fn();
    act(() => root.render(<MemberQuickActions onEditMember={onEditMember} editDisabled />));
    const edit = host.querySelector<HTMLButtonElement>(
      '[aria-label="detail.tooltips.editUnavailableProvisioning"]'
    );
    expect(edit?.disabled).toBe(true);
    act(() => edit?.click());
    expect(onEditMember).not.toHaveBeenCalled();
  });
});
