import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TeamStopControl } from '@renderer/components/team/useTeamStopControl';

const mocks = vi.hoisted(() => ({
  stop: vi.fn(),
  processAlive: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@renderer/api', () => ({
  api: { teams: { stop: mocks.stop, processAlive: mocks.processAlive } },
}));
vi.mock('@renderer/components/common/ConfirmDialog', () => ({ confirm: mocks.confirm }));

import { useTeamStopControl } from '@renderer/components/team/useTeamStopControl';

function Harness({ capture }: { capture(value: TeamStopControl): void }): React.JSX.Element {
  capture(useTeamStopControl());
  return <div />;
}

describe('useTeamStopControl', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | undefined;
  let controls!: Record<'first' | 'second', TeamStopControl>;

  beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    root = createRoot(host);
    controls = {} as Record<'first' | 'second', TeamStopControl>;
    mocks.processAlive.mockResolvedValue(false);
    await act(async () =>
      root?.render(
        <>
          <Harness capture={(value) => (controls.first = value)} />
          <Harness capture={(value) => (controls.second = value)} />
        </>
      )
    );
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('shares busy state and duplicate suppression between consumers while teams stay independent', async () => {
    const resolvers = new Map<string, () => void>();
    mocks.stop.mockImplementation(
      (teamName: string) =>
        new Promise<void>((resolve) => {
          resolvers.set(teamName, resolve);
        })
    );
    const firstOutcome = vi.fn();
    const duplicateOutcome = vi.fn();
    const otherOutcome = vi.fn();

    let first!: Promise<unknown>;
    let duplicate!: Promise<unknown>;
    let other!: Promise<unknown>;
    await act(async () => {
      first = controls.first.stopTeam('demo-team', {
        refresh: vi.fn().mockResolvedValue(undefined),
        onOutcome: firstOutcome,
      });
      duplicate = controls.second.stopTeam('demo-team', {
        refresh: vi.fn().mockResolvedValue(undefined),
        onOutcome: duplicateOutcome,
      });
      other = controls.second.stopTeam('other-team', {
        refresh: vi.fn().mockResolvedValue(undefined),
        onOutcome: otherOutcome,
      });
      await Promise.resolve();
    });
    await expect(duplicate).resolves.toBeNull();
    expect(mocks.stop).toHaveBeenCalledTimes(2);
    expect(controls.first.isStopping('demo-team')).toBe(true);
    expect(controls.second.isStopping('demo-team')).toBe(true);
    expect(controls.first.isStopping('other-team')).toBe(true);
    expect(duplicateOutcome).not.toHaveBeenCalled();

    await act(async () => {
      resolvers.get('other-team')?.();
      await other;
    });
    expect(controls.first.isStopping('demo-team')).toBe(true);
    expect(controls.second.isStopping('other-team')).toBe(false);
    expect(otherOutcome).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvers.get('demo-team')?.();
      await first;
    });
    expect(controls.first.isStopping('demo-team')).toBe(false);
    expect(controls.second.isStopping('demo-team')).toBe(false);
    expect(firstOutcome).toHaveBeenCalledTimes(1);
    expect(duplicateOutcome).not.toHaveBeenCalled();

    mocks.stop.mockResolvedValueOnce(undefined);
    await act(async () => {
      await controls.second.stopTeam('demo-team', {
        refresh: vi.fn().mockResolvedValue(undefined),
        onOutcome: firstOutcome,
      });
    });
    expect(mocks.stop).toHaveBeenCalledTimes(3);
    expect(firstOutcome).toHaveBeenCalledTimes(2);
  });

  it('allows one explicit manual retry after the previous request settles', async () => {
    mocks.stop.mockRejectedValue(new Error('failed'));
    mocks.processAlive.mockResolvedValue(true);
    const onOutcome = vi.fn();
    const options = { refresh: vi.fn().mockResolvedValue(undefined), onOutcome };

    await act(async () => void (await controls.first.stopTeam('demo-team', options)));
    await act(async () => void (await controls.second.stopTeam('demo-team', options)));

    expect(mocks.stop).toHaveBeenCalledTimes(2);
    expect(onOutcome).toHaveBeenCalledTimes(2);
    expect(mocks.confirm).toHaveBeenCalledTimes(2);
  });

  it('releases a pending stop safely after all consumers unmount', async () => {
    let resolveStop!: () => void;
    mocks.stop.mockImplementation(() => new Promise<void>((resolve) => (resolveStop = resolve)));

    let pending!: Promise<unknown>;
    await act(async () => {
      pending = controls.first.stopTeam('demo-team', {
        refresh: vi.fn().mockResolvedValue(undefined),
        onOutcome: vi.fn(),
      });
      await Promise.resolve();
    });
    await act(async () => root?.unmount());
    root = undefined;

    resolveStop();
    await expect(pending).resolves.toBe('stopped');
  });
});
