import {
  matchesExactTeamMemberName,
  matchesObservedMemberNameForExpected,
} from './TeamProvisioningMemberIdentity';
import {
  compareMemberSpawnInboxCursor,
  maxMemberSpawnInboxCursor,
  type MemberSpawnInboxCursor,
  toMemberSpawnInboxCursor,
} from './TeamProvisioningMemberSpawnCursor';
import {
  extractBootstrapFailureReason,
  extractHeartbeatTimestamp,
} from './TeamProvisioningPromptBuilders';

import type { InboxMessage } from '@shared/types';

export type LeadInboxMemberSpawnMessage = InboxMessage & { messageId: string };

export interface MemberSpawnLeadInboxRun {
  teamName: string;
  startedAt: string;
  expectedMembers: string[];
  memberSpawnLeadInboxCursorByMember: Map<string, MemberSpawnInboxCursor>;
}

export interface MemberSpawnLeadInboxPorts<TRun extends MemberSpawnLeadInboxRun> {
  getRunLeadName(run: TRun): string;
  readLeadInboxMessages(teamName: string, leadName: string): Promise<InboxMessage[]>;
  setMemberSpawnStatus(
    run: TRun,
    memberName: string,
    status: 'online' | 'error',
    error?: string,
    source?: 'heartbeat',
    heartbeatTimestamp?: string
  ): void;
}

export async function refreshMemberSpawnStatusesFromLeadInbox<
  TRun extends MemberSpawnLeadInboxRun,
>(run: TRun, ports: MemberSpawnLeadInboxPorts<TRun>): Promise<void> {
  const leadName = ports.getRunLeadName(run);
  let leadInboxMessages: InboxMessage[] = [];
  try {
    leadInboxMessages = await ports.readLeadInboxMessages(run.teamName, leadName);
  } catch {
    return;
  }

  const runStartedAtMs = Date.parse(run.startedAt);
  const expectedMembers = Array.isArray(run.expectedMembers) ? run.expectedMembers : [];
  const teammateMessages = leadInboxMessages
    .filter((message): message is LeadInboxMemberSpawnMessage => {
      const from = typeof message.from === 'string' ? message.from.trim() : '';
      if (!from || from === leadName || from === 'user' || from === 'system') return false;
      if (!resolveExpectedLaunchMemberName(expectedMembers, from)) return false;
      if (typeof message.messageId !== 'string' || message.messageId.trim().length === 0) {
        return false;
      }
      const messageTs = Date.parse(message.timestamp);
      if (
        Number.isFinite(messageTs) &&
        Number.isFinite(runStartedAtMs) &&
        messageTs < runStartedAtMs
      ) {
        return false;
      }
      return typeof message.text === 'string' && message.text.trim().length > 0;
    })
    .sort((left, right) =>
      compareMemberSpawnInboxCursor(
        { timestamp: left.timestamp, messageId: left.messageId },
        { timestamp: right.timestamp, messageId: right.messageId }
      )
    );

  const messagesByMember = new Map<string, LeadInboxMemberSpawnMessage[]>();
  for (const message of teammateMessages) {
    const memberName = resolveExpectedLaunchMemberName(expectedMembers, message.from);
    if (!memberName) {
      continue;
    }
    const bucket = messagesByMember.get(memberName) ?? [];
    bucket.push(message);
    messagesByMember.set(memberName, bucket);
  }

  for (const [memberName, messages] of messagesByMember.entries()) {
    const currentCursor = run.memberSpawnLeadInboxCursorByMember.get(memberName);
    let nextCursor = currentCursor;

    for (const message of messages) {
      const messageCursor = toMemberSpawnInboxCursor(message);
      const effectiveCursor = nextCursor ?? currentCursor;
      if (messageCursor && effectiveCursor) {
        if (compareMemberSpawnInboxCursor(messageCursor, effectiveCursor) <= 0) {
          continue;
        }
      }

      applyLeadInboxSpawnSignal(run, memberName, message, ports);
      if (messageCursor) {
        nextCursor = maxMemberSpawnInboxCursor(nextCursor, messageCursor);
      }
    }

    if (
      nextCursor &&
      (currentCursor == null || compareMemberSpawnInboxCursor(nextCursor, currentCursor) > 0)
    ) {
      run.memberSpawnLeadInboxCursorByMember.set(memberName, nextCursor);
    }
  }
}

export function applyLeadInboxSpawnSignal<TRun extends MemberSpawnLeadInboxRun>(
  run: TRun,
  memberName: string,
  message: LeadInboxMemberSpawnMessage,
  ports: Pick<MemberSpawnLeadInboxPorts<TRun>, 'setMemberSpawnStatus'>
): void {
  const reason = extractBootstrapFailureReason(message.text);
  if (reason) {
    ports.setMemberSpawnStatus(run, memberName, 'error', reason);
    return;
  }
  ports.setMemberSpawnStatus(
    run,
    memberName,
    'online',
    undefined,
    'heartbeat',
    extractHeartbeatTimestamp(message.text, message.timestamp)
  );
}

export function resolveExpectedLaunchMemberName(
  expectedMembers: readonly string[] | undefined,
  candidateName: string
): string | null {
  const trimmedCandidate = candidateName.trim();
  if (!trimmedCandidate || !Array.isArray(expectedMembers) || expectedMembers.length === 0) {
    return null;
  }

  const exact = expectedMembers.find((memberName) =>
    matchesExactTeamMemberName(memberName, trimmedCandidate)
  );
  if (exact) {
    return exact;
  }

  const matches = expectedMembers.filter((memberName) =>
    matchesObservedMemberNameForExpected(trimmedCandidate, memberName)
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}
