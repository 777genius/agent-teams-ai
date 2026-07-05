import { randomUUID } from 'node:crypto';

import {
  collectConfirmedSameTeamPairs,
  type NativeSameTeamFingerprint,
  normalizeSameTeamText,
} from './TeamProvisioningInboxRelayPolicy';

import type { TeamInboxReader } from '../TeamInboxReader';
import type { InboxMessage } from '@shared/types';
import type { ParsedTeammateContent } from '@shared/utils/teammateMessageParser';

type TimeoutHandle = ReturnType<typeof setTimeout>;

export interface TeamProvisioningSameTeamNativeDeliveryPorts {
  inboxReader: Pick<TeamInboxReader, 'getMessagesFor'>;
  relayedLeadInboxMessageIds: Map<string, Set<string>>;
  pendingTimeouts: Map<string, TimeoutHandle>;
  markInboxMessagesRead(
    teamName: string,
    leadName: string,
    messages: { messageId: string }[]
  ): Promise<void>;
  relayLeadInboxMessages(teamName: string): Promise<unknown>;
  trimRelayedSet(set: Set<string>): Set<string>;
  warn(message: string): void;
  nowMs(): number;
  randomId(): string;
  setTimeout(handler: () => void, ms: number): TimeoutHandle;
}

export interface TeamProvisioningSameTeamNativeDeliveryConfig {
  fingerprintTtlMs: number;
  matchWindowMs: number;
  nativeDeliveryGraceMs: number;
  persistRetryMs: number;
}

export function createTeamProvisioningSameTeamNativeDeliveryPorts(
  ports: Omit<TeamProvisioningSameTeamNativeDeliveryPorts, 'nowMs' | 'randomId' | 'setTimeout'> &
    Partial<Pick<TeamProvisioningSameTeamNativeDeliveryPorts, 'nowMs' | 'randomId' | 'setTimeout'>>
): TeamProvisioningSameTeamNativeDeliveryPorts {
  return {
    ...ports,
    nowMs: ports.nowMs ?? (() => Date.now()),
    randomId: ports.randomId ?? (() => randomUUID()),
    setTimeout: ports.setTimeout ?? ((handler, ms) => setTimeout(handler, ms)),
  };
}

export class TeamProvisioningSameTeamNativeDelivery {
  constructor(
    private readonly config: TeamProvisioningSameTeamNativeDeliveryConfig,
    private readonly ports: TeamProvisioningSameTeamNativeDeliveryPorts,
    private readonly recentFingerprints = new Map<string, NativeSameTeamFingerprint[]>()
  ) {}

  delete(teamName: string): void {
    this.recentFingerprints.delete(teamName);
  }

  rememberSameTeamNativeFingerprints(teamName: string, blocks: ParsedTeammateContent[]): void {
    const teamKey = teamName.trim();
    const existing = this.recentFingerprints.get(teamKey) ?? [];
    const now = this.ports.nowMs();
    const cutoff = now - this.config.fingerprintTtlMs;
    const fresh = existing.filter((fp) => fp.seenAt > cutoff);

    for (const block of blocks) {
      fresh.push({
        id: this.ports.randomId(),
        from: block.teammateId.trim(),
        text: normalizeSameTeamText(block.content),
        summary: (block.summary ?? '').trim(),
        seenAt: now,
      });
    }

    this.recentFingerprints.set(teamKey, fresh);
  }

  consumeMatchedSameTeamFingerprints(teamName: string, matchedIds: Set<string>): void {
    if (matchedIds.size === 0) return;
    const teamKey = teamName.trim();
    const current = this.recentFingerprints.get(teamKey) ?? [];
    if (current.length === 0) return;
    const remaining = current.filter((fp) => !matchedIds.has(fp.id));
    if (remaining.length > 0) {
      this.recentFingerprints.set(teamKey, remaining);
    } else {
      this.recentFingerprints.delete(teamKey);
    }
  }

  getFreshSameTeamNativeFingerprints(teamName: string): NativeSameTeamFingerprint[] {
    const all = this.recentFingerprints.get(teamName) ?? [];
    if (all.length === 0) return [];
    const cutoff = this.ports.nowMs() - this.config.fingerprintTtlMs;
    const fresh = all.filter((fp) => fp.seenAt > cutoff);
    if (fresh.length !== all.length) {
      if (fresh.length > 0) {
        this.recentFingerprints.set(teamName, fresh);
      } else {
        this.recentFingerprints.delete(teamName);
      }
    }
    return fresh;
  }

  async confirmSameTeamNativeMatches(
    teamName: string,
    leadName: string,
    messages: InboxMessage[]
  ): Promise<{ nativeMatchedMessageIds: Set<string>; persisted: boolean }> {
    const fingerprints = this.getFreshSameTeamNativeFingerprints(teamName);
    const { confirmedMessageIds, matchedFingerprintIds } = collectConfirmedSameTeamPairs({
      messages,
      fingerprints,
      leadName,
      matchWindowMs: this.config.matchWindowMs,
    });

    if (confirmedMessageIds.size === 0) {
      return { nativeMatchedMessageIds: confirmedMessageIds, persisted: true };
    }

    const toMarkRead = Array.from(confirmedMessageIds, (messageId) => ({ messageId }));
    let persisted = false;
    try {
      await this.ports.markInboxMessagesRead(teamName, leadName, toMarkRead);
      persisted = true;
    } catch {
      // Keep fingerprints alive for the next attempt.
    }

    if (persisted) {
      const relayedIds = this.ports.relayedLeadInboxMessageIds.get(teamName) ?? new Set<string>();
      for (const messageId of confirmedMessageIds) {
        relayedIds.add(messageId);
      }
      this.ports.relayedLeadInboxMessageIds.set(teamName, this.ports.trimRelayedSet(relayedIds));
      this.consumeMatchedSameTeamFingerprints(teamName, matchedFingerprintIds);
    }

    return { nativeMatchedMessageIds: confirmedMessageIds, persisted };
  }

  async reconcileSameTeamNativeDeliveries(teamName: string, leadName: string): Promise<void> {
    let leadInboxMessages: Awaited<ReturnType<TeamInboxReader['getMessagesFor']>> = [];
    try {
      leadInboxMessages = await this.ports.inboxReader.getMessagesFor(teamName, leadName);
    } catch {
      return;
    }

    const { nativeMatchedMessageIds, persisted } = await this.confirmSameTeamNativeMatches(
      teamName,
      leadName,
      leadInboxMessages
    );
    if (nativeMatchedMessageIds.size > 0 && !persisted) {
      this.scheduleSameTeamPersistRetry(teamName);
    }
  }

  scheduleSameTeamDeferredRetry(teamName: string): void {
    this.scheduleRetry(
      `same-team-deferred:${teamName}`,
      teamName,
      this.config.nativeDeliveryGraceMs + 1_000,
      'deferred'
    );
  }

  scheduleSameTeamPersistRetry(teamName: string): void {
    this.scheduleRetry(
      `same-team-persist:${teamName}`,
      teamName,
      this.config.persistRetryMs,
      'persist'
    );
  }

  private scheduleRetry(
    key: string,
    teamName: string,
    delayMs: number,
    kind: 'deferred' | 'persist'
  ): void {
    if (this.ports.pendingTimeouts.has(key)) return;

    const timer = this.ports.setTimeout(() => {
      this.ports.pendingTimeouts.delete(key);
      void this.ports
        .relayLeadInboxMessages(teamName)
        .catch((error: unknown) =>
          this.ports.warn(`[${teamName}] same-team ${kind} retry failed: ${String(error)}`)
        );
    }, delayMs);

    this.ports.pendingTimeouts.set(key, timer);
  }
}
