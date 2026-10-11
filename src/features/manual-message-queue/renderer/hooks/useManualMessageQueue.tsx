import { useCallback, useEffect, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';
import { useStore } from '@renderer/store';
import {
  captureContextScopedRequestEpoch,
  isContextScopedRequestEpochCurrent,
} from '@renderer/store/utils/contextScopedRequestEpoch';
import { stripEncodedTaskReferenceMetadata } from '@renderer/utils/taskReferenceUtils';
import { MAX_TEXT_LENGTH } from '@shared/constants';
import { parseStandaloneSlashCommand } from '@shared/utils/slashCommands';

import { queueScopeKey, queueTextValid } from '../../core/domain/queue';
import { captureQueueScope } from '../adapters/queueBinding';
import { dispatchQueueItem, ownsQueueAttempt } from '../adapters/queueDispatch';
import { queueRepository } from '../adapters/queueRepository';
import { QueueList } from '../ui/QueueList';

import type { QueueItem, QueueRequest, QueueRoute, QueueScope } from '../../core/domain/queue';
import type { ComposerWorkingRecord } from '@renderer/types/composerDraft';
import type { SendMessageResult } from '@shared/types';
import type { ReactNode } from 'react';

export interface ManualQueueOptions {
  teamName: string;
  route: QueueRoute;
  unavailableReason?: string | null;
  consume: (
    commit: (working: ComposerWorkingRecord) => Promise<ComposerWorkingRecord>
  ) => Promise<void>;
  blockedReason: (item: QueueItem) => string | null;
  prepare: (item: QueueItem, messageId: string) => QueueRequest;
  transport: (
    item: QueueItem,
    request: QueueRequest
  ) => Promise<SendMessageResult | { saved: true }>;
  refresh: () => Promise<void>;
}
export interface ManualQueueBinding {
  onEnqueue: () => void;
  unavailableReason?: string;
  list: ReactNode;
}
export function useManualMessageQueue(options: ManualQueueOptions): ManualQueueBinding {
  const { t } = useAppTranslation('team');
  const contextId = useStore((state) => state.activeContextId);
  const switching = useStore((state) => state.isContextSwitching);
  const host = useStore((state) => state.connectedHost);
  const configuredRoot = useStore((state) => state.appConfig?.general.claudeRootPath);
  const chat =
    options.route.kind === 'direct'
      ? 'direct:' + options.route.participant
      : 'group:' + options.route.groupChatId;
  const identity = JSON.stringify([contextId, configuredRoot, host, options.teamName, chat]);
  const current = useRef(options);
  current.current = options;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const [loaded, setLoaded] = useState<{
    identity: string;
    scope: QueueScope;
    items: readonly QueueItem[];
  } | null>(null);
  const [error, setError] = useState<{ identity: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const operationActive = useRef(false);
  const message = useCallback(
    (cause: unknown): string => {
      const key = cause instanceof Error ? cause.message : '';
      if (key === 'rootUnavailable') return String(t('messages.manualQueue.rootUnavailable'));
      if (key === 'persistenceRequired')
        return String(t('messages.manualQueue.persistenceRequired'));
      if (key === 'recipientUnavailable')
        return String(t('messages.manualQueue.recipientUnavailable'));
      if (key === 'queue-schema') return String(t('messages.manualQueue.schemaError'));
      if (key === 'queue-conflict' || key === 'queue-frozen' || key === 'queue-busy')
        return String(t('messages.manualQueue.conflict'));
      if (key === 'queue-invalid-text')
        return String(t('messages.manualQueue.invalidText', { maximum: MAX_TEXT_LENGTH }));
      return cause instanceof Error
        ? cause.message
        : String(t('messages.manualQueue.operationFailed'));
    },
    [t]
  );
  useEffect(() => {
    const owner = current.current;
    let active = true;
    let version = 0;
    const load = async (): Promise<void> => {
      const capturedVersion = ++version;
      try {
        const scope = await captureQueueScope(owner.teamName, owner.route);
        const items = await queueRepository.list(scope, ownsQueueAttempt);
        if (active && capturedVersion === version && identityRef.current === identity) {
          setLoaded({ identity, scope, items });
          setError(null);
        }
      } catch (cause) {
        if (active && capturedVersion === version && identityRef.current === identity) {
          setLoaded(null);
          setError({ identity, message: message(cause) });
        }
      }
    };
    void load();
    const unsubscribe = queueRepository.subscribe(() => {
      void load();
    });
    return () => {
      active = false;
      unsubscribe();
    };
    // Recipient changes intentionally share a group queue.
  }, [identity, switching, message]);
  const scope = loaded?.identity === identity ? loaded.scope : null;
  const items = loaded?.identity === identity ? loaded.items : [];
  const run = async (operation: () => Promise<void>): Promise<void> => {
    if (operationActive.current) throw new Error('queue-busy');
    operationActive.current = true;
    setBusy(true);
    try {
      await operation();
      if (identityRef.current === identity) setError(null);
    } catch (cause) {
      if (identityRef.current === identity) setError({ identity, message: message(cause) });
      throw new Error(message(cause));
    } finally {
      operationActive.current = false;
      setBusy(false);
    }
  };
  const binding = (): Promise<QueueScope> => captureQueueScope(options.teamName, options.route);
  const isBound = async (): Promise<void> => {
    if (
      !scope ||
      switching ||
      identityRef.current !== identity ||
      queueScopeKey(await binding()) !== queueScopeKey(scope)
    )
      throw new Error('rootUnavailable');
  };
  const snapshotIsCurrent = (epoch: number): boolean => {
    const state = useStore.getState();
    return (
      identityRef.current === identity &&
      isContextScopedRequestEpochCurrent(epoch) &&
      !state.isContextSwitching &&
      state.activeContextId === contextId &&
      state.appConfig?.general.claudeRootPath === configuredRoot &&
      state.connectedHost === host
    );
  };
  const commitEnqueue = async (
    working: ComposerWorkingRecord,
    epoch: number
  ): Promise<ComposerWorkingRecord> => {
    if (
      !scope ||
      !working.content ||
      !queueTextValid(working.content.text, MAX_TEXT_LENGTH) ||
      !isContextScopedRequestEpochCurrent(epoch)
    )
      throw new Error('queue-conflict');
    await isBound();
    if (options.route.kind === 'group') {
      const saved = working.content.groupRecipient;
      const recipient = saved?.kind === 'member' ? saved.memberName : null;
      if (recipient !== options.route.recipientName) throw new Error('queue-conflict');
    }
    return queueRepository.enqueue(scope, options.route, working, () => snapshotIsCurrent(epoch));
  };
  const enqueue = (): void => {
    if (options.unavailableReason || !scope) return;
    const epoch = captureContextScopedRequestEpoch();
    void run(() => options.consume((working) => commitEnqueue(working, epoch))).catch(
      () => undefined
    );
  };
  const send = (item: QueueItem): Promise<void> => {
    const epoch = captureContextScopedRequestEpoch();
    return run(async () => {
      await dispatchQueueItem({
        item,
        repository: queueRepository,
        binding,
        isCurrent: () =>
          identityRef.current === identity && isContextScopedRequestEpochCurrent(epoch),
        blockedReason: (queued) => current.current.blockedReason(queued),
        prepare: options.prepare,
        transport: options.transport,
      });
      // Transport settles durably even if its initiating composer unmounts.
      if (identityRef.current === identity && isContextScopedRequestEpochCurrent(epoch))
        await options.refresh();
    });
  };
  const edit = (item: QueueItem, text: string): Promise<void> =>
    run(async () => {
      if (!queueTextValid(text, MAX_TEXT_LENGTH)) throw new Error('queue-invalid-text');
      await isBound();
      if (parseStandaloneSlashCommand(stripEncodedTaskReferenceMetadata(text).trim()) !== null)
        throw new Error(String(t('messages.manualQueue.richUnsupported')));
      await queueRepository.edit(item, text);
    });
  const remove = (item: QueueItem): Promise<void> =>
    run(async () => {
      await isBound();
      await queueRepository.remove(item);
    });
  const check = (item: QueueItem): Promise<void> =>
    run(async () => {
      if (item.state !== 'unknown' || !item.attempt) return;
      await isBound();
      const epoch = captureContextScopedRequestEpoch();
      const page = await api.teams.getMessagesPage(item.scope.teamName, {
        limit: 100,
        ...(item.route.kind === 'group' ? { groupChatId: item.route.groupChatId } : {}),
      });
      await isBound();
      if (!isContextScopedRequestEpochCurrent(epoch)) throw new Error('rootUnavailable');
      if (
        page.messages.some(
          (entry) =>
            entry.from === 'user' &&
            entry.messageId === item.attempt!.messageId &&
            (item.route.kind === 'group'
              ? entry.groupChatId === item.route.groupChatId
              : !entry.groupChatId && entry.to?.trim().toLowerCase() === item.route.participant)
        )
      ) {
        await queueRepository.remove(item);
        if (identityRef.current === identity && isContextScopedRequestEpochCurrent(epoch))
          await options.refresh();
      } else throw new Error(String(t('messages.manualQueue.notFound')));
    });
  const blockedReason = (item: QueueItem): string | null =>
    !scope || switching
      ? String(t('messages.manualQueue.rootUnavailable'))
      : options.blockedReason(item);
  return {
    onEnqueue: enqueue,
    unavailableReason:
      options.unavailableReason ||
      (!scope ? String(t('messages.manualQueue.rootUnavailable')) : undefined),
    list: (
      <QueueList
        key={identity}
        items={items}
        busy={busy}
        error={error?.identity === identity ? error.message : null}
        blockedReason={blockedReason}
        onSend={send}
        onEdit={edit}
        onRemove={remove}
        onCheck={check}
        onCopy={async (item) => {
          await navigator.clipboard.writeText(item.attempt?.request.text ?? item.text);
        }}
      />
    ),
  };
}
