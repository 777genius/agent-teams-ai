import { CROSS_TEAM_SOURCE } from '@shared/constants/crossTeam';

import { resolveCrossTeamRecipientIdentity } from '../CrossTeamRecipientIdentity';

import {
  isCrossTeamPseudoRecipientName,
  isCrossTeamToolRecipientName,
} from './TeamProvisioningCrossTeamRelayHelpers';

import type { OpenCodeMemberInboxDelivery } from '../opencode/delivery/OpenCodeMemberMessageDeliveryService';
import type {
  OpenCodeMemberInboxRelayOptions,
  OpenCodeMemberInboxRelayResult,
} from './TeamProvisioningOpenCodeMemberInboxRelay';
import type { InboxMessage, TeamConfig, TeamMember } from '@shared/types';

export enum LiveInboxRelayKind {
  Ignored = 'ignored',
  NativeLead = 'native_lead',
  NativeMemberNoop = 'native_member_noop',
  OpenCodeMember = 'opencode_member',
}

export interface LiveInboxRelayResult {
  kind: LiveInboxRelayKind;
  relayed: number;
  /** Exact scoped message confirmed by a native-lead relay or its recent-delivery ledger. */
  recentlyDeliveredMessageId?: string;
  /** Exact message verified in the durable inbox for a native non-lead recipient. */
  durablyStoredMessageId?: string;
  diagnostics?: string[];
  lastDelivery?: OpenCodeMemberInboxDelivery;
}

export interface RelayInboxFileToLiveRecipientInput {
  teamName: string;
  inboxName: string;
  options?: OpenCodeMemberInboxRelayOptions;
}

export interface NativeLeadInboxRelayOptions {
  onlyMessageId?: string;
}

export interface RelayInboxFileToLiveRecipientPorts {
  readConfigSnapshot(teamName: string): Promise<TeamConfig | null>;
  readMetaMembers(teamName: string): Promise<readonly TeamMember[]>;
  readInboxMessages(teamName: string, memberName: string): Promise<readonly InboxMessage[]>;
  isOpenCodeRuntimeRecipientFromSources(input: {
    memberName: string;
    config: TeamConfig | null | undefined;
    metaMembers: readonly TeamMember[];
  }): boolean;
  relayOpenCodeMemberInboxMessages(
    teamName: string,
    memberName: string,
    options: OpenCodeMemberInboxRelayOptions
  ): Promise<OpenCodeMemberInboxRelayResult>;
  relayLeadInboxMessages(teamName: string, options?: NativeLeadInboxRelayOptions): Promise<number>;
  wasRecentlyDeliveredToLead(teamName: string, messageId: string): boolean;
  hasSuccessfulLeadRecoveryMessage(teamName: string, messageId: string): boolean;
  isLeadRecoveryMessage(teamName: string, messageId: string): boolean;
  isTeamAlive(teamName: string): boolean;
}

export async function relayInboxFileToLiveRecipientWithPorts(
  input: RelayInboxFileToLiveRecipientInput,
  ports: RelayInboxFileToLiveRecipientPorts
): Promise<LiveInboxRelayResult> {
  const { teamName, inboxName } = input;
  const options = input.options ?? {};

  if (isCrossTeamPseudoRecipientName(inboxName) || isCrossTeamToolRecipientName(inboxName)) {
    return { kind: LiveInboxRelayKind.Ignored, relayed: 0 };
  }

  const [configResult, metaMembersResult] = await Promise.allSettled([
    ports.readConfigSnapshot(teamName),
    ports.readMetaMembers(teamName),
  ]);
  const config = configResult.status === 'fulfilled' ? configResult.value : null;
  const metaMembers = metaMembersResult.status === 'fulfilled' ? metaMembersResult.value : [];
  const identityReadDiagnostics = [
    ...(configResult.status === 'rejected'
      ? [`config identity read failed: ${describeError(configResult.reason)}`]
      : []),
    ...(metaMembersResult.status === 'rejected'
      ? [`metadata identity read failed: ${describeError(metaMembersResult.reason)}`]
      : []),
  ];

  if (identityReadDiagnostics.length > 0) {
    return failClosedIdentityRelay(identityReadDiagnostics);
  }

  let recipientIdentity: ReturnType<typeof resolveCrossTeamRecipientIdentity>;
  try {
    recipientIdentity = resolveCrossTeamRecipientIdentity({
      sources: { config, metaMembers },
      rawToMember: inboxName,
    });
  } catch (error) {
    return failClosedIdentityRelay([`recipient identity unavailable: ${describeError(error)}`]);
  }

  const canonicalMemberName = recipientIdentity.memberName;
  if (!isSameInboxRecipient(inboxName, canonicalMemberName)) {
    return failClosedIdentityRelay([
      `recipient identity canonicalizes to a different inbox: ${canonicalMemberName}`,
    ]);
  }

  let isOpenCodeRecipient = false;
  try {
    isOpenCodeRecipient = ports.isOpenCodeRuntimeRecipientFromSources({
      memberName: canonicalMemberName,
      config,
      metaMembers,
    });
  } catch (error) {
    return failClosedIdentityRelay([`runtime identity resolution failed: ${describeError(error)}`]);
  }

  if (isOpenCodeRecipient) {
    return projectOpenCodeMemberRelay(
      await ports.relayOpenCodeMemberInboxMessages(
        teamName,
        canonicalMemberName,
        buildOpenCodeRelayOptions(options)
      )
    );
  }

  if (recipientIdentity.isLead) {
    const leadOptions = buildNativeLeadRelayOptions(options);
    const relayed = ports.isTeamAlive(teamName)
      ? leadOptions
        ? await ports.relayLeadInboxMessages(teamName, leadOptions)
        : await ports.relayLeadInboxMessages(teamName)
      : 0;
    const recentlyDeliveredMessageId =
      leadOptions?.onlyMessageId &&
      (relayed > 0 ||
        (relayed === 0 && ports.wasRecentlyDeliveredToLead(teamName, leadOptions.onlyMessageId)))
        ? leadOptions.onlyMessageId
        : undefined;
    const responseProven = leadOptions?.onlyMessageId
      ? ports.hasSuccessfulLeadRecoveryMessage(teamName, leadOptions.onlyMessageId)
      : false;
    const isRecoveryMessage = leadOptions?.onlyMessageId
      ? ports.isLeadRecoveryMessage(teamName, leadOptions.onlyMessageId)
      : false;
    return {
      kind: LiveInboxRelayKind.NativeLead,
      relayed,
      ...(recentlyDeliveredMessageId ? { recentlyDeliveredMessageId } : {}),
      ...(leadOptions?.onlyMessageId && isRecoveryMessage
        ? {
            lastDelivery: {
              delivered: relayed > 0 || responseProven,
              accepted: relayed > 0 || responseProven,
              responsePending: !responseProven,
            },
          }
        : {}),
    };
  }

  const onlyMessageId = options.onlyMessageId?.trim();
  if (!onlyMessageId) {
    return { kind: LiveInboxRelayKind.NativeMemberNoop, relayed: 0 };
  }

  try {
    const messages = await ports.readInboxMessages(teamName, canonicalMemberName);
    const found = messages.some((message) =>
      isExactDurableCrossTeamInboxMessage(message, canonicalMemberName, onlyMessageId)
    );
    return {
      kind: LiveInboxRelayKind.NativeMemberNoop,
      relayed: 0,
      ...(found ? { durablyStoredMessageId: onlyMessageId } : {}),
      ...(!found ? { diagnostics: [`durable inbox message not found: ${onlyMessageId}`] } : {}),
    };
  } catch (error) {
    return {
      kind: LiveInboxRelayKind.NativeMemberNoop,
      relayed: 0,
      diagnostics: [
        `durable inbox verification failed: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}

function isExactDurableCrossTeamInboxMessage(
  message: InboxMessage,
  inboxName: string,
  messageId: string
): boolean {
  return (
    typeof message.messageId === 'string' &&
    message.messageId.trim() === messageId &&
    message.source === CROSS_TEAM_SOURCE &&
    typeof message.from === 'string' &&
    message.from.trim().length > 0 &&
    typeof message.to === 'string' &&
    message.to.trim().toLowerCase() === inboxName.trim().toLowerCase() &&
    typeof message.text === 'string' &&
    message.text.trim().length > 0 &&
    typeof message.timestamp === 'string' &&
    Number.isFinite(Date.parse(message.timestamp))
  );
}

function isSameInboxRecipient(inboxName: string, recipientName: string | null): boolean {
  return inboxName.trim().toLowerCase() === recipientName?.toLowerCase();
}

function failClosedIdentityRelay(diagnostics: string[]): LiveInboxRelayResult {
  return { kind: LiveInboxRelayKind.Ignored, relayed: 0, diagnostics };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildOpenCodeRelayOptions(
  options: OpenCodeMemberInboxRelayOptions
): OpenCodeMemberInboxRelayOptions {
  return {
    source: options.source ?? 'watcher',
    ...(options.onlyMessageId ? { onlyMessageId: options.onlyMessageId } : {}),
    ...(options.deliveryMetadata ? { deliveryMetadata: options.deliveryMetadata } : {}),
  };
}

function buildNativeLeadRelayOptions(
  options: OpenCodeMemberInboxRelayOptions
): NativeLeadInboxRelayOptions | undefined {
  const onlyMessageId = options.onlyMessageId?.trim();
  return onlyMessageId ? { onlyMessageId } : undefined;
}

function projectOpenCodeMemberRelay(relay: OpenCodeMemberInboxRelayResult): LiveInboxRelayResult {
  return {
    kind: LiveInboxRelayKind.OpenCodeMember,
    relayed: relay.relayed,
    diagnostics: relay.diagnostics,
    lastDelivery: relay.lastDelivery,
  };
}
