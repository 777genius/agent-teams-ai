import { useMemo, useRef } from 'react';

import type { ResolvedTeamMember } from '@shared/types';

function areResolvedMembersEqual(
  prev: readonly ResolvedTeamMember[],
  next: readonly ResolvedTeamMember[]
): boolean {
  if (prev === next) return true;
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    const prevMember = prev[i];
    const nextMember = next[i];
    if (
      prevMember.name !== nextMember.name ||
      prevMember.agentId !== nextMember.agentId ||
      prevMember.joinedAt !== nextMember.joinedAt ||
      prevMember.status !== nextMember.status ||
      prevMember.currentTaskId !== nextMember.currentTaskId ||
      prevMember.taskCount !== nextMember.taskCount ||
      prevMember.lastActiveAt !== nextMember.lastActiveAt ||
      prevMember.messageCount !== nextMember.messageCount ||
      prevMember.color !== nextMember.color ||
      prevMember.agentType !== nextMember.agentType ||
      prevMember.role !== nextMember.role ||
      prevMember.workflow !== nextMember.workflow ||
      prevMember.isolation !== nextMember.isolation ||
      prevMember.providerId !== nextMember.providerId ||
      prevMember.providerBackendId !== nextMember.providerBackendId ||
      prevMember.model !== nextMember.model ||
      prevMember.effort !== nextMember.effort ||
      prevMember.selectedFastMode !== nextMember.selectedFastMode ||
      JSON.stringify(prevMember.configuredRuntimeSettings) !==
        JSON.stringify(nextMember.configuredRuntimeSettings) ||
      prevMember.resolvedFastMode !== nextMember.resolvedFastMode ||
      prevMember.laneId !== nextMember.laneId ||
      prevMember.laneKind !== nextMember.laneKind ||
      prevMember.laneOwnerProviderId !== nextMember.laneOwnerProviderId ||
      prevMember.cwd !== nextMember.cwd ||
      prevMember.gitBranch !== nextMember.gitBranch ||
      prevMember.removedAt !== nextMember.removedAt ||
      !areMemberMcpPoliciesEqual(prevMember.mcpPolicy, nextMember.mcpPolicy) ||
      prevMember.runtimeAdvisory?.kind !== nextMember.runtimeAdvisory?.kind ||
      prevMember.runtimeAdvisory?.observedAt !== nextMember.runtimeAdvisory?.observedAt ||
      prevMember.runtimeAdvisory?.retryUntil !== nextMember.runtimeAdvisory?.retryUntil ||
      prevMember.runtimeAdvisory?.retryDelayMs !== nextMember.runtimeAdvisory?.retryDelayMs ||
      prevMember.runtimeAdvisory?.reasonCode !== nextMember.runtimeAdvisory?.reasonCode ||
      prevMember.runtimeAdvisory?.message !== nextMember.runtimeAdvisory?.message
    ) {
      return false;
    }
  }
  return true;
}

function areMemberMcpPoliciesEqual(
  prev: ResolvedTeamMember['mcpPolicy'],
  next: ResolvedTeamMember['mcpPolicy']
): boolean {
  if (prev === next) return true;
  if (!prev || !next) return prev === next;
  return (
    prev.mode === next.mode &&
    prev.scopes?.user === next.scopes?.user &&
    prev.scopes?.project === next.scopes?.project &&
    prev.scopes?.local === next.scopes?.local &&
    (prev.serverNames ?? []).length === (next.serverNames ?? []).length &&
    (prev.serverNames ?? []).every((serverName, index) => serverName === next.serverNames?.[index])
  );
}

export function useStableActiveMembers(
  members: readonly ResolvedTeamMember[] | undefined
): ResolvedTeamMember[] {
  const filteredMembers = useMemo(
    () => (members ?? []).filter((member) => !member.removedAt),
    [members]
  );
  const stableMembersRef = useRef(filteredMembers);

  if (!areResolvedMembersEqual(stableMembersRef.current, filteredMembers)) {
    stableMembersRef.current = filteredMembers;
  }

  return stableMembersRef.current;
}
