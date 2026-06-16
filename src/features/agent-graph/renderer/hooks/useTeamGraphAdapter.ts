/**
 * React hook bridge for TeamGraphAdapter class.
 * Thin wrapper — instantiates the class adapter and calls adapt() with store data.
 */

import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { useTeamAgentRuntimeWatcher } from '@renderer/components/team/useTeamAgentRuntimeWatcher';
import { getSnapshot, subscribe } from '@renderer/services/commentReadStorage';
import { useStore } from '@renderer/store';
import {
  getCurrentProvisioningProgressForTeam,
  isTeamGraphSlotPersistenceDisabled,
  selectResolvedMembersForTeamName,
  selectTeamDataForName,
  selectTeamMessages,
} from '@renderer/store/slices/teamSlice';
import { DEFAULT_TEAM_GRAPH_LAYOUT_MODE } from '@shared/constants/teamGraphLayoutMode';
import { buildTeamGraphDefaultLayoutSeed } from '@shared/utils/teamGraphDefaultLayout';
import { useShallow } from 'zustand/react/shallow';

import { GRAPH_STABLE_SLOT_LAYOUT_VERSION } from '../../core/domain/graphOwnerIdentity';
import { TeamGraphAdapter } from '../adapters/TeamGraphAdapter';

import type { TeamGraphData } from '../adapters/TeamGraphAdapter';
import type { GraphDataPort } from '@claude-teams/agent-graph';
import type { InboxMessage, ResolvedTeamMember, ToolApprovalRequest } from '@shared/types/team';

interface UseTeamGraphAdapterOptions {
  active?: boolean;
}

const EMPTY_MEMBERS: ResolvedTeamMember[] = [];
const EMPTY_MESSAGES: InboxMessage[] = [];
const EMPTY_PENDING_APPROVALS: ToolApprovalRequest[] = [];
const EMPTY_PENDING_APPROVAL_AGENTS = new Set<string>();
const EMPTY_COMMENT_READ_STATE: Record<string, unknown> = {};

function getEmptyCommentReadState(): Record<string, unknown> {
  return EMPTY_COMMENT_READ_STATE;
}

function subscribeNoop(): () => void {
  return () => undefined;
}

function emptyGraphData(teamName: string): GraphDataPort {
  return {
    nodes: [],
    edges: [],
    particles: [],
    teamName,
    isAlive: false,
    layout: {
      version: GRAPH_STABLE_SLOT_LAYOUT_VERSION,
      mode: DEFAULT_TEAM_GRAPH_LAYOUT_MODE,
      ownerOrder: [],
      slotAssignments: {},
    },
  };
}

export function useTeamGraphAdapter(
  teamName: string,
  options?: UseTeamGraphAdapterOptions
): GraphDataPort {
  const isActive = options?.active ?? true;
  const { t } = useAppTranslation('team');
  const adapterRef = useRef<TeamGraphAdapter>(TeamGraphAdapter.create());
  const inactiveGraphData = useMemo(() => emptyGraphData(teamName), [teamName]);
  const lastActiveGraphDataRef = useRef<GraphDataPort>(inactiveGraphData);
  const adapterText = useMemo(
    () => ({
      hiddenBlockingLinks: (count: number) =>
        t('agentGraph.blockingEdge.hiddenBlockingLinks', { count }),
    }),
    [t]
  );

  const {
    teamSnapshot,
    members,
    messages,
    spawnStatuses,
    runtimeSnapshot,
    leadActivity,
    leadContext,
    pendingApprovals,
    activeTools,
    finishedVisible,
    toolHistory,
    provisioningProgress,
    memberSpawnSnapshot,
    graphLayoutMode,
    gridOwnerOrder,
    slotAssignments,
    graphLayoutSession,
    activeTaskLogActivity,
    ensureTeamGraphSlotAssignments,
  } = useStore(
    useShallow((s) => ({
      teamSnapshot: isActive ? selectTeamDataForName(s, teamName) : null,
      members: isActive ? selectResolvedMembersForTeamName(s, teamName) : EMPTY_MEMBERS,
      messages: isActive ? selectTeamMessages(s, teamName) : EMPTY_MESSAGES,
      spawnStatuses: isActive && teamName ? s.memberSpawnStatusesByTeam[teamName] : undefined,
      runtimeSnapshot: isActive && teamName ? s.teamAgentRuntimeByTeam[teamName] : undefined,
      leadActivity: isActive && teamName ? s.leadActivityByTeam[teamName] : undefined,
      leadContext: isActive && teamName ? s.leadContextByTeam[teamName] : undefined,
      pendingApprovals: isActive ? s.pendingApprovals : EMPTY_PENDING_APPROVALS,
      activeTools: isActive && teamName ? s.activeToolsByTeam[teamName] : undefined,
      finishedVisible: isActive && teamName ? s.finishedVisibleByTeam[teamName] : undefined,
      toolHistory: isActive && teamName ? s.toolHistoryByTeam[teamName] : undefined,
      provisioningProgress:
        isActive && teamName ? getCurrentProvisioningProgressForTeam(s, teamName) : null,
      memberSpawnSnapshot:
        isActive && teamName ? s.memberSpawnSnapshotsByTeam[teamName] : undefined,
      graphLayoutMode: isActive && teamName ? s.graphLayoutModeByTeam[teamName] : undefined,
      gridOwnerOrder: isActive && teamName ? s.gridOwnerOrderByTeam[teamName] : undefined,
      slotAssignments: isActive && teamName ? s.slotAssignmentsByTeam[teamName] : undefined,
      graphLayoutSession: isActive && teamName ? s.graphLayoutSessionByTeam[teamName] : undefined,
      activeTaskLogActivity:
        isActive && teamName ? s.activeTaskLogActivityByTeam[teamName] : undefined,
      ensureTeamGraphSlotAssignments: s.ensureTeamGraphSlotAssignments,
    }))
  );

  useTeamAgentRuntimeWatcher({
    teamName,
    enabled: isActive,
  });

  const pendingApprovalAgents = useMemo(() => {
    if (!isActive) {
      return EMPTY_PENDING_APPROVAL_AGENTS;
    }
    const agents = new Set<string>();
    for (const a of pendingApprovals) {
      if (a.teamName === teamName) {
        agents.add(a.source);
      }
    }
    return agents;
  }, [isActive, pendingApprovals, teamName]);

  const teamData = useMemo<TeamGraphData | null>(() => {
    if (!teamSnapshot) {
      return null;
    }
    return {
      ...teamSnapshot,
      members,
      messageFeed: messages,
      runtimeEntriesByMember: runtimeSnapshot?.members,
    };
  }, [members, messages, runtimeSnapshot?.members, teamSnapshot]);

  const commentReadState = useSyncExternalStore(
    isActive ? subscribe : subscribeNoop,
    isActive ? getSnapshot : getEmptyCommentReadState
  );

  const effectiveSlotAssignments = useMemo(() => {
    if (!teamData) {
      return slotAssignments;
    }
    if (!isTeamGraphSlotPersistenceDisabled()) {
      return slotAssignments;
    }
    if (graphLayoutSession?.mode === 'manual') {
      return slotAssignments;
    }
    const defaultSeed = buildTeamGraphDefaultLayoutSeed(
      teamData.members,
      teamData.config.members ?? []
    );
    const defaultAssignments =
      Object.keys(defaultSeed.assignments).length === 0 ? undefined : defaultSeed.assignments;
    if (!slotAssignments) {
      return defaultAssignments;
    }
    if (graphLayoutSession?.signature !== defaultSeed.signature) {
      return defaultAssignments;
    }
    const visibleAssignmentKeys = defaultSeed.orderedVisibleOwnerIds.filter(
      (stableOwnerId) => slotAssignments[stableOwnerId]
    );
    const hasExactVisibleDefaults =
      visibleAssignmentKeys.length === Object.keys(defaultSeed.assignments).length &&
      visibleAssignmentKeys.every((stableOwnerId) => {
        const currentAssignment = slotAssignments[stableOwnerId];
        const defaultAssignment = defaultSeed.assignments[stableOwnerId];
        return (
          currentAssignment?.ringIndex === defaultAssignment?.ringIndex &&
          currentAssignment.sectorIndex === defaultAssignment.sectorIndex
        );
      });
    return hasExactVisibleDefaults ? slotAssignments : defaultAssignments;
  }, [graphLayoutSession, slotAssignments, teamData]);

  useLayoutEffect(() => {
    if (!isActive || !teamName || !teamData) {
      return;
    }
    ensureTeamGraphSlotAssignments(teamName, teamData.members, teamData.config.members ?? []);
  }, [ensureTeamGraphSlotAssignments, isActive, teamData, teamName]);

  const activeGraphData = useMemo(() => {
    if (!isActive) {
      return null;
    }
    return adapterRef.current.adapt(
      teamData,
      teamName,
      spawnStatuses,
      leadActivity,
      leadContext,
      pendingApprovalAgents,
      activeTools,
      finishedVisible,
      toolHistory,
      commentReadState,
      provisioningProgress,
      memberSpawnSnapshot,
      effectiveSlotAssignments,
      graphLayoutMode ?? DEFAULT_TEAM_GRAPH_LAYOUT_MODE,
      gridOwnerOrder,
      activeTaskLogActivity,
      adapterText
    );
  }, [
    isActive,
    teamData,
    teamName,
    spawnStatuses,
    leadActivity,
    leadContext,
    pendingApprovalAgents,
    activeTools,
    finishedVisible,
    toolHistory,
    commentReadState,
    provisioningProgress,
    memberSpawnSnapshot,
    effectiveSlotAssignments,
    graphLayoutMode,
    gridOwnerOrder,
    activeTaskLogActivity,
    adapterText,
  ]);

  useLayoutEffect(() => {
    if (activeGraphData) {
      lastActiveGraphDataRef.current = activeGraphData;
    }
  }, [activeGraphData]);

  if (!isActive) {
    const lastActiveGraphData = lastActiveGraphDataRef.current;
    return lastActiveGraphData.teamName === teamName ? lastActiveGraphData : inactiveGraphData;
  }

  return activeGraphData ?? inactiveGraphData;
}
