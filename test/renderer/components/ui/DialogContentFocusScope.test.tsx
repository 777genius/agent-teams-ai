import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog';

describe('DialogContent FocusScope integration', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('keeps the Radix focus scope stable while an open dialog rerenders', () => {
    const renderDialog = (label: string): void => {
      root.render(
        <Dialog open>
          <DialogContent>
            <DialogTitle>{label}</DialogTitle>
            <DialogDescription>Provider model settings</DialogDescription>
            <button type="button">Focusable action</button>
          </DialogContent>
        </Dialog>
      );
    };

    expect(() => {
      act(() => {
        renderDialog('Create team');
      });
      act(() => {
        renderDialog('Create team updated');
      });
    }).not.toThrow();

    expect(document.body.textContent).toContain('Create team updated');
  });
});
