import 'fake-indexeddb/auto';

import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useAttachments } from '@renderer/hooks/useAttachments';
import { useComposerDraft } from '@renderer/hooks/useComposerDraft';
import { composerDraftRepository } from '@renderer/services/composerDraftRepository';
import { draftStorage } from '@renderer/services/draftStorage';
import * as attachmentUtils from '@renderer/utils/attachmentUtils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AttachmentPayload } from '@shared/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const payload = (id: string): AttachmentPayload => ({
  id,
  filename: id,
  mimeType: 'application/octet-stream',
  size: 1,
  data: '/w==',
});
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.restoreAllMocks();
});

function mount(operationKey = 'alice', persistenceKey?: string) {
  let current!: ReturnType<typeof useAttachments>;
  function Harness({ recipient }: { recipient: string }) {
    current = useAttachments({
      allowFileReferences: true,
      operationKey: recipient,
      persistenceKey,
    });
    return null;
  }
  root = createRoot(document.createElement('div'));
  const render = async (recipient: string) =>
    act(async () => root!.render(createElement(Harness, { recipient })));
  return { render, get: () => current, ready: render(operationKey) };
}

describe('message file byte and draft lifecycle', () => {
  it('keeps malformed UTF-8 JSON bytes and original MIME instead of replacement text', async () => {
    const file = new File([Uint8Array.from([0xff, 0x00, 0xc3, 0x28])], 'data.json', {
      type: 'application/json',
    });
    const result = await attachmentUtils.fileToAgentAttachmentPayload(file, true);
    expect(result.mimeType).toBe('application/json');
    expect(result.data).toBe('/wDDKA==');
    expect(result.size).toBe(4);
  });

  it('commits concurrent batches against current cards and clear fences an unfinished read', async () => {
    const first = deferred<AttachmentPayload>();
    const second = deferred<AttachmentPayload>();
    const third = deferred<AttachmentPayload>();
    vi.spyOn(attachmentUtils, 'fileToAgentAttachmentPayload')
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockImplementationOnce(() => third.promise);
    const harness = mount();
    await harness.ready;
    const file = new File(['x'], 'data.bin');
    let one!: Promise<void>;
    let two!: Promise<void>;
    let three!: Promise<void>;
    await act(async () => {
      one = harness.get().addFiles([file]);
      two = harness.get().addFiles([file]);
    });
    await act(async () => {
      second.resolve(payload('second'));
      await two;
    });
    await act(async () => {
      first.resolve(payload('first'));
      await one;
    });
    expect(harness.get().attachments.map((item) => item.id)).toEqual(['second', 'first']);
    await act(async () => {
      three = harness.get().addFiles([file]);
      harness.get().clearAttachments();
    });
    await act(async () => {
      third.resolve(payload('late'));
      await three;
    });
    expect(harness.get().attachments).toEqual([]);
  });

  it('does not move an unfinished file read to a different recipient', async () => {
    const pending = deferred<AttachmentPayload>();
    vi.spyOn(attachmentUtils, 'fileToAgentAttachmentPayload').mockImplementation(
      () => pending.promise
    );
    const harness = mount();
    await harness.ready;
    let adding!: Promise<void>;
    await act(async () => {
      adding = harness.get().addFiles([new File(['x'], 'data.bin')]);
    });
    await harness.render('bob');
    await act(async () => {
      pending.resolve(payload('late'));
      await adding;
    });
    expect(harness.get().attachments).toEqual([]);
  });
  it.each(['clearAttachments', 'clearDraft'] as const)(
    'a pending composer add cannot resurrect cards after %s',
    async (clear) => {
      const pending = deferred<AttachmentPayload>();
      vi.spyOn(attachmentUtils, 'fileToAgentAttachmentPayload').mockImplementation(
        () => pending.promise
      );
      let draft!: ReturnType<typeof useComposerDraft>;
      const address = {
        contextId: 'local',
        teamName: `TEST-clear-${clear}`,
        target: { kind: 'direct' as const, participant: 'worker' },
      };
      function Composer() {
        draft = useComposerDraft(address);
        return null;
      }
      root = createRoot(document.createElement('div'));
      await act(async () => {
        root!.render(createElement(Composer));
      });
      await act(async () => {
        await composerDraftRepository.loadWorking(address);
      });
      expect(draft.isLoaded).toBe(true);
      await act(async () => {
        draft.setText('unchanged user text');
      });
      let adding!: Promise<void>;
      await act(async () => {
        adding = draft.addFiles([new File(['x'], 'data.bin')]);
      });
      await act(async () => {
        await draft[clear]();
      });
      await act(async () => {
        pending.resolve(payload('late'));
        await adding;
      });
      expect(draft.attachments).toEqual([]);
      if (clear === 'clearAttachments') expect(draft.text).toBe('unchanged user text');
    }
  );

  it('loads the persisted cards before committing a new batch instead of overwriting either', async () => {
    const restoring = deferred<string | null>();
    vi.spyOn(draftStorage, 'loadDraft').mockImplementation(() => restoring.promise);
    vi.spyOn(attachmentUtils, 'fileToAgentAttachmentPayload').mockResolvedValue(payload('new'));
    const harness = mount('alice', 'TEST-message-files');
    await harness.ready;
    let adding!: Promise<void>;
    await act(async () => {
      adding = harness.get().addFiles([new File(['x'], 'data.bin')]);
    });
    await act(async () => {
      restoring.resolve(JSON.stringify([payload('old')]));
      await adding;
    });
    expect(harness.get().attachments.map((item) => item.id)).toEqual(['old', 'new']);
  });

  it('captures the live FileList before the dialog resets selection during draft restore', async () => {
    const restoring = deferred<string | null>();
    vi.spyOn(draftStorage, 'loadDraft').mockImplementation(() => restoring.promise);
    const readFile = vi
      .spyOn(attachmentUtils, 'fileToAgentAttachmentPayload')
      .mockResolvedValue(payload('selected'));
    const harness = mount('alice', 'TEST-live-file-input');
    await harness.ready;
    const file = new File(['x'], 'selected.bin');
    let selected: File | null = file;
    // A live collection contract fixture: resetting selection changes the same object,
    // including its iterator. An immutable File[] would hide the dialog regression.
    const liveFiles = {
      get length() {
        return selected ? 1 : 0;
      },
      get 0() {
        return selected ?? undefined;
      },
      item: (index: number) => (index === 0 ? selected : null),
      [Symbol.iterator]: function* () {
        if (selected) yield selected;
      },
    } as unknown as FileList;
    let adding!: Promise<void>;
    await act(async () => {
      adding = harness.get().addFiles(liveFiles);
      selected = null; // Same observable collection reset as input.value = ''.
    });
    expect(liveFiles.length).toBe(0);
    expect(readFile).not.toHaveBeenCalled();
    await act(async () => {
      restoring.resolve(null);
      await adding;
    });
    expect(readFile).toHaveBeenCalledWith(file, true);
    expect(harness.get().attachments.map((item) => item.id)).toEqual(['selected']);
  });

  it('does not persist an attachment whose byte read completes after composer unmount', async () => {
    const pending = deferred<AttachmentPayload>();
    vi.spyOn(attachmentUtils, 'fileToAgentAttachmentPayload').mockImplementation(
      () => pending.promise
    );
    const saveWorking = vi.spyOn(composerDraftRepository, 'saveWorking');
    let draft!: ReturnType<typeof useComposerDraft>;
    const address = {
      contextId: 'local',
      teamName: 'TEST-unmounted-file-read',
      target: { kind: 'direct' as const, participant: 'worker' },
    };
    function Composer() {
      draft = useComposerDraft(address);
      return null;
    }
    root = createRoot(document.createElement('div'));
    // Exercise StrictMode cleanup/setup before starting the user's read.
    await act(async () => {
      root!.render(createElement(StrictMode, null, createElement(Composer)));
    });
    await act(async () => {
      await composerDraftRepository.loadWorking(address);
    });
    expect(draft.isLoaded).toBe(true);
    await act(async () => {
      draft.setText('preserved user text');
      await draft.flush();
    });
    saveWorking.mockClear();
    let adding!: Promise<void>;
    await act(async () => {
      adding = draft.addFiles([new File(['x'], 'late.bin')]);
    });
    await act(async () => {
      root!.unmount();
    });
    root = undefined;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await act(async () => {
        pending.resolve(payload('late'));
        await adding;
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(saveWorking).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
    const persisted = await composerDraftRepository.loadWorking(address);
    expect(persisted.working.content?.text).toBe('preserved user text');
    expect(persisted.working.content?.attachments).toEqual([]);
  });
});
