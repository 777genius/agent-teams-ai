import { parsePermissionRequest } from '@shared/utils/inboxNoise';

import { hasStableInboxMessageId } from './TeamProvisioningInboxRelayPolicy';

import type { InboxMessage } from '@shared/types';
import type { ParsedPermissionRequest } from '@shared/utils/inboxNoise';

export interface LeadPermissionScanRun {
  startedAt: string;
}

export interface LeadPermissionScanPorts<TRun extends LeadPermissionScanRun> {
  readLeadInboxMessages(teamName: string, leadName: string): Promise<InboxMessage[]>;
  handleTeammatePermissionRequest(
    run: TRun,
    permissionRequest: ParsedPermissionRequest,
    timestamp: string
  ): void;
  markInboxMessagesRead(
    teamName: string,
    leadName: string,
    messages: { messageId: string }[]
  ): Promise<void>;
}

export async function scanLeadInboxPermissionRequests<TRun extends LeadPermissionScanRun>(
  input: {
    teamName: string;
    leadName: string;
    run: TRun;
    isStaleRelayRun(): boolean;
  },
  ports: LeadPermissionScanPorts<TRun>
): Promise<'ok' | 'stale' | 'unavailable'> {
  let leadInboxMessages: InboxMessage[];
  try {
    leadInboxMessages = await ports.readLeadInboxMessages(input.teamName, input.leadName);
  } catch {
    return 'unavailable';
  }
  if (input.isStaleRelayRun()) return 'stale';

  const permMsgsToMarkRead: { messageId: string }[] = [];
  const runStartedAtMs = Date.parse(input.run.startedAt);
  for (const msg of leadInboxMessages) {
    if (typeof msg.text !== 'string') continue;
    const perm = parsePermissionRequest(msg.text);
    if (!perm) continue;
    const msgTs = Date.parse(msg.timestamp);
    if (Number.isFinite(msgTs) && Number.isFinite(runStartedAtMs) && msgTs < runStartedAtMs) {
      continue;
    }
    try {
      ports.handleTeammatePermissionRequest(input.run, perm, msg.timestamp);
    } catch {
      // best-effort — a failing permission handler must not abort the relay turn
      continue;
    }
    if (!msg.read && hasStableInboxMessageId(msg)) {
      permMsgsToMarkRead.push({ messageId: msg.messageId });
    }
  }
  if (permMsgsToMarkRead.length > 0) {
    await ports
      .markInboxMessagesRead(input.teamName, input.leadName, permMsgsToMarkRead)
      .catch(() => {});
  }
  return 'ok';
}
