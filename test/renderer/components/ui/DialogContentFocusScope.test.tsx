import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';

describe('Radix ref lifecycle integration', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = vi.fn();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    document.body.innerHTML = '';
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
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

  it('keeps the Radix select and popper refs stable while an open select rerenders', () => {
    const renderSelect = (label: string): void => {
      root.render(
        <Select open value="codex">
          <SelectTrigger>
            <SelectValue placeholder="Provider" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="claude">Claude {label}</SelectItem>
            <SelectItem value="codex">Codex {label}</SelectItem>
          </SelectContent>
        </Select>
      );
    };

    expect(() => {
      act(() => {
        renderSelect('initial');
      });
      act(() => {
        renderSelect('updated');
      });
    }).not.toThrow();

    expect(document.body.textContent).toContain('Codex updated');
  });
});
