import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { Dialog, DialogContent, DialogTitle } from '../../../../src/renderer/components/ui/dialog';

describe('retained provider dialog portal', () => {
  const roots: Array<ReturnType<typeof createRoot>> = [];

  afterEach(async () => {
    await act(async () => {
      for (const root of roots) root.unmount();
    });
    roots.length = 0;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('hides and releases a portal without unmounting its form', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const background = document.createElement('button');
    background.textContent = 'other tab';
    document.body.appendChild(background);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    const onOpenChange = vi.fn();

    function Form(): React.JSX.Element {
      const [value, setValue] = useState(0);
      return (
        <button data-testid="retained-dialog-state" onClick={() => setValue((n) => n + 1)}>
          {value}
        </button>
      );
    }
    function TestDialog({ visible }: { visible: boolean }): React.JSX.Element {
      return (
        <Dialog open modal={false} onOpenChange={onOpenChange}>
          <DialogContent portalHidden={!visible} nonModalBackdrop>
            <DialogTitle>Provider credentials</DialogTitle>
            <Form />
          </DialogContent>
        </Dialog>
      );
    }

    await act(async () => root.render(<TestDialog visible />));
    const counter = document.querySelector('[data-testid="retained-dialog-state"]') as HTMLButtonElement;
    expect(counter).not.toBeNull();
    await act(async () => counter.click());
    expect(counter.textContent).toBe('1');

    await act(async () => root.render(<TestDialog visible={false} />));
    expect(counter.textContent).toBe('1');
    expect(counter.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(counter.closest('[inert]')).not.toBeNull();
    expect(background.getAttribute('aria-hidden')).toBeNull();

    await act(async () => root.render(<TestDialog visible />));
    expect(document.querySelector('[data-testid="retained-dialog-state"]')).toBe(counter);
    expect(counter.textContent).toBe('1');
    expect(counter.closest('[aria-hidden="true"]')).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
