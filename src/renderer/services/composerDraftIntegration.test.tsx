import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { runComposerSubmission } from '@renderer/components/team/messages/composerSubmission';
import { useComposerDraft, type UseComposerDraftResult } from '@renderer/hooks/useComposerDraft';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IndexedDbComposerDraftRepository } from './composerDraftRepository';

import type {
  ComposerDraftAddress,
  ComposerDraftRepository,
  PreparedComposerAttempt,
} from '@renderer/types/composerDraft';

const database = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  unavailable: false,
  pauseNextWrite: null as Promise<void> | null,
}));

vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: string) => {
    if (database.unavailable) throw new Error('audit storage unavailable');
    return database.values.get(key);
  }),
}));

vi.mock('@renderer/services/composerDraftIndexedDb', () => ({
  requestValue: async (request: { result: unknown }) => request.result,
  composerDraftEntriesByPrefix: async (_store: IDBObjectStore, prefix: string) => {
    return [...database.values.entries()].filter(([key]) => key.startsWith(prefix));
  },
  composerDraftReadwrite: async <T,>(callback: (store: IDBObjectStore) => Promise<T>) => {
    if (database.unavailable) throw new Error('audit storage unavailable');
    const pause = database.pauseNextWrite;
    database.pauseNextWrite = null;
    if (pause) await pause;
    const staged = new Map(database.values);
    const store = {
      get: (key: string) => {
        return { result: staged.get(key) };
      },
      put: (value: unknown, key: string) => {
        staged.set(key, value);
      },
      delete: (key: string) => {
        staged.delete(key);
      },
    } as unknown as IDBObjectStore;
    const result = await callback(store);
    database.values = staged;
    return result;
  },
}));

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

function attempt(id: string): PreparedComposerAttempt {
  return {
    attemptId: id,
    snapshot: {
      content: { text: 'alice send', chips: [], attachments: [], actionMode: 'do' },
      editorContext: { kind: 'plain' },
    },
    preparedRequest: {
      kind: 'local',
      teamName: 'team-a',
      request: { member: 'alice', text: 'alice send' },
    },
    createdAt: 1,
  };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const DraftHarness = ({
  address,
  repository,
  outputRef,
}: {
  address: ComposerDraftAddress;
  repository: ComposerDraftRepository;
  outputRef: { current: UseComposerDraftResult | null };
}) => {
  outputRef.current = useComposerDraft(address, repository);
  return <textarea readOnly value={outputRef.current.text} />;
};
const mountedRoots: ReturnType<typeof createRoot>[] = [];
function mountRoot() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  return root;
}
async function seed(
  repository: ComposerDraftRepository,
  address: ComposerDraftAddress,
  text: string
) {
  await repository.saveWorking(
    address,
    '0',
    `saved-${text}`,
    { text, chips: [], attachments: [], actionMode: 'do' },
    { kind: 'plain' }
  );
}
describe('composer draft lifecycle integration', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    database.values = new Map();
    database.unavailable = false;
    database.pauseNextWrite = null;
  });
  afterEach(() => {
    for (const root of mountedRoots.splice(0)) act(() => root.unmount());
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    { replacement: null, description: 'clears a sent message' },
    { replacement: 'message B', description: 'keeps newer text' },
  ])('$description after remount during the old send', async ({ replacement }) => {
    const repository = new IndexedDbComposerDraftRepository();
    await seed(repository, alice, 'message A');
    const oldOutput = { current: null as UseComposerDraftResult | null };
    const oldRoot = mountRoot();
    await act(async () =>
      oldRoot.render(<DraftHarness address={alice} repository={repository} outputRef={oldOutput} />)
    );
    const gate = deferred();
    database.pauseNextWrite = gate.promise;
    let flush!: Promise<void>;
    act(() => oldOutput.current!.setText('message A'));
    await act(async () => {
      flush = oldOutput.current!.flush();
    });
    const sendDraft = oldOutput.current!;
    const transport = vi.fn(async () => ({ deliveredToInbox: true, messageId: 'sent-a' }));
    let sent!: ReturnType<typeof runComposerSubmission>;
    await act(async () => {
      sent = runComposerSubmission({
        attemptId: 'first-a',
        contextId: alice.contextId,
        repository,
        prepare: () =>
          sendDraft.beginAttempt('first-a', {
            kind: 'local',
            teamName: alice.teamName,
            request: { member: 'alice', text: sendDraft.text },
          }),
        isContextCurrent: () => true,
        transport,
      });
    });
    act(() => oldRoot.unmount());
    mountedRoots.splice(mountedRoots.indexOf(oldRoot), 1);
    const nextOutput = { current: null as UseComposerDraftResult | null };
    const nextRoot = mountRoot();
    await act(async () =>
      nextRoot.render(
        <DraftHarness address={alice} repository={repository} outputRef={nextOutput} />
      )
    );
    if (replacement) act(() => nextOutput.current!.setText(replacement));
    await act(async () => {
      gate.resolve();
      await flush;
      await sent;
    });
    if (replacement) await act(async () => nextOutput.current!.flush());
    expect(transport).toHaveBeenCalledTimes(1);
    expect((await repository.loadWorking(alice)).working.content?.text ?? '').toBe(
      replacement ?? ''
    );
    expect(nextOutput.current!.isLoaded).toBe(true);
    expect(nextOutput.current!.text).toBe(replacement ?? '');
    if (replacement) {
      act(() => nextRoot.unmount());
      mountedRoots.splice(mountedRoots.indexOf(nextRoot), 1);
      const reopened = mountRoot();
      await act(async () =>
        reopened.render(
          <DraftHarness address={alice} repository={repository} outputRef={nextOutput} />
        )
      );
      expect(nextOutput.current!.text).toBe(replacement);
    }
  });

  it('retains an unconfirmed send in session memory after storage failure', async () => {
    const repository = new IndexedDbComposerDraftRepository();
    await seed(repository, alice, 'message A');
    const working = await repository.loadWorking(alice);
    const started = await repository.beginAttempt(
      alice,
      working.working.workingRevision,
      attempt('storage-a')
    );
    expect(started.kind).toBe('prepared');
    expect(
      (await repository.loadRecovery(alice.contextId, alice.teamName, 'storage-a'))?.snapshot
        .content.text
    ).toBe('alice send');
    database.unavailable = true;
    expect(
      await repository.settleAttempt(alice, 'storage-a', {
        kind: 'unconfirmed',
        detail: 'transport unavailable',
      })
    ).toBe('memory-only');
    const list = await repository.listRecoveries(alice.contextId, alice.teamName);
    expect(list.recoveries.map((item) => item.id)).toContain('storage-a');
    expect(
      (await repository.loadRecovery(alice.contextId, alice.teamName, 'storage-a'))?.snapshot
        .content.text
    ).toBe('alice send');
  });

  it('keeps a flushed edit when the send-clear event read finishes late', async () => {
    const repository = new IndexedDbComposerDraftRepository();
    await seed(repository, alice, 'message A');
    const output = { current: null as UseComposerDraftResult | null };
    const root = mountRoot();
    await act(async () =>
      root.render(<DraftHarness address={alice} repository={repository} outputRef={output} />)
    );
    const readStarted = deferred();
    const releaseRead = deferred();
    const originalLoad = repository.loadWorking.bind(repository);
    let holdNextRead = true;
    vi.spyOn(repository, 'loadWorking').mockImplementation(async (address) => {
      const loaded = await originalLoad(address);
      if (holdNextRead) {
        holdNextRead = false;
        readStarted.resolve();
        await releaseRead.promise;
      }
      return loaded;
    });
    const current = await originalLoad(alice);
    await act(async () => {
      expect(
        await repository.beginAttempt(
          alice,
          current.working.workingRevision,
          attempt('clear-before-edit')
        )
      ).toMatchObject({ kind: 'prepared', workingCleared: true });
      await readStarted.promise;
    });
    act(() => output.current!.setText('message B'));
    let flush!: Promise<void>;
    act(() => {
      flush = output.current!.flush();
    });
    await act(async () => {
      releaseRead.resolve();
      await flush;
    });
    expect((await repository.loadWorking(alice)).working.content?.text).toBe('message B');
    act(() => root.unmount());
    mountedRoots.splice(mountedRoots.indexOf(root), 1);
    const reopened = mountRoot();
    await act(async () =>
      reopened.render(<DraftHarness address={alice} repository={repository} outputRef={output} />)
    );
    expect(output.current!.text).toBe('message B');
  });

  it('does not let late Alice hydration consume Bob input', async () => {
    const repository = new IndexedDbComposerDraftRepository();
    await seed(repository, alice, 'old Alice');
    await seed(repository, bob, 'old Bob');
    const load = repository.loadWorking.bind(repository);
    const stash = repository.stashWorking.bind(repository);
    const aliceLoad = deferred();
    const bobLoad = deferred();
    const aliceStash = deferred();
    const stashStarted = deferred();
    let holdAliceLoad = true;
    let holdBobLoad = true;
    let holdAliceStash = true;
    vi.spyOn(repository, 'loadWorking').mockImplementation(async (address) => {
      const result = await load(address);
      if (
        address.target.kind === 'direct' &&
        address.target.participant === 'alice' &&
        holdAliceLoad
      ) {
        holdAliceLoad = false;
        await aliceLoad.promise;
      }
      if (address.target.kind === 'direct' && address.target.participant === 'bob' && holdBobLoad) {
        holdBobLoad = false;
        await bobLoad.promise;
      }
      return result;
    });
    vi.spyOn(repository, 'stashWorking').mockImplementation(async (...args) => {
      const result = await stash(...args);
      if (
        args[0].target.kind === 'direct' &&
        args[0].target.participant === 'alice' &&
        holdAliceStash
      ) {
        holdAliceStash = false;
        stashStarted.resolve();
        await aliceStash.promise;
      }
      return result;
    });
    const output = { current: null as UseComposerDraftResult | null };
    const root = mountRoot();
    await act(async () =>
      root.render(<DraftHarness address={alice} repository={repository} outputRef={output} />)
    );
    act(() => output.current!.setText('new Alice'));
    await act(async () => {
      aliceLoad.resolve();
      await stashStarted.promise;
    });
    await act(async () =>
      root.render(<DraftHarness address={bob} repository={repository} outputRef={output} />)
    );
    act(() => output.current!.setText('new Bob'));
    await act(async () => aliceStash.resolve());
    await act(async () => bobLoad.resolve());
    expect(output.current!.text).toBe('new Bob');
    const bobRecoveries = (await repository.listRecoveries(bob.contextId, bob.teamName)).recoveries;
    const bobRecoveryBodies = await Promise.all(
      bobRecoveries.map((item) => repository.loadRecovery(bob.contextId, bob.teamName, item.id))
    );
    expect(bobRecoveryBodies.some((item) => item?.snapshot.content.text === 'new Bob')).toBe(false);
    await act(async () => output.current!.flush());
    act(() => root.unmount());
    mountedRoots.splice(mountedRoots.indexOf(root), 1);
    const remounted = mountRoot();
    await act(async () =>
      remounted.render(<DraftHarness address={bob} repository={repository} outputRef={output} />)
    );
    expect(output.current!.text).toBe('new Bob');
  });
});
