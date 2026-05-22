import { TeamInboxReader } from '@main/services/team/TeamInboxReader';
import { TeamInboxWriter } from '@main/services/team/TeamInboxWriter';

import type { MemberWorkSyncInboxNudgePort } from '../../../core/application';

export class TeamInboxMemberWorkSyncNudgeSink implements MemberWorkSyncInboxNudgePort {
  constructor(
    private readonly inboxReader: Pick<TeamInboxReader, 'getMessagesFor'> = new TeamInboxReader(),
    private readonly inboxWriter: Pick<TeamInboxWriter, 'sendMessage'> = new TeamInboxWriter(),
    private readonly controlUrlResolver?: () => Promise<string | null> | string | null
  ) {}

  async insertIfAbsent(input: Parameters<MemberWorkSyncInboxNudgePort['insertIfAbsent']>[0]) {
    const existing = await this.inboxReader.getMessagesFor(input.teamName, input.memberName);
    const existingMessage = existing.find((message) => message.messageId === input.messageId);
    if (existingMessage) {
      if (existingMessage.workSyncPayloadHash !== input.payloadHash) {
        return { inserted: false, messageId: input.messageId, conflict: true };
      }
      return { inserted: false, messageId: input.messageId };
    }

    const controlUrl = await this.resolveControlUrl();
    const text = controlUrl
      ? this.withControlUrl(input.payload.text, controlUrl)
      : input.payload.text;
    const result = await this.inboxWriter.sendMessage(input.teamName, {
      member: input.memberName,
      from: input.payload.from,
      to: input.payload.to,
      messageId: input.messageId,
      timestamp: input.timestamp,
      text,
      taskRefs: input.payload.taskRefs,
      actionMode: input.payload.actionMode,
      summary: 'Work sync check',
      source: 'system_notification',
      messageKind: input.payload.messageKind,
      workSyncIntent: input.payload.workSyncIntent,
      workSyncIntentKey: input.payload.workSyncIntentKey,
      workSyncReviewRequestEventIds: input.payload.workSyncReviewRequestEventIds,
      workSyncPayloadHash: input.payloadHash,
    });

    return {
      inserted: true,
      messageId: result.messageId,
    };
  }

  private async resolveControlUrl(): Promise<string | null> {
    if (!this.controlUrlResolver) {
      return null;
    }

    try {
      const value = await this.controlUrlResolver();
      const trimmed = value?.trim();
      return trimmed ? trimmed : null;
    } catch {
      return null;
    }
  }

  private withControlUrl(text: string, controlUrl: string): string {
    if (text.includes('controlUrl')) {
      return text;
    }
    return [
      text,
      `Required control API: pass controlUrl "${controlUrl}" in both member_work_sync_status and member_work_sync_report.`,
    ].join('\n');
  }
}
