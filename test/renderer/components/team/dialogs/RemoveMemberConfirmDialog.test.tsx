import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

import { RemoveMemberConfirmDialog } from '@renderer/components/team/dialogs/RemoveMemberConfirmDialog';

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label
  );
  if (!found) throw new Error('No button ' + label);
  return found as HTMLButtonElement;
}

describe('RemoveMemberConfirmDialog', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('cannot be cancelled while the removal is pending, so a late success cannot close the card of a member the user walked away from', async () => {
    let finish!: () => void;
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const onCancel = vi.fn();
    await act(async () => {
      root.render(<RemoveMemberConfirmDialog memberName="bob" onCancel={onCancel} onConfirm={onConfirm} />);
    });
    await act(async () => button('detail.actions.remove').click());
    expect(onConfirm).toHaveBeenCalledWith('bob');
    expect(button('detail.actions.cancel').disabled).toBe(true);
    expect(button('detail.actions.remove').disabled).toBe(true);
    await act(async () => button('detail.actions.cancel').click());
    expect(onCancel).not.toHaveBeenCalled();
    await act(async () => finish());
  });

  it('shows the refusal and lets the user cancel again when the removal fails', async () => {
    const onCancel = vi.fn();
    await act(async () => {
      root.render(
        <RemoveMemberConfirmDialog
          memberName="bob"
          onCancel={onCancel}
          onConfirm={async () => {
            throw new Error('Stop it in every project');
          }}
        />
      );
    });
    await act(async () => button('detail.actions.remove').click());
    expect(document.body.textContent).toContain('Stop it in every project');
    expect(button('detail.actions.cancel').disabled).toBe(false);
    await act(async () => button('detail.actions.cancel').click());
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
