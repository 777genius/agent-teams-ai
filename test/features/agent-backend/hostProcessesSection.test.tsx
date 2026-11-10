import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, expect, it, vi } from 'vitest';

import { ProcessesSection } from '../../../src/renderer/components/team/ProcessesSection';
import { TooltipProvider } from '../../../src/renderer/components/ui/tooltip';
const spies = vi.hoisted(() => ({
  stop: vi.fn(async () => {}),
  legacy: vi.fn(() => {
    throw Error('Legacy PID API bypass');
  }),
}));
vi.mock('@renderer/api', () => ({ api: { teams: { killProcess: spies.stop } } }));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../../src/renderer/components/team/MemberBadge', () => ({ MemberBadge: () => null }));
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const action of cleanups.splice(0)) action();
  spies.stop.mockClear();
  spies.legacy.mockClear();
});
it('existing control uses displayed original opaque row, survives same-PID memo changes and recovers pending original lookup', async () => {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { teams: { killProcess: spies.legacy } },
  });
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  const ref = 'p1:TEST-process:' + 'a'.repeat(64),
    newRef = 'p1:TEST-process:' + 'b'.repeat(64);
  const row = {
    id: 'TEST-process',
    pid: 1001,
    label: 'TEST service',
    registeredAt: '2026-10-23',
    processRef: ref,
    observation: 'same-live' as const,
    canTerminate: true,
  };
  await act(async () =>
    root.render(
      <TooltipProvider>
        <ProcessesSection
          teamName="host-team:TEST-original"
          members={[]}
          processes={[row]}
          isTeamAlive={false}
        />
      </TooltipProvider>
    )
  );
  const click = async () => {
    const button = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('processes.kill')
    );
    expect(button).toBeDefined();
    await act(async () => button!.click());
  };
  await click();
  expect(spies.stop).toHaveBeenLastCalledWith('host-team:TEST-original', 1001, { processRef: ref });
  await act(async () =>
    root.render(
      <TooltipProvider>
        <ProcessesSection
          teamName="host-team:TEST-original"
          members={[]}
          processes={[
            {
              ...row,
              processRef: newRef,
              canTerminate: false,
              pendingStop: {
                commandId: 'TEST-stop-original',
                originalProcessRef: ref,
                native: 'unknown',
              },
            },
          ]}
          isTeamAlive={false}
        />
      </TooltipProvider>
    )
  );
  await click();
  expect(spies.stop).toHaveBeenLastCalledWith('host-team:TEST-original', 1001, {
    processRef: ref,
    originalCommandId: 'TEST-stop-original',
  });
  expect(spies.legacy).not.toHaveBeenCalled();
});
