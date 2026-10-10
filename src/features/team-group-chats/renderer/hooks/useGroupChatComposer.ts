import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';
import { composerDraftRepository } from '@renderer/services/composerDraftRepository';

import type { GroupChatSendResult } from '../../contracts';
import type { ComposerDraftAddress, ComposerDraftContent } from '@renderer/types/composerDraft';

export function useGroupChatComposer(
  teamName: string,
  contextId: string,
  groupChatId: string,
  refresh: () => Promise<void>,
  groupChatName?: string,
  defaultRecipientName?: string | null
) {
  const address = useMemo<ComposerDraftAddress>(
    () => ({ teamName, contextId, target: { kind: 'group', groupChatId } }),
    [contextId, groupChatId, teamName]
  );
  const [text, setText] = useState('');
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [selection, setSelection] = useState<string | null | undefined>(undefined);
  const recipientName = selection === undefined ? (defaultRecipientName ?? null) : selection;
  const [readyAddress, setReadyAddress] = useState<ComposerDraftAddress | null>(null);
  const ready = readyAddress === address;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GroupChatSendResult | null>(null);
  const session = useMemo(
    () => ({ address, revision: '', queue: Promise.resolve(), sending: false }),
    [address]
  );
  const current = useRef(address);
  current.current = address;
  const persist = useCallback(
    (content: ComposerDraftContent | null) => {
      const operation = session.queue.then(async () => {
        const draftAddress: ComposerDraftAddress = groupChatName
          ? { ...address, target: { kind: 'group', groupChatId, groupChatName } }
          : address;
        const saved = await composerDraftRepository.saveWorking(
          draftAddress,
          session.revision,
          crypto.randomUUID(),
          content,
          { kind: 'plain' }
        );
        if (saved.kind !== 'saved')
          throw new Error(
            saved.kind === 'blocked'
              ? saved.error
              : 'The draft changed in another window. Reopen the chat before sending.'
          );
        session.revision = saved.workingRevision;
      });
      session.queue = operation.catch((cause: unknown) => {
        if (current.current === address)
          setError(cause instanceof Error ? cause.message : String(cause));
      });
      return operation;
    },
    [address, groupChatId, groupChatName, session]
  );
  useEffect(() => {
    let active = true;
    setReadyAddress(null);
    setText('');
    setAttemptId(null);
    setSelection(undefined);
    setPending(false);
    setResult(null);
    setError(null);
    if (!groupChatId) return;
    void composerDraftRepository.loadWorking(address).then((loaded) => {
      if (!active) return;
      session.revision = loaded.working.workingRevision;
      setText(loaded.working.content?.text ?? '');
      setAttemptId(loaded.working.content?.restoredOrigin?.attemptId ?? null);
      const savedSelection = loaded.working.content?.groupRecipient;
      setSelection(
        savedSelection?.kind === 'member'
          ? savedSelection.memberName
          : savedSelection?.kind === 'all' || loaded.working.content?.restoredOrigin
            ? null
            : undefined
      );
      setReadyAddress(loaded.writeBlocked ? null : address);
      setError(loaded.readError ?? null);
    });
    return () => {
      active = false;
    };
  }, [address, groupChatId, session]);
  const content = (value: string, id: string | null): ComposerDraftContent => ({
    text: value,
    chips: [],
    attachments: [],
    actionMode: 'do',
    groupRecipient:
      recipientName === null ? { kind: 'all' } : { kind: 'member', memberName: recipientName },
    ...(id
      ? { restoredOrigin: { kind: 'unconfirmed-send', attemptId: id, messageId: id } as const }
      : {}),
  });
  const change = (value: string) => {
    if (!ready || session.sending || pending || attemptId) return;
    setSelection(recipientName);
    setText(value);
    void persist(content(value, null)).catch(() => undefined);
  };
  const selectRecipient = (name: string | null) => {
    if (!ready || session.sending || pending || attemptId) return;
    setSelection(name);
    void persist({
      ...content(text, null),
      groupRecipient: name === null ? { kind: 'all' } : { kind: 'member', memberName: name },
    }).catch(() => undefined);
  };
  const send = async () => {
    if (!ready || session.sending || pending || !text.trim()) return;
    session.sending = true;
    const id = attemptId ?? crypto.randomUUID();
    setSelection(recipientName);
    setAttemptId(id);
    setPending(true);
    setError(null);
    try {
      await persist(content(text, id));
      const sent = await api.teamGroupChats.send({
        teamName,
        groupChatId,
        messageId: id,
        text,
        ...(recipientName === null ? {} : { recipientName }),
      });
      if (current.current === address) {
        setResult(sent);
        setText('');
        setAttemptId(null);
      }
      try {
        await persist(null);
      } catch (cause) {
        if (current.current === address)
          setError(
            `Message saved, but the draft could not be cleared: ${cause instanceof Error ? cause.message : String(cause)}`
          );
      }
      if (current.current === address) {
        try {
          await refresh();
        } catch (cause) {
          if (current.current === address)
            setError(
              `Message saved, but history could not be refreshed: ${cause instanceof Error ? cause.message : String(cause)}`
            );
        }
      }
    } catch (cause) {
      if (current.current === address) {
        const code = cause instanceof Error && 'code' in cause ? cause.code : null;
        if (
          typeof code === 'string' &&
          [
            'invalid-input',
            'invalid-members',
            'invalid-recipient',
            'reserved-group',
            'archived',
            'minimum-members',
            'not-member',
            'recipient-unavailable',
            'invalid-relay',
            'not-found',
          ].includes(code)
        ) {
          await persist(content(text, null));
          setAttemptId(null);
        }
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      session.sending = false;
      if (current.current === address) setPending(false);
    }
  };
  return {
    text,
    change,
    send,
    ready,
    pending,
    error,
    result,
    attemptId,
    recipientName,
    selectRecipient,
  };
}
