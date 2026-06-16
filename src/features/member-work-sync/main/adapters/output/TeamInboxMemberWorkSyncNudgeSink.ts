import { TeamInboxReader } from '@main/services/team/TeamInboxReader';
import { TeamInboxWriter } from '@main/services/team/TeamInboxWriter';

import type { MemberWorkSyncInboxNudgePort } from '../../../core/application';

type TeamInboxMemberWorkSyncNudgeInput = Parameters<
  MemberWorkSyncInboxNudgePort['insertIfAbsent']
>[0];
type TeamInboxMemberWorkSyncNudgeRepairInput = Parameters<
  NonNullable<MemberWorkSyncInboxNudgePort['repairIfPresent']>
>[0];

type TeamInboxMemberWorkSyncNudgeWriter = Pick<TeamInboxWriter, 'sendMessage'> &
  Partial<Pick<TeamInboxWriter, 'updateMessageText'>>;

function isStoredMemberWorkSyncNudge(
  message: Awaited<ReturnType<TeamInboxReader['getMessagesFor']>>[number]
): boolean {
  return message.messageKind === 'member_work_sync_nudge';
}

export class TeamInboxMemberWorkSyncNudgeSink implements MemberWorkSyncInboxNudgePort {
  constructor(
    private readonly inboxReader: Pick<TeamInboxReader, 'getMessagesFor'> = new TeamInboxReader(),
    private readonly inboxWriter: TeamInboxMemberWorkSyncNudgeWriter = new TeamInboxWriter(),
    private readonly controlUrlResolver?: () => Promise<string | null> | string | null
  ) {}

  async insertIfAbsent(input: TeamInboxMemberWorkSyncNudgeInput) {
    const existing = await this.inboxReader.getMessagesFor(input.teamName, input.memberName);
    const existingMessage = existing.find((message) => message.messageId === input.messageId);
    if (existingMessage) {
      if (
        existingMessage.workSyncPayloadHash !== input.payloadHash ||
        !isStoredMemberWorkSyncNudge(existingMessage)
      ) {
        return { inserted: false, messageId: input.messageId, conflict: true };
      }
      await this.repairExistingControlUrlIfNeeded(input, existingMessage.text, {
        required: Boolean(this.controlUrlResolver),
      });
      return { inserted: false, messageId: input.messageId };
    }

    const controlUrl = await this.resolveControlUrl({
      required: Boolean(this.controlUrlResolver),
    });
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

  async repairIfPresent(input: TeamInboxMemberWorkSyncNudgeRepairInput) {
    const existing = await this.inboxReader.getMessagesFor(input.teamName, input.memberName);
    const existingMessage = existing.find((message) => message.messageId === input.messageId);
    if (!existingMessage) {
      return { found: false, repaired: false };
    }
    if (
      existingMessage.workSyncPayloadHash !== input.payloadHash ||
      !isStoredMemberWorkSyncNudge(existingMessage)
    ) {
      return { found: true, repaired: false, conflict: true };
    }
    const repaired = await this.repairExistingControlUrlIfNeeded(input, existingMessage.text, {
      required: Boolean(this.controlUrlResolver),
    });
    return { found: true, repaired };
  }

  private async repairExistingControlUrlIfNeeded(
    input: TeamInboxMemberWorkSyncNudgeRepairInput,
    existingText: string | undefined,
    options: { required?: boolean } = {}
  ): Promise<boolean> {
    const controlUrl = await this.resolveControlUrl(options);
    if (!controlUrl) {
      return false;
    }
    const currentText = existingText ?? input.payload.text;
    const repairedText = this.withControlUrl(currentText, controlUrl);
    if (repairedText === currentText) {
      return false;
    }
    if (typeof this.inboxWriter.updateMessageText !== 'function') {
      if (options.required) {
        throw new Error('member work sync inbox text update unavailable');
      }
      return false;
    }
    const result = await this.inboxWriter.updateMessageText(input.teamName, {
      member: input.memberName,
      messageId: input.messageId,
      text: repairedText,
      expectedMessageKind: 'member_work_sync_nudge',
      expectedWorkSyncPayloadHash: input.payloadHash,
    });
    return result.updated;
  }

  private async resolveControlUrl(options: { required?: boolean } = {}): Promise<string | null> {
    if (!this.controlUrlResolver) {
      return null;
    }

    let value: string | null | undefined;
    try {
      value = await this.controlUrlResolver();
    } catch (error) {
      if (options.required) {
        throw new Error(`member work sync control URL unavailable: ${String(error)}`);
      }
      return null;
    }

    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
    if (options.required) {
      throw new Error('member work sync control URL unavailable');
    }
    return null;
  }

  private withControlUrl(text: string, controlUrl: string): string {
    const controlLine = `Required control API: pass controlUrl "${controlUrl}" in both member_work_sync_status and member_work_sync_report.`;
    const existingControlLine =
      /^Required control API: pass controlUrl "[^"\n]+" in both member_work_sync_status and member_work_sync_report\.$/m;
    if (existingControlLine.test(text)) {
      return text.replace(existingControlLine, controlLine);
    }
    if (text.includes(`controlUrl "${controlUrl}"`)) {
      return text;
    }
    return [text, controlLine].join('\n');
  }
}
