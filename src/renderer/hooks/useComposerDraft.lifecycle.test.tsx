import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { composerDraftAddressKey } from '@renderer/utils/composerDraftIdentity';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useComposerDraft, type UseComposerDraftResult } from './useComposerDraft';

import type {
  ComposerDraftAddress,
  ComposerDraftRepository,
  ComposerWorkingRecord,
  PreparedComposerAttempt,
  RestoreRecoveryResult,
} from '@renderer/types/composerDraft';

const alice: ComposerDraftAddress = {
  contextId: 'context-a',
  teamName: 'team-a',
  target: { kind: 'direct', participant: 'alice' },
};
const bob: ComposerDraftAddress = {
  contextId: 'context-a',
  teamName: 'team-a',
  target: { kind: 'direct', participant: 'bob' },
};

function emptyWorking(address: ComposerDraftAddress): ComposerWorkingRecord {
  return {
    version: 2,
    address,
    workingRevision: '0',
    content: null,
    editorContext: { kind: 'plain' },
    updatedAt: 1,
  };
}

type TestComposerDraftRepository = ComposerDraftRepository & {
  records: Map<string, ComposerWorkingRecord>;
  deferredLoads: Map<string, Promise<ComposerWorkingRecord>>;
  loadCalls: string[];
  saveDeferred: Promise<void> | null;
  attempts: PreparedComposerAttempt[];
  restoreCalls: { destination: ComposerDraftAddress; expectedRevision: string }[];
  restoreDeferred: Promise<RestoreRecoveryResult> | null;
  stashCalls: { address: ComposerDraftAddress; expectedRevision: string }[];
  stashDeferred: Promise<RestoreRecoveryResult> | null;
};

function createRepository(): TestComposerDraftRepository {
  const records = new Map<string, ComposerWorkingRecord>();
  const deferredLoads = new Map<string, Promise<ComposerWorkingRecord>>();
  const loadCalls: string[] = [];
  const attempts: PreparedComposerAttempt[] = [];
  const repository: TestComposerDraftRepository = {
    records,
    deferredLoads,
    loadCalls,
    saveDeferred: null,
    attempts,
    async loadWorking(address) {
      loadCalls.push(composerDraftAddressKey(address));
      const deferred = deferredLoads.get(composerDraftAddressKey(address));
      const working = deferred
        ? await deferred
        : (records.get(composerDraftAddressKey(address)) ?? emptyWorking(address));
      return { working, status: 'durable' };
    },
    async saveWorking(address, expectedRevision, nextRevision, content, editorContext) {
      if (repository.saveDeferred) await repository.saveDeferred;
      const key = composerDraftAddressKey(address);
      const current = records.get(key) ?? emptyWorking(address);
      if (current.workingRevision !== expectedRevision) {
        return {
          kind: 'conflict',
          currentWorkingRevision: current.workingRevision,
          status: 'durable',
        };
      }
      records.set(key, {
        version: 2,
        address,
        workingRevision: nextRevision,
        content,
        editorContext,
        updatedAt: Date.now(),
      });
      return { kind: 'saved', workingRevision: nextRevision, status: 'durable' };
    },
    async listWorkingSummaries() {
      return { summaries: [], status: 'durable' };
    },
    async discardWorking() {
      return 'missing';
    },
    async moveWorkingAsNew() {
      return { kind: 'missing', status: 'durable' };
    },
    async discardNamespace() {
      return 'discarded';
    },
    async beginAttempt(address, expectedRevision, attempt) {
      attempts.push(attempt);
      const key = composerDraftAddressKey(address);
      const current = records.get(key) ?? emptyWorking(address);
      const workingCleared = current.workingRevision === expectedRevision;
      if (workingCleared) {
        records.set(key, { ...emptyWorking(address), workingRevision: 'attempt-revision' });
      }
      return {
        kind: 'prepared',
        workingCleared,
        currentWorkingRevision: workingCleared ? 'attempt-revision' : current.workingRevision,
        status: 'durable',
      };
    },
    async settleAttempt() {
      return 'durable';
    },
    stashCalls: [] as { address: ComposerDraftAddress; expectedRevision: string }[],
    stashDeferred: null as Promise<RestoreRecoveryResult> | null,
    async stashWorking(address, expectedRevision) {
      repository.stashCalls.push({ address, expectedRevision });
      if (repository.stashDeferred) return repository.stashDeferred;
      return { kind: 'restored', working: emptyWorking(address), status: 'durable' };
    },
    async listRecoveries() {
      return { recoveries: [], status: 'durable' };
    },
    async loadRecovery() {
      return null;
    },
    restoreCalls: [] as { destination: ComposerDraftAddress; expectedRevision: string }[],
    restoreDeferred: null as Promise<RestoreRecoveryResult> | null,
    async restoreRecovery(_sourceContextId, _sourceTeamName, _id, destination, expectedRevision) {
      repository.restoreCalls.push({ destination, expectedRevision });
      if (repository.restoreDeferred) return repository.restoreDeferred;
      return { kind: 'missing', status: 'durable' };
    },
    async reconcileRecovery() {
      return 'missing';
    },
    async discardRecovery() {
      return 'missing';
    },
    subscribe() {
      return () => undefined;
    },
    isAttemptActive() {
      return false;
    },
    setAttemptActive() {},
  };
  return repository;
}

const Harness = ({
  address,
  repository,
  onValue,
}: {
  address: ComposerDraftAddress;
  repository: ComposerDraftRepository;
  onValue: (value: UseComposerDraftResult) => void;
}): null => {
  onValue(useComposerDraft(address, repository));
  return null;
};

function renderDraft(
  root: ReturnType<typeof createRoot>,
  address: ComposerDraftAddress,
  repository: ComposerDraftRepository,
  draftRef: { current: UseComposerDraftResult | null }
): void {
  root.render(
    <Harness address={address} repository={repository} onValue={(value) => (draftRef.current = value)} />
  );
}

describe('useComposerDraft address lifecycle', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps an edit pending when its debounce expires before a slow load', async () => {
    vi.useFakeTimers();
    const repository = createRepository();
    let resolveLoad!: (working: ComposerWorkingRecord) => void;
    repository.deferredLoads.set(
      composerDraftAddressKey(alice),
      new Promise((resolve) => {
        resolveLoad = resolve;
      })
    );
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const draftRef: { current: UseComposerDraftResult | null } = { current: null };
    act(() => {
      root.render(
        <Harness address={alice} repository={repository} onValue={(value) => (draftRef.current = value)} />
      );
    });
    act(() => draftRef.current?.setText('typed during slow load'));
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(repository.records.has(composerDraftAddressKey(alice))).toBe(false);

    await act(async () => resolveLoad(emptyWorking(alice)));

    expect(repository.records.get(composerDraftAddressKey(alice))?.content?.text).toBe(
      'typed during slow load'
    );
    act(() => root.unmount());
  });

  it('preserves input typed before hydration across navigation and remount', async () => {
    const repository = createRepository();
    let resolveAlice!: (working: ComposerWorkingRecord) => void;
    repository.deferredLoads.set(
      composerDraftAddressKey(alice),
      new Promise((resolve) => {
        resolveAlice = resolve;
      })
    );
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const draftRef: { current: UseComposerDraftResult | null } = { current: null };
    act(() => {
      root.render(
        <Harness address={alice} repository={repository} onValue={(value) => (draftRef.current = value)} />
      );
    });
    act(() => draftRef.current?.setText('typed before Alice hydrated'));
    act(() => root.unmount());
    await act(async () => resolveAlice(emptyWorking(alice)));

    expect(repository.records.get(composerDraftAddressKey(alice))?.content?.text).toBe(
      'typed before Alice hydrated'
    );
    repository.deferredLoads.delete(composerDraftAddressKey(alice));
    const remountRoot = createRoot(host);
    await act(async () => {
      remountRoot.render(
        <Harness address={alice} repository={repository} onValue={(value) => (draftRef.current = value)} />
      );
    });
    expect(draftRef.current?.text).toBe('typed before Alice hydrated');
    act(() => remountRoot.unmount());
  });

  it('flushes Alice under her captured address while switching to Bob', async () => {
    const repository = createRepository();
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const draftRef: { current: UseComposerDraftResult | null } = { current: null };
    await act(async () => renderDraft(root, alice, repository, draftRef));
    act(() => draftRef.current?.setText('alice text'));
    await act(async () => renderDraft(root, bob, repository, draftRef));

    expect(repository.records.get(composerDraftAddressKey(alice))?.content?.text).toBe('alice text');
    expect(draftRef.current?.address).toEqual(bob);
    expect(draftRef.current?.text).toBe('');
    act(() => root.unmount());
  });

  it('waits for an outgoing save before reloading the same address after A-B-A navigation', async () => {
    const repository = createRepository();
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const draftRef: { current: UseComposerDraftResult | null } = { current: null };
    await act(async () => renderDraft(root, alice, repository, draftRef));
    act(() => draftRef.current?.setText('unsaved Alice'));
    let finishSave!: () => void;
    repository.saveDeferred = new Promise((resolve) => { finishSave = resolve; });
    await act(async () => renderDraft(root, bob, repository, draftRef));
    act(() => renderDraft(root, alice, repository, draftRef));

    expect(repository.loadCalls.filter((key) => key === composerDraftAddressKey(alice))).toHaveLength(1);
    await act(async () => finishSave());

    expect(repository.records.get(composerDraftAddressKey(alice))?.content?.text).toBe('unsaved Alice');
    expect(draftRef.current?.text).toBe('unsaved Alice');
    act(() => root.unmount());
  });

  it('ignores a late Alice load after Bob has become active', async () => {
    const repository = createRepository();
    let resolveAlice!: (working: ComposerWorkingRecord) => void;
    repository.deferredLoads.set(
      composerDraftAddressKey(alice),
      new Promise((resolve) => {
        resolveAlice = resolve;
      })
    );
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const draftRef: { current: UseComposerDraftResult | null } = { current: null };
    act(() => renderDraft(root, alice, repository, draftRef));
    await act(async () => renderDraft(root, bob, repository, draftRef));
    await act(async () =>
      resolveAlice({
        ...emptyWorking(alice),
        workingRevision: 'alice-loaded',
        content: { text: 'stale alice', chips: [], attachments: [], actionMode: 'ask' },
      })
    );

    expect(draftRef.current?.address).toEqual(bob);
    expect(draftRef.current?.text).toBe('');
    act(() => root.unmount());
  });

  it('persists revision context in the same working record as its content', async () => {
    const repository = createRepository();
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const draftRef: { current: UseComposerDraftResult | null } = { current: null };
    await act(async () => {
      root.render(
        <Harness address={bob} repository={repository} onValue={(value) => (draftRef.current = value)} />
      );
    });
    act(() => {
      draftRef.current?.setRevision(
        {
          kind: 'revision',
          originalMessageId: 'message-1',
          recipient: 'bob',
          requestId: 'revision-1',
        },
        { text: 'corrected', chips: [], attachments: [], actionMode: 'ask' }
      );
    });
    await act(async () => draftRef.current?.flush());

    const stored = repository.records.get(composerDraftAddressKey(bob));
    expect(stored?.content?.text).toBe('corrected');
    expect(stored?.editorContext).toEqual(
      expect.objectContaining({ kind: 'revision', originalMessageId: 'message-1' })
    );
    act(() => root.unmount());
  });

  it('freezes A before await and preserves B typed while begin is preparing', async () => {
    const repository = createRepository();
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const draftRef: { current: UseComposerDraftResult | null } = { current: null };
    await act(async () => {
      root.render(
        <Harness address={alice} repository={repository} onValue={(value) => (draftRef.current = value)} />
      );
    });
    act(() => draftRef.current?.setText('frozen A'));

    let begin!: ReturnType<UseComposerDraftResult['beginAttempt']>;
    act(() => {
      begin = draftRef.current!.beginAttempt('attempt-a', {
        kind: 'local',
        teamName: 'team-a',
        request: { member: 'alice', text: 'frozen A' },
      });
      draftRef.current?.setText('new B');
    });
    await act(async () => begin);

    expect(repository.attempts[0]?.snapshot.content.text).toBe('frozen A');
    expect(draftRef.current?.text).toBe('new B');
    await act(async () => draftRef.current?.flush());
    expect(repository.records.get(composerDraftAddressKey(alice))?.content?.text).toBe('new B');
    act(() => root.unmount());
  });

  it('holds a synchronous restore lease and only adopts its exact address token', async () => {
    const repository = createRepository();
    let resolveRestore!: (result: RestoreRecoveryResult) => void;
    repository.restoreDeferred = new Promise((resolve) => {
      resolveRestore = resolve;
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const draftRef: { current: UseComposerDraftResult | null } = { current: null };
    await act(async () => renderDraft(root, alice, repository, draftRef));

    let restore!: Promise<RestoreRecoveryResult>;
    act(() => {
      restore = draftRef.current!.restoreRecovery('context-a', 'team-a', 'recovery-1');
      draftRef.current?.setText('blocked while restoring');
    });
    await act(async () => draftRef.current?.addFiles([new File(['x'], 'x.png', { type: 'image/png' })]));
    expect(draftRef.current?.text).toBe('');
    expect(draftRef.current?.attachments).toEqual([]);
    expect(draftRef.current?.isRestoring).toBe(true);
    await expect(
      draftRef.current!.restoreRecovery('context-a', 'team-a', 'recovery-2')
    ).resolves.toEqual(expect.objectContaining({ kind: 'active' }));
    await expect(draftRef.current!.stashWorking()).resolves.toEqual(
      expect.objectContaining({ kind: 'active' })
    );
    await expect(
      draftRef.current!.beginAttempt('attempt-during-restore', {
        kind: 'local',
        teamName: 'team-a',
        request: { member: 'alice', text: 'blocked' },
      })
    ).resolves.toBeNull();
    await act(async () => renderDraft(root, bob, repository, draftRef));
    await act(async () => renderDraft(root, alice, repository, draftRef));
    await act(async () =>
      resolveRestore({
        kind: 'restored',
        status: 'durable',
        working: {
          ...emptyWorking(alice),
          workingRevision: 'restored-1',
          content: { text: 'recovered Alice', chips: [], attachments: [], actionMode: 'do' },
        },
      })
    );
    await act(async () => restore);

    expect(draftRef.current?.address).toEqual(alice);
    expect(draftRef.current?.text).toBe('');
    expect(draftRef.current?.isRestoring).toBe(false);
    act(() => root.unmount());
  });

  it('stashes with Alice captured tokens and never applies its result to Bob', async () => {
    const repository = createRepository();
    let resolveStash!: (result: RestoreRecoveryResult) => void;
    repository.stashDeferred = new Promise((resolve) => {
      resolveStash = resolve;
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const draftRef: { current: UseComposerDraftResult | null } = { current: null };
    await act(async () => renderDraft(root, alice, repository, draftRef));
    act(() => draftRef.current?.setText('alice draft'));
    await act(async () => draftRef.current?.flush());

    let stash!: Promise<RestoreRecoveryResult>;
    act(() => {
      stash = draftRef.current!.stashWorking();
    });
    await act(async () => undefined);
    await act(async () => renderDraft(root, bob, repository, draftRef));
    await act(async () =>
      resolveStash({ kind: 'restored', status: 'durable', working: emptyWorking(alice) })
    );
    await act(async () => stash);

    expect(repository.stashCalls).toEqual([
      expect.objectContaining({ address: alice, expectedRevision: expect.stringMatching(/^edit:/) }),
    ]);
    expect(draftRef.current?.address).toEqual(bob);
    expect(draftRef.current?.text).toBe('');
    act(() => root.unmount());
  });

  it('holds a stash lease through navigation and releases it after completion', async () => {
    const repository = createRepository();
    let resolveStash!: (result: RestoreRecoveryResult) => void;
    repository.stashDeferred = new Promise((resolve) => { resolveStash = resolve; });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const draftRef: { current: UseComposerDraftResult | null } = { current: null };
    await act(async () => renderDraft(root, alice, repository, draftRef));
    act(() => draftRef.current?.setText('Alice text'));
    await act(async () => draftRef.current?.flush());

    let stash!: Promise<RestoreRecoveryResult>;
    act(() => {
      stash = draftRef.current!.stashWorking();
      draftRef.current?.setText('blocked during stash');
    });
    await expect(draftRef.current!.stashWorking()).resolves.toEqual(
      expect.objectContaining({ kind: 'active' })
    );
    await act(async () => renderDraft(root, bob, repository, draftRef));
    act(() => draftRef.current?.setText('blocked Bob edit'));
    expect(draftRef.current?.text).toBe('');
    await act(async () => resolveStash({ kind: 'restored', status: 'durable', working: emptyWorking(alice) }));
    await act(async () => stash);
    act(() => draftRef.current?.setText('Bob text'));
    expect(draftRef.current?.text).toBe('Bob text');
    expect(repository.stashCalls).toHaveLength(1);
    act(() => root.unmount());
  });
});
