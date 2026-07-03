import { parseCrossTeamPrefix } from '@shared/constants/crossTeam';
import {
  isMeaningfulBootstrapCheckInMessage,
  parsePermissionRequest,
} from '@shared/utils/inboxNoise';
import {
  parseAllTeammateMessages,
  type ParsedTeammateContent,
} from '@shared/utils/teammateMessageParser';

import {
  type CrossTeamDeliveredLeadBlock,
  type CrossTeamLeadInboxMatch,
  rememberRecentCrossTeamLeadDeliveryMessageIds,
  wasRecentlyDeliveredToLead,
} from './TeamProvisioningCrossTeamRelayHelpers';
import { extractBootstrapFailureReason } from './TeamProvisioningPromptBuilders';
import { extractStreamUserText } from './TeamProvisioningStreamEvents';

import type { ParsedPermissionRequest } from '@shared/utils/inboxNoise';

export interface TeamProvisioningNativeTeammateRun {
  teamName: string;
  activeCrossTeamReplyHints: Array<{
    toTeam: string;
    conversationId: string;
  }>;
}

export interface TeamProvisioningNativeTeammateMessagePorts<
  TRun extends TeamProvisioningNativeTeammateRun,
> {
  recentCrossTeamLeadDeliveryMessageIds: Map<string, Map<string, number>>;
  recentCrossTeamLeadDeliveryTtlMs: number;
  nowMs(): number;
  nowIso(): string;
  getRunLeadName(run: TRun): string;
  handleTeammatePermissionRequest(
    run: TRun,
    permissionRequest: ParsedPermissionRequest,
    timestamp: string
  ): void;
  matchCrossTeamLeadInboxMessages(
    teamName: string,
    leadName: string,
    deliveredBlocks: CrossTeamDeliveredLeadBlock[]
  ): Promise<CrossTeamLeadInboxMatch[]>;
  markInboxMessagesRead(
    teamName: string,
    leadName: string,
    messages: CrossTeamLeadInboxMatch[]
  ): Promise<void>;
  setMemberSpawnStatus(
    run: TRun,
    memberName: string,
    status: 'online' | 'error',
    error?: string,
    source?: 'heartbeat'
  ): void;
  rememberSameTeamNativeFingerprints(
    teamName: string,
    blocks: ParsedTeammateContent[]
  ): void;
  reconcileSameTeamNativeDeliveries(teamName: string, leadName: string): Promise<unknown>;
}

export function handleNativeTeammateUserMessage<
  TRun extends TeamProvisioningNativeTeammateRun,
>(
  run: TRun,
  msg: Record<string, unknown>,
  ports: TeamProvisioningNativeTeammateMessagePorts<TRun>
): void {
  const rawText = extractStreamUserText(msg);
  if (!rawText) return;

  const blocks = parseAllTeammateMessages(rawText);
  if (blocks.length === 0) return;

  for (const block of blocks) {
    const perm = parsePermissionRequest(block.content);
    if (perm) {
      ports.handleTeammatePermissionRequest(run, perm, ports.nowIso());
    }
  }

  const crossTeamBlocks = blocks.flatMap((block) => {
    const origin = parseCrossTeamPrefix(block.content);
    const sourceTeam = origin?.from.includes('.') ? origin.from.split('.', 1)[0] : null;
    const conversationId =
      origin?.conversationId?.trim() || origin?.replyToConversationId?.trim();
    if (!sourceTeam || !conversationId) return [];
    return [
      {
        teammateId: block.teammateId,
        content: block.content,
        toTeam: sourceTeam,
        conversationId,
      },
    ];
  });
  if (crossTeamBlocks.length > 0) {
    reconcileCrossTeamBlocks(run, crossTeamBlocks, ports);
  }

  const sameTeamBlocks = blocks.filter((block) => !parseCrossTeamPrefix(block.content));
  const meaningfulSameTeamBlocks = sameTeamBlocks.filter((block) =>
    isMeaningfulBootstrapCheckInMessage(block.content)
  );
  for (const block of meaningfulSameTeamBlocks) {
    ports.setMemberSpawnStatus(run, block.teammateId, 'online', undefined, 'heartbeat');
  }
  for (const block of sameTeamBlocks) {
    const bootstrapFailureReason = extractBootstrapFailureReason(block.content);
    if (!bootstrapFailureReason) continue;
    ports.setMemberSpawnStatus(run, block.teammateId, 'error', bootstrapFailureReason);
  }
  if (sameTeamBlocks.length > 0) {
    ports.rememberSameTeamNativeFingerprints(run.teamName, sameTeamBlocks);
    const leadName = ports.getRunLeadName(run);
    void ports.reconcileSameTeamNativeDeliveries(run.teamName, leadName);
  }
}

function reconcileCrossTeamBlocks<TRun extends TeamProvisioningNativeTeammateRun>(
  run: TRun,
  crossTeamBlocks: CrossTeamDeliveredLeadBlock[],
  ports: TeamProvisioningNativeTeammateMessagePorts<TRun>
): void {
  const leadName = ports.getRunLeadName(run);
  void (async () => {
    const matches = await ports.matchCrossTeamLeadInboxMessages(
      run.teamName,
      leadName,
      crossTeamBlocks
    );
    const unreadMatches = matches.filter((match) => !match.wasRead);
    if (unreadMatches.length > 0) {
      try {
        await ports.markInboxMessagesRead(run.teamName, leadName, unreadMatches);
      } catch {
        // best-effort
      }
    }
    const now = ports.nowMs();
    const freshMatches = matches.filter(
      (match) =>
        !wasRecentlyDeliveredToLead(
          ports.recentCrossTeamLeadDeliveryMessageIds,
          run.teamName,
          match.messageId,
          now,
          ports.recentCrossTeamLeadDeliveryTtlMs
        )
    );
    rememberRecentCrossTeamLeadDeliveryMessageIds(
      ports.recentCrossTeamLeadDeliveryMessageIds,
      run.teamName,
      freshMatches.map((match) => match.messageId),
      now,
      ports.recentCrossTeamLeadDeliveryTtlMs
    );
    run.activeCrossTeamReplyHints = freshMatches.map((match) => ({
      toTeam: match.toTeam,
      conversationId: match.conversationId,
    }));
  })();
}
