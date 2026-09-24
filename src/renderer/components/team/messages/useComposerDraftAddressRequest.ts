import { useEffect } from 'react';

import { normalizeConversationParticipant } from '@features/team-direct-chats/renderer';

import type { ComposerDraftAddress } from '@renderer/types/composerDraft';
import type { CrossTeamTarget } from '@shared/types';

export interface ComposerDraftAddressRequest {
  readonly address: ComposerDraftAddress;
}

interface UseComposerDraftAddressRequestOptions {
  readonly request?: ComposerDraftAddressRequest | null;
  readonly lockedRecipient?: string;
  readonly targets: readonly CrossTeamTarget[];
  readonly selectTeam: (teamName: string | null) => void;
  readonly selectMember: (memberName: string | null) => void;
}

export function canOpenComposerDraftAddress(
  address: ComposerDraftAddress,
  memberNames: ReadonlySet<string>,
  targets: readonly CrossTeamTarget[]
): boolean {
  if (address.target.kind === 'team-feed') return true;
  if (address.target.kind === 'direct') {
    const participant = normalizeConversationParticipant(address.target.participant);
    return [...memberNames].some(
      (memberName) => normalizeConversationParticipant(memberName) === participant
    );
  }
  const { toMember, toTeam } = address.target;
  const available = targets.find((target) => target.teamName === toTeam);
  return Boolean(
    available &&
      (!toMember || available.members?.some((member) => member.name === toMember))
  );
}

export function useComposerDraftAddressRequest({
  request,
  lockedRecipient,
  targets,
  selectTeam,
  selectMember,
}: UseComposerDraftAddressRequestOptions): void {
  useEffect(() => {
    const target = request?.address.target;
    if (!target || target.kind !== 'cross-team' || lockedRecipient) return;
    const available = targets.find((candidate) => candidate.teamName === target.toTeam);
    if (!available) return;
    if (target.toMember && !available.members?.some((member) => member.name === target.toMember)) {
      return;
    }
    selectTeam(target.toTeam);
    selectMember(target.toMember);
  }, [lockedRecipient, request, selectMember, selectTeam, targets]);
}
