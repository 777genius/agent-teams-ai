import { isLeadMember } from '@shared/utils/leadDetection';

import {
  isCrossTeamPseudoRecipientName,
  isCrossTeamToolRecipientName,
} from './TeamProvisioningCrossTeamRelayHelpers';

import type { OpenCodeMemberInboxDelivery } from '../opencode/delivery/OpenCodeMemberMessageDeliveryService';
import type {
  OpenCodeMemberInboxRelayOptions,
  OpenCodeMemberInboxRelayResult,
} from './TeamProvisioningOpenCodeMemberInboxRelay';
import type { TeamConfig, TeamMember } from '@shared/types';

export enum LiveInboxRelayKind {
  Ignored = 'ignored',
  NativeLead = 'native_lead',
  NativeMemberNoop = 'native_member_noop',
  OpenCodeMember = 'opencode_member',
}

export interface LiveInboxRelayResult {
  kind: LiveInboxRelayKind;
  relayed: number;
  diagnostics?: string[];
  lastDelivery?: OpenCodeMemberInboxDelivery;
}

export interface RelayInboxFileToLiveRecipientInput {
  teamName: string;
  inboxName: string;
  options?: OpenCodeMemberInboxRelayOptions;
}

export interface RelayInboxFileToLiveRecipientPorts {
  readConfigSnapshot(teamName: string): Promise<TeamConfig | null>;
  readMetaMembers(teamName: string): Promise<readonly TeamMember[]>;
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
  relayLeadInboxMessages(teamName: string): Promise<number>;
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

  const [config, metaMembers] = await Promise.all([
    ports.readConfigSnapshot(teamName).catch(() => null),
    ports.readMetaMembers(teamName).catch(() => []),
  ]);
  const leadName = resolveLeadName(config);
  const isOpenCodeRecipient = ports.isOpenCodeRuntimeRecipientFromSources({
    memberName: inboxName,
    config,
    metaMembers,
  });

  if (isSameInboxRecipient(inboxName, leadName)) {
    if (isOpenCodeRecipient) {
      return projectOpenCodeMemberRelay(
        await ports.relayOpenCodeMemberInboxMessages(
          teamName,
          inboxName,
          buildOpenCodeRelayOptions(options)
        )
      );
    }
    return {
      kind: LiveInboxRelayKind.NativeLead,
      relayed: ports.isTeamAlive(teamName) ? await ports.relayLeadInboxMessages(teamName) : 0,
    };
  }

  if (isOpenCodeRecipient) {
    return projectOpenCodeMemberRelay(
      await ports.relayOpenCodeMemberInboxMessages(
        teamName,
        inboxName,
        buildOpenCodeRelayOptions(options)
      )
    );
  }

  return { kind: LiveInboxRelayKind.NativeMemberNoop, relayed: 0 };
}

function resolveLeadName(config: TeamConfig | null | undefined): string | null {
  return config?.members?.find((member) => isLeadMember(member))?.name?.trim() || null;
}

function isSameInboxRecipient(inboxName: string, recipientName: string | null): boolean {
  return inboxName.trim().toLowerCase() === recipientName?.toLowerCase();
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

function projectOpenCodeMemberRelay(relay: OpenCodeMemberInboxRelayResult): LiveInboxRelayResult {
  return {
    kind: LiveInboxRelayKind.OpenCodeMember,
    relayed: relay.relayed,
    diagnostics: relay.diagnostics,
    lastDelivery: relay.lastDelivery,
  };
}
