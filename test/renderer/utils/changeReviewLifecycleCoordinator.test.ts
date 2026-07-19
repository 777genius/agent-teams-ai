import {
  deferTabMutationForActiveChangeReview,
  registerChangeReviewLifecycleOwner,
  requestChangeReviewLifecycleReservation,
  requestCloseActiveChangeReviewLifecycle,
  resetChangeReviewLifecycleCoordinatorForTests,
} from '@renderer/utils/changeReviewLifecycleCoordinator';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => resetChangeReviewLifecycleCoordinatorForTests());

describe('changeReviewLifecycleCoordinator', () => {
  it('flushes and closes the active owner before reserving another Changes session', async () => {
    const requestClose = vi.fn().mockResolvedValue(true);
    await requestChangeReviewLifecycleReservation({ hostId: 'host-a', sessionId: 'session-a' });
    expect(
      registerChangeReviewLifecycleOwner({
        hostId: 'host-a',
        sessionId: 'session-a',
        tabId: 'tab-a',
        requestClose,
      }).accepted
    ).toBe(true);

    await expect(
      requestChangeReviewLifecycleReservation({ hostId: 'host-b', sessionId: 'session-b' })
    ).resolves.toBe(true);

    expect(requestClose).toHaveBeenCalledTimes(1);
    expect(
      registerChangeReviewLifecycleOwner({
        hostId: 'host-b',
        sessionId: 'session-b',
        tabId: 'tab-b',
        requestClose: vi.fn().mockResolvedValue(true),
      }).accepted
    ).toBe(true);
  });

  it('keeps and focuses the current owner when its durable flush fails', async () => {
    const focus = vi.fn();
    await requestChangeReviewLifecycleReservation({ hostId: 'host-a', sessionId: 'session-a' });
    registerChangeReviewLifecycleOwner({
      hostId: 'host-a',
      sessionId: 'session-a',
      tabId: 'tab-a',
      requestClose: vi.fn().mockResolvedValue(false),
      focus,
    });

    await expect(
      requestChangeReviewLifecycleReservation({ hostId: 'host-b', sessionId: 'session-b' })
    ).resolves.toBe(false);

    expect(focus).toHaveBeenCalledTimes(1);
    expect(
      registerChangeReviewLifecycleOwner({
        hostId: 'host-b',
        sessionId: 'session-b',
        requestClose: vi.fn().mockResolvedValue(true),
      }).accepted
    ).toBe(false);
  });

  it('defers a matching tab mutation until the active review flushes', async () => {
    let finishClose!: (closed: boolean) => void;
    const requestClose = vi.fn(
      () => new Promise<boolean>((resolve) => {
        finishClose = resolve;
      })
    );
    const mutation = vi.fn();
    await requestChangeReviewLifecycleReservation({ hostId: 'host-a', sessionId: 'session-a' });
    registerChangeReviewLifecycleOwner({
      hostId: 'host-a',
      sessionId: 'session-a',
      tabId: 'tab-a',
      requestClose,
    });

    expect(deferTabMutationForActiveChangeReview(new Set(['tab-a']), mutation)).toBe(true);
    await Promise.resolve();
    expect(mutation).not.toHaveBeenCalled();
    finishClose(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mutation).toHaveBeenCalledTimes(1);
  });

  it('does not defer an unrelated tab mutation', async () => {
    await requestChangeReviewLifecycleReservation({ hostId: 'host-a', sessionId: 'session-a' });
    registerChangeReviewLifecycleOwner({
      hostId: 'host-a',
      sessionId: 'session-a',
      tabId: 'tab-a',
      requestClose: vi.fn().mockResolvedValue(true),
    });

    expect(deferTabMutationForActiveChangeReview(new Set(['tab-b']), vi.fn())).toBe(false);
  });

  it('flushes the active owner before an app-wide reset', async () => {
    const requestClose = vi.fn().mockResolvedValue(true);
    await requestChangeReviewLifecycleReservation({ hostId: 'host-a', sessionId: 'session-a' });
    registerChangeReviewLifecycleOwner({
      hostId: 'host-a',
      sessionId: 'session-a',
      requestClose,
    });

    await expect(requestCloseActiveChangeReviewLifecycle()).resolves.toBe(true);
    expect(requestClose).toHaveBeenCalledTimes(1);

    await requestChangeReviewLifecycleReservation({ hostId: 'host-b', sessionId: 'session-b' });
    expect(
      registerChangeReviewLifecycleOwner({
        hostId: 'host-b',
        sessionId: 'session-b',
        requestClose: vi.fn().mockResolvedValue(true),
      }).accepted
    ).toBe(true);
  });

  it('blocks an app-wide reset when the durable flush fails', async () => {
    const focus = vi.fn();
    await requestChangeReviewLifecycleReservation({ hostId: 'host-a', sessionId: 'session-a' });
    registerChangeReviewLifecycleOwner({
      hostId: 'host-a',
      sessionId: 'session-a',
      requestClose: vi.fn().mockResolvedValue(false),
      focus,
    });

    await expect(requestCloseActiveChangeReviewLifecycle()).resolves.toBe(false);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('cancels a reservation that has not mounted before an app-wide reset', async () => {
    await requestChangeReviewLifecycleReservation({ hostId: 'host-a', sessionId: 'session-a' });

    expect(requestCloseActiveChangeReviewLifecycle()).toBe(true);
    await requestChangeReviewLifecycleReservation({ hostId: 'host-b', sessionId: 'session-b' });
    expect(
      registerChangeReviewLifecycleOwner({
        hostId: 'host-a',
        sessionId: 'session-a',
        requestClose: vi.fn().mockResolvedValue(true),
      }).accepted
    ).toBe(false);
  });
});
