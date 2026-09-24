import {
  conversationScopeKey,
  createDirectScope,
  normalizeConversationParticipant,
  TEAM_FEED_SCOPE,
} from '@features/team-direct-chats';

import type { ComposerDraftAddress, ComposerDraftTarget } from '@renderer/types/composerDraft';

const COMPOSER_V2_PREFIX = 'composer:v2';

export interface ResolveComposerDraftTargetInput {
  readonly lockedRecipient?: string;
  readonly selectedTeam: string | null;
  readonly crossTeamRecipient: string | null;
  readonly groupChatSelected: boolean;
  readonly localRecipient: string;
}

export function resolveComposerDraftTarget({
  lockedRecipient,
  selectedTeam,
  crossTeamRecipient,
  groupChatSelected,
  localRecipient,
}: ResolveComposerDraftTargetInput): ComposerDraftTarget {
  if (lockedRecipient) {
    return {
      kind: 'direct',
      participant: normalizeConversationParticipant(lockedRecipient),
    };
  }
  if (selectedTeam) {
    return {
      kind: 'cross-team',
      toTeam: selectedTeam,
      toMember: crossTeamRecipient?.trim() || null,
    };
  }
  if (groupChatSelected) {
    return { kind: 'team-feed' };
  }
  return {
    kind: 'direct',
    participant: normalizeConversationParticipant(localRecipient),
  };
}

export function composerDraftTargetKey(target: ComposerDraftTarget): string {
  if (target.kind === 'team-feed') {
    return conversationScopeKey(TEAM_FEED_SCOPE);
  }
  if (target.kind === 'direct') {
    return conversationScopeKey(createDirectScope(target.participant));
  }
  return JSON.stringify({ kind: 'cross-team', toTeam: target.toTeam, toMember: target.toMember });
}

export function composerDraftAddressKey(address: ComposerDraftAddress): string {
  return [
    COMPOSER_V2_PREFIX,
    encodeURIComponent(address.contextId),
    encodeURIComponent(address.teamName),
    'working',
    encodeURIComponent(composerDraftTargetKey(address.target)),
  ].join(':');
}

export function composerRecoveryKey(address: ComposerDraftAddress, id: string): string {
  return [
    COMPOSER_V2_PREFIX,
    encodeURIComponent(address.contextId),
    encodeURIComponent(address.teamName),
    'recovery',
    encodeURIComponent(id),
  ].join(':');
}

export function composerRecoveryIndexKey(contextId: string, teamName: string): string {
  return [
    COMPOSER_V2_PREFIX,
    encodeURIComponent(contextId),
    encodeURIComponent(teamName),
    'recovery-index',
  ].join(':');
}

export function composerWorkingIndexKey(contextId: string, teamName: string): string {
  return [
    COMPOSER_V2_PREFIX,
    encodeURIComponent(contextId),
    encodeURIComponent(teamName),
    'working-index',
  ].join(':');
}

export function composerWorkingIndexMigrationKey(contextId: string, teamName: string): string {
  return [
    COMPOSER_V2_PREFIX,
    encodeURIComponent(contextId),
    encodeURIComponent(teamName),
    'working-index-migration',
    'v1',
  ].join(':');
}

export function composerWorkingKeyPrefix(contextId: string, teamName: string): string {
  return [
    COMPOSER_V2_PREFIX,
    encodeURIComponent(contextId),
    encodeURIComponent(teamName),
    'working',
    '',
  ].join(':');
}

export function composerNamespacePrefix(contextId: string, teamName: string): string {
  return [
    COMPOSER_V2_PREFIX,
    encodeURIComponent(contextId),
    encodeURIComponent(teamName),
    '',
  ].join(':');
}

export function composerDraftNamespace(address: ComposerDraftAddress): string {
  return `${encodeURIComponent(address.contextId)}:${encodeURIComponent(address.teamName)}`;
}

export function sameComposerDraftAddress(
  left: ComposerDraftAddress,
  right: ComposerDraftAddress
): boolean {
  return composerDraftAddressKey(left) === composerDraftAddressKey(right);
}

export function describeComposerDraftTarget(target: ComposerDraftTarget): string {
  if (target.kind === 'team-feed') return 'Group';
  if (target.kind === 'direct') return target.participant;
  return target.toMember ? `${target.toTeam}/${target.toMember}` : target.toTeam;
}

export function legacyComposerKeys(teamName: string): {
  readonly unified: string;
  readonly text: string;
  readonly chips: string;
  readonly attachments: string;
} {
  return {
    unified: `composer:${teamName}`,
    text: `draft:compose:${teamName}`,
    chips: `draft:compose:${teamName}:chips`,
    attachments: `draft:compose:${teamName}:attachments`,
  };
}

export function isLegacyComposerDraftStorageKey(key: unknown): key is string {
  return typeof key === 'string' && key.startsWith('draft:compose:');
}
