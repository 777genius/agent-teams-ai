import 'fake-indexeddb/auto';

import {
  composerDraftReadwrite,
  requestValue,
} from '../../../src/renderer/services/composerDraftIndexedDb';
import { composerWorkingSummary } from '../../../src/renderer/services/composerDraftWorkingSummary';
import {
  composerDraftAddressKey,
  composerWorkingIndexKey,
} from '../../../src/renderer/utils/composerDraftIdentity';

import type {
  QueueRoute,
  QueueScope,
} from '../../../src/features/manual-message-queue/core/domain/queue';
import type { ComposerWorkingRecord } from '../../../src/renderer/types/composerDraft';

export const directRoute: QueueRoute = { kind: 'direct', participant: 'bob', agentId: 'bob-1' };
export const scope: QueueScope = {
  transport: 'desktop-local-teams-v1',
  root: '/sandbox/local/.claude',
  contextId: 'local',
  host: null,
  teamName: 'test-team',
  chat: 'direct:bob',
};
export function working(text: string, route: QueueRoute = directRoute): ComposerWorkingRecord {
  return {
    version: 2,
    address: {
      contextId: scope.contextId,
      teamName: scope.teamName,
      target:
        route.kind === 'direct'
          ? { kind: 'direct', participant: route.participant }
          : { kind: 'group', groupChatId: route.groupChatId },
    },
    workingRevision: crypto.randomUUID(),
    updatedAt: Date.now(),
    editorContext: { kind: 'plain' },
    content: {
      text,
      chips: [],
      attachments: [],
      actionMode: 'do',
      ...(route.kind === 'group'
        ? {
            groupRecipient:
              route.recipientName === null
                ? { kind: 'all' as const }
                : { kind: 'member' as const, memberName: route.recipientName },
          }
        : {}),
    },
  };
}
export async function seed(record: ComposerWorkingRecord): Promise<void> {
  await composerDraftReadwrite(async (store) => {
    store.put(record, composerDraftAddressKey(record.address));
    store.put(
      { version: 1, summaries: [composerWorkingSummary(record)] },
      composerWorkingIndexKey(record.address.contextId, record.address.teamName)
    );
  });
}
export const readWorking = (record: ComposerWorkingRecord) =>
  composerDraftReadwrite((store) =>
    requestValue(store.get(composerDraftAddressKey(record.address)))
  );
export const clearStore = () =>
  composerDraftReadwrite(async (store) => {
    store.clear();
  });
