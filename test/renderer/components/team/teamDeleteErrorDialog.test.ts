import { beforeEach, describe, expect, it, vi } from 'vitest';

const confirmState = vi.hoisted(() => ({
  calls: [] as Record<string, unknown>[],
}));

vi.mock('@renderer/components/common/ConfirmDialog', () => ({
  confirm: (opts: Record<string, unknown>) => {
    confirmState.calls.push(opts);
    return Promise.resolve(true);
  },
}));

import { showTeamDeleteError } from '@renderer/components/team/teamDeleteErrorDialog';

type Translator = Parameters<typeof showTeamDeleteError>[0];

/** Echoes the key back so the assertions can tell the three keys apart. */
const translator = ((key: string) => `t(${key})`) as unknown as Translator;

describe('showTeamDeleteError', () => {
  beforeEach(() => {
    confirmState.calls.length = 0;
  });

  it('shows the failure message the main process produced, verbatim', () => {
    showTeamDeleteError(
      translator,
      new Error('Team "alpha" was not deleted: waiting for in-flight operations timed out.')
    );

    expect(confirmState.calls).toHaveLength(1);
    expect(confirmState.calls[0]).toEqual({
      title: 't(list.deleteFailed.title)',
      message: 'Team "alpha" was not deleted: waiting for in-flight operations timed out.',
      confirmLabel: 't(list.deleteFailed.confirmLabel)',
      variant: 'danger',
    });
  });

  it('keeps a concrete rename failure intact instead of generalising it', () => {
    showTeamDeleteError(translator, new Error('EPERM: operation not permitted, rename'));

    expect(confirmState.calls[0]?.message).toBe('EPERM: operation not permitted, rename');
  });

  it('falls back to the generic line only when the rejection is not an Error', () => {
    showTeamDeleteError(translator, 'not an error object');

    expect(confirmState.calls[0]?.message).toBe('t(list.deleteFailed.fallbackMessage)');
  });

  it('reports rather than rethrows, so the caller is not left with an unhandled rejection', () => {
    expect(() => showTeamDeleteError(translator, new Error('boom'))).not.toThrow();
    expect(confirmState.calls).toHaveLength(1);
  });
});
