import { describe, expect, it } from 'vitest';

import {
  type ModelResponseInFlightEntry,
  RuntimeProviderModelRequestTracker,
} from './runtimeProviderModelRequestTracker';

function createEntry(): ModelResponseInFlightEntry {
  return {
    controller: new AbortController(),
    hasUngroupedSubscriber: false,
    requestGroups: new Set(),
    promise: Promise.resolve({ schemaVersion: 1, runtimeId: 'opencode' }),
  };
}

describe('RuntimeProviderModelRequestTracker', () => {
  it('keeps detached cancellation ownership separate from a new same-key request', () => {
    const tracker = new RuntimeProviderModelRequestTracker();
    const oldEntry = createEntry();
    tracker.set('same-key', oldEntry);
    tracker.register(oldEntry, 'same-key', 'old-subscriber');

    tracker.clear(false);

    expect(tracker.get('same-key')).toBeUndefined();
    expect(oldEntry.controller.signal.aborted).toBe(false);

    const newEntry = createEntry();
    tracker.set('same-key', newEntry);
    tracker.register(newEntry, 'same-key', 'new-subscriber');

    tracker.cancel('old-subscriber');
    expect(oldEntry.controller.signal.aborted).toBe(true);
    expect(newEntry.controller.signal.aborted).toBe(false);

    tracker.cancel('new-subscriber');
    expect(newEntry.controller.signal.aborted).toBe(true);
  });

  it('keeps new same-group ownership when the detached same-key entry completes late', () => {
    const tracker = new RuntimeProviderModelRequestTracker();
    const oldEntry = createEntry();
    tracker.set('same-key', oldEntry);
    tracker.register(oldEntry, 'same-key', 'same-group');
    tracker.clear(false);

    const newEntry = createEntry();
    tracker.set('same-key', newEntry);
    tracker.register(newEntry, 'same-key', 'same-group');
    expect(oldEntry.controller.signal.aborted).toBe(true);

    tracker.cleanup('same-key', oldEntry);
    tracker.cancel('same-group');
    expect(newEntry.controller.signal.aborted).toBe(true);
  });

  it('still aborts visible and detached entries when cleared with abort enabled', () => {
    const tracker = new RuntimeProviderModelRequestTracker();
    const detachedEntry = createEntry();
    tracker.set('detached-key', detachedEntry);
    tracker.register(detachedEntry, 'detached-key', 'detached-subscriber');
    tracker.clear(false);

    const visibleEntry = createEntry();
    tracker.set('visible-key', visibleEntry);
    tracker.register(visibleEntry, 'visible-key', 'visible-subscriber');

    tracker.clear(true);

    expect(detachedEntry.controller.signal.aborted).toBe(true);
    expect(visibleEntry.controller.signal.aborted).toBe(true);
    expect(tracker.get('visible-key')).toBeUndefined();
  });
});
