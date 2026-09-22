/* eslint-disable @typescript-eslint/naming-convention -- Component mocks mirror PascalCase exports. */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  globalTaskDetail: null as null | { teamName: string; taskId: string },
  dialogModuleLoads: 0,
  dialogRenders: 0,
}));

vi.mock('@renderer/store', () => ({
  useStore: <T,>(selector: (state: typeof mockState) => T): T => selector(mockState),
}));

vi.mock('../team/dialogs/GlobalTaskDetailDialog', () => {
  mockState.dialogModuleLoads += 1;
  return {
    GlobalTaskDetailDialog: () => {
      mockState.dialogRenders += 1;
      return React.createElement('div', { 'data-testid': 'global-task-dialog' }, 'Task dialog');
    },
  };
});

/* eslint-enable @typescript-eslint/naming-convention -- Re-enable after component mocks. */

import { GlobalTaskDetailDialogSlot } from './GlobalTaskDetailDialogSlot';

const roots: Root[] = [];

const flushReact = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
};

const createHarness = (): { host: HTMLDivElement; root: Root } => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  return { host, root };
};

const renderSlot = async (root: Root): Promise<void> => {
  await act(async () => {
    root.render(<GlobalTaskDetailDialogSlot />);
    await flushReact();
  });
};

const waitForDialog = async (host: HTMLElement): Promise<void> => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (host.querySelector('[data-testid="global-task-dialog"]')) {
      return;
    }

    await act(async () => {
      await flushReact();
    });
  }

  expect(host.querySelector('[data-testid="global-task-dialog"]')).not.toBeNull();
};

describe('GlobalTaskDetailDialogSlot', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mockState.globalTaskDetail = null;
    mockState.dialogModuleLoads = 0;
    mockState.dialogRenders = 0;
  });

  afterEach(async () => {
    await act(async () => {
      for (const root of roots.splice(0)) {
        root.unmount();
      }
      await flushReact();
    });
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('does not import the heavy task dialog until a global task is opened', async () => {
    const { host, root } = createHarness();

    await renderSlot(root);

    expect(host.querySelector('[data-testid="global-task-dialog"]')).toBeNull();
    expect(mockState.dialogModuleLoads).toBe(0);
    expect(mockState.dialogRenders).toBe(0);

    mockState.globalTaskDetail = { teamName: 'team-a', taskId: 'task-1' };
    await renderSlot(root);
    await waitForDialog(host);

    expect(mockState.dialogModuleLoads).toBe(1);
    expect(mockState.dialogRenders).toBeGreaterThan(0);
  });
});
