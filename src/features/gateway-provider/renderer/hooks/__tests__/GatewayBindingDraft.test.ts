import { describe, expect, it, vi } from 'vitest';

import { createGatewayBindingDraft } from '../GatewayBindingDraft';

import type { GatewayMemberBindingDto } from '../../../contracts';

const binding = (memberName = 'new', teamName = 'team'): GatewayMemberBindingDto => ({
  teamName,
  memberName,
  profileId: 'profile',
  profileDisplayName: 'Gateway',
  gatewayUsageRef: 'usage-' + memberName,
  boundAt: '2026-10-20T00:00:00.000Z',
  credentialStatus: 'ready',
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function setup(
  names = ['new'],
  existing: GatewayMemberBindingDto[] = [],
  mode: 'roster' | 'addition' = 'roster'
) {
  const unbind = vi.fn(async (): Promise<void> => undefined);
  const report = vi.fn();
  const draft = createGatewayBindingDraft(unbind, report);
  draft.update({ teamName: 'team', memberNames: names, mode });
  draft.observe('team', existing);
  return { draft, unbind, report };
}

describe('gateway binding draft ownership', () => {
  it.each(['cancel', 'rename-member', 'rename-team'])(
    'discards only the new exact receipt on %s',
    async (action) => {
      const old = binding('existing');
      const { draft, unbind } = setup(['new', 'existing'], [old]);
      const receipt = await draft.runBinding(async () => binding());
      draft.register(old);
      if (action === 'cancel') draft.discard();
      else
        draft.update({
          teamName: action === 'rename-team' ? 'renamed' : 'team',
          memberNames: ['renamed', 'existing'],
          mode: 'roster',
        });
      await vi.waitFor(() =>
        expect(unbind).toHaveBeenCalledExactlyOnceWith({
          teamName: 'team',
          memberName: 'new',
          expectedBinding: { gatewayUsageRef: receipt.gatewayUsageRef, boundAt: receipt.boundAt },
        })
      );
    }
  );

  it('keeps bound members when their saved roster removes another existing member', async () => {
    const removed = binding('removed');
    const { draft, unbind } = setup(['new'], [removed]);
    await draft.runBinding(async () => binding());
    await draft.run(async () => undefined);
    draft.discard();
    await vi.waitFor(() =>
      expect(unbind).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ memberName: 'removed' })
      )
    );
  });

  it('preserves pre-existing bindings if editing the roster is cancelled', async () => {
    const { draft, unbind } = setup([], [binding('existing')]);
    draft.discard();
    await Promise.resolve();
    expect(unbind).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'waits for an in-flight save after close (success=%s)',
    async (success) => {
      const { draft, unbind } = setup();
      await draft.runBinding(async () => binding());
      const gate = deferred<void>();
      const save = draft.run(() => gate.promise);
      const result = save.catch((error) => error);
      draft.discard();
      await Promise.resolve();
      expect(unbind).not.toHaveBeenCalled();
      if (success) gate.resolve();
      else gate.reject(new Error('save failed'));
      await result;
      expect(unbind).toHaveBeenCalledTimes(success ? 0 : 1);
    }
  );

  it('discards a late binding response when the form has already closed', async () => {
    const { draft, unbind } = setup();
    const gate = deferred<GatewayMemberBindingDto>();
    const pending = draft.runBinding(() => gate.promise);
    draft.discard();
    expect(unbind).not.toHaveBeenCalled();
    gate.resolve(binding());
    await pending;
    expect(unbind).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ memberName: 'new' }));
  });

  it('keeps individually added members after a later addition fails', async () => {
    const { draft, unbind } = setup(['first', 'second'], [], 'addition');
    await draft.runBinding(async () => binding('first'));
    await draft.runBinding(async () => binding('second'));
    await expect(
      draft.run(async () => {
        draft.markSaved('team', ['first']);
        throw new Error('second failed');
      }, [])
    ).rejects.toThrow('second failed');
    draft.discard();
    await vi.waitFor(() =>
      expect(unbind).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ memberName: 'second' })
      )
    );
  });

  it('commits a persisted roster even if its subsequent launch fails', async () => {
    const { draft, unbind } = setup(['new'], [binding('removed')]);
    await draft.runBinding(async () => binding());
    await expect(
      draft.run(async () => {
        draft.markSaved('team', ['new'], true);
        draft.discard();
        throw new Error('launch failed');
      }, [])
    ).rejects.toThrow('launch failed');
    expect(unbind).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ memberName: 'removed' })
    );
  });

  it('reports failed cleanup without hiding a save error and retries only its own receipt', async () => {
    const { draft, unbind, report } = setup();
    await draft.runBinding(async () => binding());
    unbind.mockRejectedValueOnce(new Error('cleanup failed'));
    await expect(
      draft.run(async () => {
        draft.discard();
        throw new Error('save failed');
      })
    ).rejects.toThrow('save failed');
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: 'cleanup failed' }));
    draft.discard();
    await vi.waitFor(() => expect(unbind).toHaveBeenCalledTimes(2));
  });
});

it('cleans a replacement receipt when an older cleanup for the same member is still pending', async () => {
  const { draft, unbind } = setup();
  const oldCleanup = deferred<void>();
  const newBinding = deferred<GatewayMemberBindingDto>();
  await draft.runBinding(async () => binding());
  unbind.mockImplementationOnce(() => oldCleanup.promise);
  draft.update({ teamName: 'team', memberNames: [], mode: 'roster' });
  await vi.waitFor(() => expect(unbind).toHaveBeenCalledTimes(1));
  draft.update({ teamName: 'team', memberNames: ['new'], mode: 'roster' });
  const pending = draft.runBinding(() => newBinding.promise);
  draft.discard();
  const replacement = { ...binding(), boundAt: '2026-10-20T00:00:01.000Z' };
  newBinding.resolve(replacement);
  try {
    await vi.waitFor(() => expect(unbind).toHaveBeenCalledTimes(2));
    expect(unbind).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expectedBinding: {
          gatewayUsageRef: replacement.gatewayUsageRef,
          boundAt: replacement.boundAt,
        },
      })
    );
  } finally {
    oldCleanup.resolve();
    await pending;
  }
});

it('discards a cancelled late binding even if the same dialog was reopened for the same owner', async () => {
  const { draft, unbind } = setup();
  const gate = deferred<GatewayMemberBindingDto>();
  const pending = draft.runBinding(() => gate.promise);
  draft.discard();
  draft.update({ teamName: 'team', memberNames: ['new'], mode: 'roster' });
  draft.observe('team', []);
  gate.resolve(binding());
  await pending;
  expect(unbind).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ memberName: 'new' }));
});
