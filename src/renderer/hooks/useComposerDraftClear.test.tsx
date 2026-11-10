import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emptyContent, type LocalDraftState } from './composerDraftLocal';
import { useComposerDraftClear } from './useComposerDraftClear';

import type {
  ComposerDraftAddress,
  ComposerDraftRepository,
  ComposerPersistenceStatus,
} from '@renderer/types/composerDraft';

const alice: ComposerDraftAddress = {
  contextId: 'test-context',
  teamName: 'test-team',
  target: { kind: 'direct', participant: 'alice' },
};
const bob: ComposerDraftAddress = {
  contextId: 'test-context',
  teamName: 'test-team',
  target: { kind: 'direct', participant: 'bob' },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function state(addressKey: string, text: string): LocalDraftState {
  return { addressKey, content: { ...emptyContent(), text }, editorContext: { kind: 'plain' } };
}

function setup(flush: () => Promise<void>, saveWorking: ComposerDraftRepository['saveWorking']) {
  const addressRef = { current: alice };
  const addressKeyRef = { current: 'alice' };
  const localEditCounterRef = { current: 1 };
  const latestEditByAddressRef = {
    current: new Map([
      ['alice', 1],
      ['bob', 2],
    ]),
  };
  const savedEditByAddressRef = { current: new Map([['bob', 2]]) };
  const stateRef = { current: state('alice', 'sent message') };
  const workingRevisionRef = { current: 'alice-revision' };
  const revisionByAddressRef = {
    current: new Map([
      ['alice', 'alice-revision'],
      ['bob', 'bob-revision'],
    ]),
  };
  const setState = vi.fn((next: LocalDraftState) => {
    stateRef.current = next;
  });
  const setPersistenceStatus = vi.fn<(status: ComposerPersistenceStatus) => void>();
  const setIsSaved = vi.fn<(saved: boolean) => void>();
  const repository = { saveWorking } as ComposerDraftRepository;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const clearDraftRef = { current: null as (() => Promise<void>) | null };
  const Harness = (): null => {
    const clearDraft = useComposerDraftClear({
      repository,
      flush,
      addressRef,
      addressKeyRef,
      localEditCounterRef,
      latestEditByAddressRef,
      savedEditByAddressRef,
      stateRef,
      workingRevisionRef,
      revisionByAddressRef,
      setState,
      setPersistenceStatus,
      setIsSaved,
    });
    useEffect(() => {
      clearDraftRef.current = clearDraft;
    }, [clearDraft]);
    return null;
  };
  act(() => root.render(<Harness />));
  return {
    clearDraft: () => clearDraftRef.current!(),
    root,
    addressRef,
    addressKeyRef,
    localEditCounterRef,
    latestEditByAddressRef,
    savedEditByAddressRef,
    stateRef,
    workingRevisionRef,
    revisionByAddressRef,
    setState,
    setPersistenceStatus,
    setIsSaved,
  };
}

describe('useComposerDraftClear', () => {
  beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not clear a different chat after flush resolves', async () => {
    const pendingFlush = deferred<void>();
    const saveWorking = vi.fn<ComposerDraftRepository['saveWorking']>(
      async (_address, _expected, revision) => ({
        kind: 'saved',
        workingRevision: revision,
        status: 'durable',
      })
    );
    const draft = setup(() => pendingFlush.promise, saveWorking);
    const clearing = draft.clearDraft();
    draft.addressRef.current = bob;
    draft.addressKeyRef.current = 'bob';
    draft.stateRef.current = state('bob', 'keep this draft');
    draft.workingRevisionRef.current = 'bob-revision';

    await act(async () => pendingFlush.resolve());
    await clearing;

    expect(saveWorking).not.toHaveBeenCalled();
    expect(draft.stateRef.current.content.text).toBe('keep this draft');
    expect(draft.revisionByAddressRef.current.get('bob')).toBe('bob-revision');
    act(() => draft.root.unmount());
  });

  it('does not erase text typed while flush is pending', async () => {
    const pendingFlush = deferred<void>();
    const saveWorking = vi.fn<ComposerDraftRepository['saveWorking']>();
    const draft = setup(() => pendingFlush.promise, saveWorking);
    const clearing = draft.clearDraft();
    draft.localEditCounterRef.current += 1;
    draft.latestEditByAddressRef.current.set('alice', draft.localEditCounterRef.current);
    draft.stateRef.current = state('alice', 'new text');

    await act(async () => pendingFlush.resolve());
    await clearing;

    expect(saveWorking).not.toHaveBeenCalled();
    expect(draft.stateRef.current.content.text).toBe('new text');
    act(() => draft.root.unmount());
  });

  it('does not use the previous chat revision before the current chat hydrates', async () => {
    const saveWorking = vi.fn<ComposerDraftRepository['saveWorking']>(
      async (_address, _expected, revision) => ({
        kind: 'saved',
        workingRevision: revision,
        status: 'durable',
      })
    );
    const draft = setup(async () => undefined, saveWorking);
    draft.revisionByAddressRef.current.delete('alice');
    draft.workingRevisionRef.current = 'previous-chat-revision';

    await act(async () => draft.clearDraft());

    expect(saveWorking).toHaveBeenCalledWith(alice, '0', expect.any(String), null, {
      kind: 'plain',
    });
    act(() => draft.root.unmount());
  });

  it('keeps a newer edit unsaved and attributes the completed clear to its original chat', async () => {
    const pendingSave = deferred<Awaited<ReturnType<ComposerDraftRepository['saveWorking']>>>();
    const saveWorking = vi.fn<ComposerDraftRepository['saveWorking']>(() => pendingSave.promise);
    const draft = setup(async () => undefined, saveWorking);
    const clearing = draft.clearDraft();
    await act(async () => Promise.resolve());
    expect(saveWorking).toHaveBeenCalledWith(alice, 'alice-revision', expect.any(String), null, {
      kind: 'plain',
    });
    const clearCounter = draft.localEditCounterRef.current;
    draft.localEditCounterRef.current += 1;
    draft.latestEditByAddressRef.current.set('alice', draft.localEditCounterRef.current);
    draft.stateRef.current = state('alice', 'newer edit');
    draft.addressRef.current = bob;
    draft.addressKeyRef.current = 'bob';
    draft.workingRevisionRef.current = 'bob-revision';

    const clearRevision = saveWorking.mock.calls[0][2];
    await act(async () =>
      pendingSave.resolve({
        kind: 'saved',
        workingRevision: clearRevision,
        status: 'memory-only',
      })
    );
    await clearing;

    expect(draft.revisionByAddressRef.current.get('alice')).toBe(clearRevision);
    expect(draft.revisionByAddressRef.current.get('bob')).toBe('bob-revision');
    expect(draft.workingRevisionRef.current).toBe('bob-revision');
    expect(draft.savedEditByAddressRef.current.get('alice')).not.toBe(clearCounter);
    expect(draft.savedEditByAddressRef.current.get('bob')).toBe(2);
    expect(draft.stateRef.current.content.text).toBe('newer edit');
    expect(draft.setPersistenceStatus).not.toHaveBeenCalledWith('memory-only');
    act(() => draft.root.unmount());
  });
});
