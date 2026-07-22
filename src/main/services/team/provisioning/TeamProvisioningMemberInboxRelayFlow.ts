import {
  armSilentTeammateForward,
  forgetPendingInboxRelayCandidates,
  type InboxRelayCandidateRunState,
  isInboxRelayInFlightTimeoutError,
  rememberPendingInboxRelayCandidates,
  type SilentTeammateForwardRunState,
  waitForInboxRelayInFlight,
} from './TeamProvisioningInboxRelayCandidates';
import {
  buildMemberInboxRelayPrompt,
  DEFAULT_INBOX_RELAY_BATCH_SIZE,
  hasStableInboxMessageId,
  type RelayInboxMessage,
  selectMemberInboxRelayBatch,
  splitMemberInboxRelayUnread,
} from './TeamProvisioningInboxRelayPolicy';

import type { InboxMessage } from '@shared/types';

export interface RelayMemberInboxMessagesInput {
  teamName: string;
  memberName: string;
  relayKey: string;
}

export interface MemberInboxRelayFlowRun
  extends InboxRelayCandidateRunState,
    SilentTeammateForwardRunState {
  child: unknown | null;
  processKilled: boolean;
  cancelRequested: boolean;
  provisioningComplete: boolean;
}

export interface MemberInboxRelayFlowLogger {
  debug(message: string): void;
  warn(message: string): void;
}

export interface RelayMemberInboxMessagesPorts<TRun extends MemberInboxRelayFlowRun> {
  inFlight: Map<string, Promise<number>>;
  getAliveRunId(teamName: string): string | null | undefined;
  getRun(runId: string): TRun | undefined;
  isCurrentTrackedRun(run: TRun): boolean;
  readInboxMessages(teamName: string, memberName: string): Promise<readonly InboxMessage[]>;
  markInboxMessagesRead(
    teamName: string,
    memberName: string,
    messages: RelayInboxMessage[]
  ): Promise<void>;
  sendMessageToRun(run: TRun, message: string): Promise<void>;
  hasAcceptedMemberWorkSyncReport(input: {
    teamName: string;
    memberName: string;
  }): Promise<boolean>;
  relayedMemberInboxMessageIds: Map<string, Set<string>>;
  trimRelayedSet(relayedIds: Set<string>): Set<string>;
  logger: MemberInboxRelayFlowLogger;
  nowIso(): string;
  getErrorMessage(error: unknown): string;
}

export async function relayMemberInboxMessagesWithPorts<TRun extends MemberInboxRelayFlowRun>(
  input: RelayMemberInboxMessagesInput,
  ports: RelayMemberInboxMessagesPorts<TRun>
): Promise<number> {
  const { teamName, relayKey } = input;
  const existing = ports.inFlight.get(relayKey);
  if (existing) {
    try {
      return await waitForInboxRelayInFlight({
        promise: existing,
        relayName: 'member_inbox_relay',
        relayKey,
      });
    } catch (error) {
      if (!isInboxRelayInFlightTimeoutError(error)) {
        throw error;
      }
      ports.logger.warn(`[${teamName}] member_inbox_relay_timed_out: ${ports.getErrorMessage(error)}`);
      return 0;
    } finally {
      if (ports.inFlight.get(relayKey) === existing) {
        ports.inFlight.delete(relayKey);
      }
    }
  }

  const work = runMemberInboxRelayWork(input, ports);

  ports.inFlight.set(relayKey, work);
  try {
    return await waitForInboxRelayInFlight({
      promise: work,
      relayName: 'member_inbox_relay',
      relayKey,
    });
  } catch (error) {
    if (!isInboxRelayInFlightTimeoutError(error)) {
      throw error;
    }
    ports.logger.warn(`[${teamName}] member_inbox_relay_timed_out: ${ports.getErrorMessage(error)}`);
    return 0;
  } finally {
    if (ports.inFlight.get(relayKey) === work) {
      ports.inFlight.delete(relayKey);
    }
  }
}

async function runMemberInboxRelayWork<TRun extends MemberInboxRelayFlowRun>(
  input: RelayMemberInboxMessagesInput,
  ports: RelayMemberInboxMessagesPorts<TRun>
): Promise<number> {
  const { teamName, memberName, relayKey } = input;
  const runId = ports.getAliveRunId(teamName);
  if (!runId) return 0;
  const run = ports.getRun(runId);
  if (!run?.child || run.processKilled || run.cancelRequested) return 0;
  if (!run.provisioningComplete) return 0;
  const isStaleRelayRun = (): boolean =>
    !ports.isCurrentTrackedRun(run) || !run.child || run.processKilled || run.cancelRequested;

  const relayedIds = ports.relayedMemberInboxMessageIds.get(relayKey) ?? new Set<string>();

  let memberInboxMessages: readonly InboxMessage[] = [];
  try {
    memberInboxMessages = await ports.readInboxMessages(teamName, memberName);
  } catch {
    return 0;
  }
  if (isStaleRelayRun()) return 0;

  const unread = memberInboxMessages
    .filter((m): m is RelayInboxMessage => {
      if (m.read) return false;
      if (typeof m.text !== 'string' || m.text.trim().length === 0) return false;
      if (!hasStableInboxMessageId(m)) return false;
      return !relayedIds.has(m.messageId);
    })
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  if (unread.length === 0) return 0;

  const { passiveIdleUnread, actionableUnread, readOnlyIgnoredUnread } =
    splitMemberInboxRelayUnread(unread);
  if (isStaleRelayRun()) return 0;

  if (readOnlyIgnoredUnread.length > 0) {
    try {
      await ports.markInboxMessagesRead(teamName, memberName, readOnlyIgnoredUnread);
      if (passiveIdleUnread.length > 0) {
        ports.logger.debug(
          `[${teamName}] member relay marked ${passiveIdleUnread.length} passive idle message(s) read without relay for ${memberName}`
        );
      }
    } catch (error) {
      ports.logger.debug(
        `[${teamName}] member relay failed to mark ${readOnlyIgnoredUnread.length} ignored inbox message(s) read for ${memberName}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  if (actionableUnread.length === 0) return 0;

  const batch = selectMemberInboxRelayBatch(actionableUnread, DEFAULT_INBOX_RELAY_BATCH_SIZE);

  armSilentTeammateForward(run, memberName, 'member_inbox_relay', ports.nowIso());
  const rememberedRelayIds = rememberPendingInboxRelayCandidates(run, memberName, batch);

  const message = buildMemberInboxRelayPrompt({ memberName, batch });

  try {
    await ports.sendMessageToRun(run, message);
  } catch {
    forgetPendingInboxRelayCandidates(run, memberName, rememberedRelayIds);
    return 0;
  }

  const readCommitBatch: RelayInboxMessage[] = [];
  for (const m of batch) {
    if (m.messageKind !== 'member_work_sync_nudge') {
      readCommitBatch.push(m);
      relayedIds.add(m.messageId);
      continue;
    }
    if (await ports.hasAcceptedMemberWorkSyncReport({ teamName, memberName })) {
      readCommitBatch.push(m);
      relayedIds.add(m.messageId);
    }
  }
  ports.relayedMemberInboxMessageIds.set(relayKey, ports.trimRelayedSet(relayedIds));

  if (readCommitBatch.length > 0) {
    try {
      await ports.markInboxMessagesRead(teamName, memberName, readCommitBatch);
    } catch {
      // Best-effort: relay succeeded; marking read failed.
    }
  }

  return batch.length;
}
