import { buildMemberSpawnPrompt } from './TeamProvisioningPromptBuilders';

import type { TeamCreateRequest } from '@shared/types';

export interface OpenCodeMemberRestartSystemMessageInput {
  teamName: string;
  leadName: string;
  leadSessionId: string | null;
  displayName: string;
  member: TeamCreateRequest['members'][number];
  reason: 'manual_restart' | 'member_updated';
  assertStillCurrent?: () => void;
}

export interface PersistOpenCodeMemberRestartSystemMessagePorts {
  persistSentMessage(teamName: string, message: Record<string, unknown>): void;
  nowIso(): string;
  randomUUID(): string;
}

export type PersistOpenCodeMemberRestartSystemMessageUseCase = (
  input: OpenCodeMemberRestartSystemMessageInput
) => void;

export function createPersistOpenCodeMemberRestartSystemMessageUseCase(
  ports: PersistOpenCodeMemberRestartSystemMessagePorts
): PersistOpenCodeMemberRestartSystemMessageUseCase {
  return (input) => {
    const timestamp = ports.nowIso();
    const prompt = buildMemberSpawnPrompt(
      input.member,
      input.displayName,
      input.teamName,
      input.leadName,
      { restart: true }
    );
    const reasonSummary =
      input.reason === 'member_updated' ? 'after member settings update' : 'by user request';

    input.assertStillCurrent?.();
    ports.persistSentMessage(input.teamName, {
      from: input.leadName,
      to: input.member.name,
      text: prompt,
      timestamp,
      read: true,
      source: 'system_notification',
      leadSessionId: input.leadSessionId ?? undefined,
      messageId: `member-restart:${input.teamName}:${input.member.name}:${ports.randomUUID()}`,
      summary: `Restarting ${input.member.name} ${reasonSummary}`,
    });
  };
}
