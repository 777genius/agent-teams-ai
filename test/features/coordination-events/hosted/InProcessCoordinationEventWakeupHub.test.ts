import { InProcessCoordinationEventWakeupHub } from '@features/coordination-events/main/infrastructure/InProcessCoordinationEventWakeupHub';
import { describe, expect, it, vi } from 'vitest';

import type { CoordinationEventEnvelope } from '@features/coordination-events/contracts';

const COMMITTED_EVENT = Object.freeze({}) as CoordinationEventEnvelope;

describe('InProcessCoordinationEventWakeupHub', () => {
  it('coalesces notifications in one microtask while durable callers all settle', async () => {
    const hub = new InProcessCoordinationEventWakeupHub();
    const listener = vi.fn();
    hub.subscribe(listener);

    const first = hub.notifyCommittedEvent(COMMITTED_EVENT);
    const second = hub.notifyCommittedEvent(COMMITTED_EVENT);

    expect(listener).not.toHaveBeenCalled();
    await Promise.all([first, second]);
    expect(listener).toHaveBeenCalledTimes(1);

    await hub.notifyCommittedEvent(COMMITTED_EVENT);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('isolates listener failures and supports idempotent unsubscribe', async () => {
    const hub = new InProcessCoordinationEventWakeupHub();
    const failing = vi.fn(() => {
      throw new Error('listener failed');
    });
    const healthy = vi.fn();
    const unsubscribe = hub.subscribe(failing);
    hub.subscribe(healthy);

    await expect(hub.notifyCommittedEvent(COMMITTED_EVENT)).resolves.toBeUndefined();
    expect(failing).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(1);

    unsubscribe();
    unsubscribe();
    await hub.notifyCommittedEvent(COMMITTED_EVENT);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(2);
  });

  it('closes idempotently and never accepts or flushes later notifications', async () => {
    const hub = new InProcessCoordinationEventWakeupHub();
    const listener = vi.fn();
    hub.subscribe(listener);

    hub.close();
    hub.close();
    const unsubscribeAfterClose = hub.subscribe(listener);
    unsubscribeAfterClose();
    await hub.notifyCommittedEvent(COMMITTED_EVENT);

    expect(listener).not.toHaveBeenCalled();
  });
});
