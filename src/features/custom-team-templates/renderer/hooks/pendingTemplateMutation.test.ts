import { afterEach, describe, expect, it, vi } from 'vitest';

const prefix = 'agent-teams:custom-template-pending-mutation:';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(prefix) || key.startsWith('agent-teams:custom-template-mutation-decision:'))
      localStorage.removeItem(key);
  }
  vi.resetModules();
});

describe('pending template mutations', () => {
  it('records before dispatch and recovers the marker in a fresh renderer module', async () => {
    const first = await import('./pendingTemplateMutation');
    const operation = first.beginTemplateMutation({ kind: 'save', label: 'Team A' });
    expect(operation).not.toBeNull();
    expect(localStorage.getItem(prefix + operation!.id)).not.toBeNull();

    vi.resetModules();
    const restarted = await import('./pendingTemplateMutation');
    expect(restarted.getPendingTemplateMutations()).toEqual([operation]);
    expect(restarted.beginTemplateMutation({ kind: 'delete', label: 'Team A' })).toBeNull();
  });

  it('retains separate concurrent markers received from another window', async () => {
    const store = await import('./pendingTemplateMutation');
    const first = store.beginTemplateMutation({ kind: 'duplicate', label: 'One' });
    localStorage.setItem(prefix + 'other-window', JSON.stringify({ kind: 'delete', label: 'Two' }));
    window.dispatchEvent(new StorageEvent('storage', { key: prefix + 'other-window' }));
    expect(store.getPendingTemplateMutations().map(({ label }) => label)).toEqual(['One', 'Two']);
    store.finishTemplateMutation(first!);
    expect(store.getPendingTemplateMutations().map(({ label }) => label)).toEqual(['Two']);
  });

  it('retains an explicit decision across module restart without deleting a newer marker', async () => {
    const store = await import('./pendingTemplateMutation');
    const first = store.beginTemplateMutation({ kind: 'save', label: 'Original' })!;
    expect(store.resolveTemplateMutation(first)).toBe(true);
    const next = store.beginTemplateMutation({ kind: 'edit', label: 'Newer' })!;
    vi.resetModules();
    const restarted = await import('./pendingTemplateMutation');
    expect(restarted.wasTemplateMutationResolved(first)).toBe(true);
    expect(restarted.wasTemplateMutationResolved({ ...first, kind: 'edit' })).toBe(false);
    expect(restarted.getPendingTemplateMutations()).toEqual([next]);
  });

  it('does not re-ask after a crash between recording a decision and removing its marker', async () => {
    const store = await import('./pendingTemplateMutation');
    const old = store.beginTemplateMutation({ kind: 'save', label: 'Original' })!;
    localStorage.setItem(`agent-teams:custom-template-mutation-decision:${old.id}`, old.kind);
    localStorage.setItem(prefix + 'new-marker', JSON.stringify({ kind: 'edit', label: 'New' }));
    vi.resetModules();
    const restarted = await import('./pendingTemplateMutation');
    expect(restarted.wasTemplateMutationResolved(old)).toBe(true);
    expect(restarted.getPendingTemplateMutations().map((item) => item.id)).toEqual(['new-marker']);
    expect(localStorage.getItem(prefix + old.id)).not.toBeNull();
  });

  it('does not hide a marker when the stored receipt has a different operation kind', async () => {
    const store = await import('./pendingTemplateMutation');
    const old = store.beginTemplateMutation({ kind: 'save', label: 'Original' })!;
    localStorage.setItem(`agent-teams:custom-template-mutation-decision:${old.id}`, 'edit');
    expect(store.wasTemplateMutationResolved(old)).toBe(false);
    expect(store.getPendingTemplateMutations()).toEqual([old]);
  });

  it('keeps the marker if the decision receipt cannot be stored', async () => {
    const store = await import('./pendingTemplateMutation');
    const operation = store.beginTemplateMutation({ kind: 'save', label: 'Original' })!;
    const realStorage = localStorage;
    vi.stubGlobal('localStorage', {
      get length() {
        return realStorage.length;
      },
      key: realStorage.key.bind(realStorage),
      getItem: realStorage.getItem.bind(realStorage),
      removeItem: realStorage.removeItem.bind(realStorage),
      setItem: (key: string, value: string) => {
        if (key.startsWith('agent-teams:custom-template-mutation-decision:'))
          throw new Error('storage denied');
        realStorage.setItem(key, value);
      },
    });
    expect(store.resolveTemplateMutation(operation)).toBe(false);
    expect(realStorage.getItem(prefix + operation.id)).not.toBeNull();
    expect(store.wasTemplateMutationResolved(operation)).toBe(false);
  });

  it('refuses to start when the recovery marker cannot be written', async () => {
    const store = await import('./pendingTemplateMutation');
    const realStorage = localStorage;
    vi.stubGlobal('localStorage', {
      get length() {
        return realStorage.length;
      },
      key: realStorage.key.bind(realStorage),
      getItem: realStorage.getItem.bind(realStorage),
      removeItem: realStorage.removeItem.bind(realStorage),
      setItem: () => {
        throw new Error('storage denied');
      },
    });
    expect(store.beginTemplateMutation({ kind: 'save', label: 'Team A' })).toBeNull();
    expect(store.getPendingTemplateMutations()).toEqual([]);
  });
});
