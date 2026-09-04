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
  let root: ReturnType<typeof createRoot>;
  let control!: TeamStopControl;

  beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    root = createRoot(host);
    mocks.processAlive.mockResolvedValue(false);
    await act(async () => root.render(<Harness capture={(value) => (control = value)} />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('suppresses a same-tick duplicate and records one outcome', async () => {
    let resolveStop!: () => void;
    mocks.stop.mockImplementation(() => new Promise<void>((resolve) => (resolveStop = resolve)));
    const onOutcome = vi.fn();
    const options = { refresh: vi.fn().mockResolvedValue(undefined), onOutcome };

    let first!: Promise<unknown>;
    let duplicate!: Promise<unknown>;
    await act(async () => {
      first = control.stopTeam('demo-team', options);
      duplicate = control.stopTeam('demo-team', options);
      await Promise.resolve();
    });
    await expect(duplicate).resolves.toBeNull();
    expect(mocks.stop).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveStop();
      await first;
    });
    expect(onOutcome).toHaveBeenCalledTimes(1);
  });

  it('allows one explicit manual retry after the previous request settles', async () => {
    mocks.stop.mockRejectedValue(new Error('failed'));
    mocks.processAlive.mockResolvedValue(true);
    const onOutcome = vi.fn();
    const options = { refresh: vi.fn().mockResolvedValue(undefined), onOutcome };

    await act(async () => void (await control.stopTeam('demo-team', options)));
    await act(async () => void (await control.stopTeam('demo-team', options)));

    expect(mocks.stop).toHaveBeenCalledTimes(2);
    expect(onOutcome).toHaveBeenCalledTimes(2);
    expect(mocks.confirm).toHaveBeenCalledTimes(2);
  });
});
