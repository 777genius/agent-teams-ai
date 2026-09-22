import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { ProcessesSection } from '@renderer/components/team/ProcessesSection';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TeamProcess } from '@shared/types';
import type { Root } from 'react-dom/client';

const storeState = {
  stopRegisteredProcess: vi.fn<(_teamName: string, _pid: number) => Promise<void>>(),
};

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

vi.mock('@renderer/components/team/MemberBadge', () => ({
  MemberBadge: ({ name }: { name: string }) => React.createElement('span', null, name),
}));

function processFixture(overrides: Partial<TeamProcess> = {}): TeamProcess {
  return {
    id: 'process-1',
    label: 'Preview server',
    pid: 4312,
    registeredAt: '2026-07-30T20:00:00.000Z',
    ...overrides,
  };
}

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe('ProcessesSection renderer application port', () => {
  let host: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.stopRegisteredProcess.mockReset().mockResolvedValue(undefined);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    root = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  async function render(processes: TeamProcess[]): Promise<void> {
    await act(async () => {
      root?.render(<ProcessesSection teamName="sandbox-team" members={[]} processes={processes} />);
      await Promise.resolve();
    });
  }

  it('stops the process selected by its row without adding confirmation or loading state', async () => {
    const confirmation = vi.fn();
    const deferred = createDeferred();
    vi.stubGlobal('confirm', confirmation);
    storeState.stopRegisteredProcess.mockReturnValueOnce(deferred.promise);
    const selected = processFixture({
      id: 'selected-process',
      label: 'Selected preview',
      pid: 4312,
      registeredAt: '2026-07-30T21:00:00.000Z',
    });
    const other = processFixture({
      id: 'other-process',
      label: 'Other preview',
      pid: 9876,
      registeredAt: '2026-07-30T20:00:00.000Z',
    });
    await render([other, selected]);

    const selectedLabel = Array.from(host.querySelectorAll('span')).find(
      (element) => element.textContent === 'Selected preview'
    );
    const selectedRow = selectedLabel?.closest('div');
    const stopButton = selectedRow?.querySelector<HTMLButtonElement>(
      'button[title="processes.stopProcess"]'
    );
    expect(stopButton?.disabled).toBe(false);

    await act(async () => {
      stopButton?.click();
      await Promise.resolve();
    });

    expect(storeState.stopRegisteredProcess).toHaveBeenCalledTimes(1);
    expect(storeState.stopRegisteredProcess).toHaveBeenCalledWith('sandbox-team', 4312);
    expect(confirmation).not.toHaveBeenCalled();
    expect(stopButton?.disabled).toBe(false);

    deferred.resolve();
    await act(async () => {
      await deferred.promise;
    });
  });

  it('does not offer the stop action for an already stopped process', async () => {
    await render([
      processFixture({
        stoppedAt: '2026-07-30T21:30:00.000Z',
      }),
    ]);

    expect(host.querySelector('button[title="processes.stopProcess"]')).toBeNull();
    expect(storeState.stopRegisteredProcess).not.toHaveBeenCalled();
  });
});
