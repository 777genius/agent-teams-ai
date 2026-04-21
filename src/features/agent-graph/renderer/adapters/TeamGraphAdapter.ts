/**
 * TeamGraphAdapter — transforms store-backed team graph input → GraphDataPort.
 *
 * This adapter owns the graph projection from team runtime state into the
 * reusable package port model. Renderer hooks may still read store state, but
 * projection rules stay here so the mapping logic has one main reason to change.
 *
 * Class-based with ES #private fields and DI-ready constructor.
 */

import { getUnreadCount } from '@renderer/services/commentReadStorage';
import {
  agentAvatarUrl,
  buildMemberAvatarMap,
  buildMemberLaunchPresentation,
  getMemberRuntimeAdvisoryLabel,
  resolveMemberAvatarUrl,
} from '@renderer/utils/memberHelpers';
import { buildTeamProvisioningPresentation } from '@renderer/utils/teamProvisioningPresentation';
import { formatTeamRuntimeSummary } from '@renderer/utils/teamRuntimeSummary';
import { stripCrossTeamPrefix } from '@shared/constants/crossTeam';
import {
  classifyIdleNotificationText,
  getIdleGraphLabel,
} from '@shared/utils/idleNotificationSemantics';
import { isInboxNoiseMessage } from '@shared/utils/inboxNoise';
import { isLeadMember } from '@shared/utils/leadDetection';
import { buildOrderedVisibleTeamGraphOwnerIds } from '@shared/utils/teamGraphDefaultLayout';

import {
  buildInlineActivityEntries,
  getGraphLeadMemberName,
} from '../../core/domain/buildInlineActivityEntries';
import { collapseOverflowStacksWithMeta } from '../../core/domain/collapseOverflowStacks';
import {
  buildGraphMemberNodeIdAliasMap,
  buildGraphMemberNodeIdForMember,
  getGraphStableOwnerId,
  GRAPH_STABLE_SLOT_LAYOUT_VERSION,
} from '../../core/domain/graphOwnerIdentity';
import {
  isTaskBlocked,
  isTaskInReviewCycle,
  resolveTaskReviewer,
} from '../../core/domain/taskGraphSemantics';

import type {
  GraphDataPort,
  GraphEdge,
  GraphLayoutPort,
  GraphNode,
  GraphNodeState,
  GraphOwnerSlotAssignment,
  GraphParticle,
} from '@claude-teams/agent-graph';
import type {
  ActiveToolCall,
  InboxMessage,
  LeadActivityState,
  MemberSpawnStatusEntry,
  MemberSpawnStatusesSnapshot,
  ResolvedTeamMember,
  TeamProcess,
  TeamProvisioningProgress,
  TeamViewSnapshot,
} from '@shared/types/team';
import type { LeadContextUsage } from '@shared/types/team';

export interface TeamGraphData extends TeamViewSnapshot {
  members: ResolvedTeamMember[];
  messageFeed: InboxMessage[];
}

export class TeamGraphAdapter {
  // ─── ES #private fields ──────────────────────────────────────────────────
  #lastTeamName = '';
  readonly #seenRelated = new Set<string>();
  readonly #seenMessageIds = new Set<string>();
  #initialMessagesSeen = false;
  #messageParticleCutoffMs: number | null = null;
  readonly #seenCommentCounts = new Map<string, number>();
  #initialCommentsSeen = false;
  #commentParticleCutoffMs: number | null = null;

  // ─── Static factory ──────────────────────────────────────────────────────
  static create(): TeamGraphAdapter {
    return new TeamGraphAdapter();
  }

  static #emptyResult(teamName: string): GraphDataPort {
    return { nodes: [], edges: [], particles: [], teamName, isAlive: false };
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Adapt team data into a GraphDataPort snapshot.
   */
  adapt(
    teamData: TeamGraphData | null,
    teamName: string,
    spawnStatuses?: Record<string, MemberSpawnStatusEntry>,
    leadActivity?: LeadActivityState,
    leadContext?: LeadContextUsage,
    pendingApprovalAgents?: Set<string>,
    activeTools?: Record<string, Record<string, ActiveToolCall>>,
    finishedVisible?: Record<string, Record<string, ActiveToolCall>>,
    toolHistory?: Record<string, ActiveToolCall[]>,
    commentReadState?: Record<string, unknown>,
    provisioningProgress?: TeamProvisioningProgress | null,
    memberSpawnSnapshot?: MemberSpawnStatusesSnapshot,
    slotAssignments?: Record<string, GraphOwnerSlotAssignment>
  ): GraphDataPort {
    if (teamData?.teamName !== teamName) {
      return TeamGraphAdapter.#emptyResult(teamName);
    }

    const duplicateStableOwnerIds = TeamGraphAdapter.#collectDuplicateStableOwnerIds(
      teamData.members.filter((member) => !member.removedAt && !isLeadMember(member))
    );
    if (duplicateStableOwnerIds.length > 0) {
      console.error(
        `[agent-graph] duplicate stable owner ids in team=${teamName}: ${duplicateStableOwnerIds.join(', ')}`
      );
      return TeamGraphAdapter.#emptyResult(teamName);
    }

    // Reset particle tracking when team changes
    if (teamName !== this.#lastTeamName) {
      this.#seenMessageIds.clear();
      this.#initialMessagesSeen = false;
      this.#messageParticleCutoffMs = null;
      this.#seenCommentCounts.clear();
      this.#initialCommentsSeen = false;
      this.#commentParticleCutoffMs = null;
    }

    this.#lastTeamName = teamName;
    this.#seenRelated.clear();

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const particles: GraphParticle[] = [];

    const leadId = `lead:${teamName}`;
    const leadName = TeamGraphAdapter.#getLeadMemberName(teamData, teamName);
    const memberNodeIdByAlias = TeamGraphAdapter.#buildMemberNodeIdByAlias(teamData, teamName);
    const avatarMap = buildMemberAvatarMap(teamData.members);
    const provisioningPresentation = buildTeamProvisioningPresentation({
      progress: provisioningProgress,
      members: teamData.members,
      memberSpawnStatuses: spawnStatuses,
      memberSpawnSnapshot,
    });
    const isTeamProvisioning = provisioningPresentation?.isActive ?? false;
    const isLaunchSettling = provisioningPresentation?.hasMembersStillJoining ?? false;

    this.#buildLeadNode(
      nodes,
      leadId,
      teamData,
      teamName,
      leadName,
      avatarMap,
      pendingApprovalAgents,
      leadActivity,
      leadContext,
      activeTools,
      finishedVisible,
      toolHistory,
      isTeamProvisioning
    );
    this.#buildMemberNodes(
      nodes,
      edges,
      leadId,
      teamData,
      teamName,
      memberNodeIdByAlias,
      avatarMap,
      spawnStatuses,
      pendingApprovalAgents,
      activeTools,
      finishedVisible,
      toolHistory,
      isTeamProvisioning,
      isLaunchSettling
    );
    this.#buildTaskNodes(
      nodes,
      edges,
      teamData,
      teamName,
      commentReadState,
      memberNodeIdByAlias,
      leadId,
      leadName
    );
    this.#buildProcessNodes(nodes, edges, teamData, teamName, memberNodeIdByAlias);
    this.#attachActivityFeeds(nodes, teamData, teamName, leadId, leadName);
    this.#buildMessageParticles(
      particles,
      nodes,
      teamData.messageFeed,
      teamName,
      leadId,
      leadName,
      edges,
      memberNodeIdByAlias
    );
    this.#buildCommentParticles(
      particles,
      teamData,
      teamName,
      leadId,
      leadName,
      edges,
      memberNodeIdByAlias
    );

    return {
      nodes,
      edges,
      particles,
      teamName,
      teamColor: teamData.config.color ?? undefined,
      isAlive: teamData.isAlive,
      layout: TeamGraphAdapter.#buildLayoutPort(teamData, teamName, slotAssignments),
    };
  }

  // ─── Disposal ────────────────────────────────────────────────────────────

  [Symbol.dispose](): void {
    this.#seenRelated.clear();
    this.#seenMessageIds.clear();
    this.#initialMessagesSeen = false;
    this.#messageParticleCutoffMs = null;
    this.#seenCommentCounts.clear();
    this.#initialCommentsSeen = false;
    this.#commentParticleCutoffMs = null;
    this.#lastTeamName = '';
  }

  // ─── Private: node builders ──────────────────────────────────────────────

  static #getLeadMemberName(data: TeamGraphData, teamName: string): string {
    return getGraphLeadMemberName(data, teamName);
  }

  static #buildMemberNodeIdByAlias(data: TeamGraphData, teamName: string): Map<string, string> {
    return buildGraphMemberNodeIdAliasMap(
      teamName,
      data.members.filter((member) => !isLeadMember(member))
    );
  }

  static #buildLayoutPort(
    data: TeamGraphData,
    teamName: string,
    slotAssignments?: Record<string, GraphOwnerSlotAssignment>
  ): GraphLayoutPort {
    const ownerOrder: string[] = [];
    const seenOwnerNodeIds = new Set<string>();
    const visibleMembers = data.members.filter(
      (member) => !member.removedAt && !isLeadMember(member)
    );
    const visibleMemberByStableOwnerId = new Map(
      visibleMembers.map((member) => [getGraphStableOwnerId(member), member] as const)
    );
    const canonicalVisibleOwnerIds = buildOrderedVisibleTeamGraphOwnerIds(
      data.members,
      data.config.members ?? []
    );
    const assignedStableOwnerIds = new Set(Object.keys(slotAssignments ?? {}));

    const pushMember = (member: TeamGraphData['members'][number] | undefined): void => {
      if (!member) {
        return;
      }
      const nodeId = buildGraphMemberNodeIdForMember(teamName, member);
      if (seenOwnerNodeIds.has(nodeId)) {
        return;
      }
      seenOwnerNodeIds.add(nodeId);
      ownerOrder.push(nodeId);
    };

    for (const stableOwnerId of canonicalVisibleOwnerIds) {
      const visibleMember = visibleMemberByStableOwnerId.get(stableOwnerId);
      if (!visibleMember) {
        continue;
      }
      if (!assignedStableOwnerIds.has(stableOwnerId)) {
        continue;
      }
      pushMember(visibleMember);
    }

    for (const stableOwnerId of canonicalVisibleOwnerIds) {
      const visibleMember = visibleMemberByStableOwnerId.get(stableOwnerId);
      if (!visibleMember) {
        continue;
      }
      if (assignedStableOwnerIds.has(stableOwnerId)) {
        continue;
      }
      pushMember(visibleMember);
    }

    const normalizedAssignments: Record<string, GraphOwnerSlotAssignment> = {};
    for (const member of visibleMembers) {
      const stableOwnerId = getGraphStableOwnerId(member);
      const assignment = slotAssignments?.[stableOwnerId];
      if (!assignment) {
        continue;
      }
      normalizedAssignments[buildGraphMemberNodeIdForMember(teamName, member)] = assignment;
    }

    return {
      version: GRAPH_STABLE_SLOT_LAYOUT_VERSION,
      ownerOrder,
      slotAssignments: normalizedAssignments,
    };
  }

  static #collectDuplicateStableOwnerIds(
    members: readonly TeamGraphData['members'][number][]
  ): string[] {
    const counts = new Map<string, number>();
    for (const member of members) {
      const stableOwnerId = getGraphStableOwnerId(member);
      counts.set(stableOwnerId, (counts.get(stableOwnerId) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .filter(([, count]) => count > 1)
      .map(([stableOwnerId]) => stableOwnerId)
      .sort((left, right) => left.localeCompare(right));
  }

  static #isBeforeParticleCutoff(timestamp: string | undefined, cutoffMs: number | null): boolean {
    if (!timestamp || cutoffMs == null) {
      return false;
    }
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) && parsed < cutoffMs;
  }

  static #getRuntimeLabel(
    providerId: ResolvedTeamMember['providerId'],
    model: ResolvedTeamMember['model'],
    effort: ResolvedTeamMember['effort']
  ): string | undefined {
    return formatTeamRuntimeSummary(providerId, model, effort);
  }

  static #selectVisibleTool(
    runningTools?: Record<string, ActiveToolCall>,
    finishedTools?: Record<string, ActiveToolCall>
  ): ActiveToolCall | undefined {
    const newestRunning = Object.values(runningTools ?? {}).sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt)
    )[0];
    if (newestRunning) return newestRunning;
    return Object.values(finishedTools ?? {}).sort((a, b) =>
      (b.finishedAt ?? '').localeCompare(a.finishedAt ?? '')
    )[0];
  }

  #buildLeadNode(
    nodes: GraphNode[],
    leadId: string,
    data: TeamGraphData,
    teamName: string,
    leadName: string,
    avatarMap: ReadonlyMap<string, string>,
    pendingApprovalAgents?: Set<string>,
    leadActivity?: LeadActivityState,
    leadContext?: LeadContextUsage,
    activeTools?: Record<string, Record<string, ActiveToolCall>>,
    finishedVisible?: Record<string, Record<string, ActiveToolCall>>,
    toolHistory?: Record<string, ActiveToolCall[]>,
    isTeamProvisioning = false
  ): void {
    const percent = leadContext?.contextUsedPercent;
    const leadMember = data.members.find((member) => member.name === leadName);
    const activeTool = TeamGraphAdapter.#selectVisibleTool(
      activeTools?.[leadName],
      finishedVisible?.[leadName]
    );
    const hasRunningTool = Object.keys(activeTools?.[leadName] ?? {}).length > 0;
    const pendingApproval =
      pendingApprovalAgents?.has(leadName) || pendingApprovalAgents?.has('lead') || false;
    const leadLaunchPresentation = leadMember
      ? buildMemberLaunchPresentation({
          member: leadMember,
          spawnStatus: undefined,
          spawnLaunchState: undefined,
          spawnLivenessSource: undefined,
          spawnRuntimeAlive: undefined,
          runtimeAdvisory: leadMember.runtimeAdvisory,
          isLaunchSettling: false,
          isTeamAlive: data.isAlive,
          isTeamProvisioning,
          leadActivity,
        })
      : null;
    const leadState =
      leadActivity === 'offline'
        ? 'terminated'
        : leadActivity === 'idle'
          ? 'idle'
          : hasRunningTool
            ? 'tool_calling'
            : 'active';
    const leadException =
      leadActivity === 'offline'
        ? { exceptionTone: 'error' as const, exceptionLabel: 'offline' }
        : pendingApproval
          ? { exceptionTone: 'warning' as const, exceptionLabel: 'awaiting approval' }
          : undefined;
    nodes.push({
      id: leadId,
      kind: 'lead',
      label: data.config.name || teamName,
      state: leadState,
      color: data.config.color ?? undefined,
      runtimeLabel: TeamGraphAdapter.#getRuntimeLabel(
        leadMember?.providerId,
        leadMember?.model,
        leadMember?.effort
      ),
      launchVisualState: leadLaunchPresentation?.launchVisualState ?? undefined,
      launchStatusLabel: leadLaunchPresentation?.launchStatusLabel ?? undefined,
      contextUsage: percent != null ? Math.max(0, Math.min(1, percent / 100)) : undefined,
      avatarUrl: leadMember
        ? resolveMemberAvatarUrl(leadMember, avatarMap, 64)
        : agentAvatarUrl(leadName, 64),
      pendingApproval,
      activeTool: activeTool
        ? {
            name: activeTool.toolName,
            preview: activeTool.preview,
            state: activeTool.state,
            startedAt: activeTool.startedAt,
            finishedAt: activeTool.finishedAt,
            resultPreview: activeTool.resultPreview,
            source: activeTool.source,
          }
        : undefined,
      recentTools: (toolHistory?.[leadName] ?? [])
        .filter((tool) => tool.state !== 'running' && !!tool.finishedAt)
        .slice(0, 5)
        .map((tool) => ({
          name: tool.toolName,
          preview: tool.preview,
          state: tool.state === 'error' ? 'error' : 'complete',
          startedAt: tool.startedAt,
          finishedAt: tool.finishedAt!,
          resultPreview: tool.resultPreview,
          source: tool.source,
        })),
      ...leadException,
      domainRef: { kind: 'lead', teamName, memberName: leadName },
    });
  }

  #buildMemberNodes(
    nodes: GraphNode[],
    edges: GraphEdge[],
    leadId: string,
    data: TeamGraphData,
    teamName: string,
    memberNodeIdByAlias: ReadonlyMap<string, string>,
    avatarMap: ReadonlyMap<string, string>,
    spawnStatuses?: Record<string, MemberSpawnStatusEntry>,
    pendingApprovalAgents?: Set<string>,
    activeTools?: Record<string, Record<string, ActiveToolCall>>,
    finishedVisible?: Record<string, Record<string, ActiveToolCall>>,
    toolHistory?: Record<string, ActiveToolCall[]>,
    isTeamProvisioning = false,
    isLaunchSettling = false
  ): void {
    for (const member of data.members) {
      if (member.removedAt) continue;
      if (isLeadMember(member)) continue;

      const memberId =
        memberNodeIdByAlias.get(member.name) ?? buildGraphMemberNodeIdForMember(teamName, member);
      const spawn = spawnStatuses?.[member.name];
      const activeTool = TeamGraphAdapter.#selectVisibleTool(
        activeTools?.[member.name],
        finishedVisible?.[member.name]
      );
      const hasRunningTool = Object.keys(activeTools?.[member.name] ?? {}).length > 0;
      const exception = TeamGraphAdapter.#buildMemberException(
        member.runtimeAdvisory,
        member.providerId,
        spawn,
        pendingApprovalAgents?.has(member.name) ?? false
      );
      const launchPresentation = buildMemberLaunchPresentation({
        member,
        spawnStatus: spawn?.status,
        spawnLaunchState: spawn?.launchState,
        spawnLivenessSource: spawn?.livenessSource,
        spawnRuntimeAlive: spawn?.runtimeAlive,
        runtimeAdvisory: member.runtimeAdvisory,
        isLaunchSettling,
        isTeamAlive: data.isAlive,
        isTeamProvisioning,
      });

      nodes.push({
        id: memberId,
        kind: 'member',
        label: member.name,
        state: hasRunningTool
          ? 'tool_calling'
          : TeamGraphAdapter.#mapMemberStatus(member.status, spawn?.status),
        color: member.color ?? undefined,
        role: member.role ?? undefined,
        runtimeLabel: TeamGraphAdapter.#getRuntimeLabel(
          member.providerId,
          member.model,
          member.effort
        ),
        spawnStatus: spawn?.status,
        launchVisualState: launchPresentation.launchVisualState ?? undefined,
        launchStatusLabel: launchPresentation.launchStatusLabel ?? undefined,
        avatarUrl: resolveMemberAvatarUrl(member, avatarMap, 64),
        currentTaskId: member.currentTaskId ?? undefined,
        currentTaskSubject: member.currentTaskId
          ? data.tasks.find((t) => t.id === member.currentTaskId)?.subject
          : undefined,
        pendingApproval: pendingApprovalAgents?.has(member.name) ?? false,
        exceptionTone: exception?.exceptionTone,
        exceptionLabel: exception?.exceptionLabel,
        activeTool: activeTool
          ? {
              name: activeTool.toolName,
              preview: activeTool.preview,
              state: activeTool.state,
              startedAt: activeTool.startedAt,
              finishedAt: activeTool.finishedAt,
              resultPreview: activeTool.resultPreview,
              source: activeTool.source,
            }
          : undefined,
        recentTools: (toolHistory?.[member.name] ?? [])
          .filter((tool) => tool.state !== 'running' && !!tool.finishedAt)
          .slice(0, 5)
          .map((tool) => ({
            name: tool.toolName,
            preview: tool.preview,
            state: tool.state === 'error' ? 'error' : 'complete',
            startedAt: tool.startedAt,
            finishedAt: tool.finishedAt!,
            resultPreview: tool.resultPreview,
            source: tool.source,
          })),
        domainRef: { kind: 'member', teamName, memberName: member.name },
      });

      edges.push({
        id: `edge:parent:${leadId}:${memberId}`,
        source: leadId,
        target: memberId,
        type: 'parent-child',
      });
    }
  }

  #buildTaskNodes(
    nodes: GraphNode[],
    edges: GraphEdge[],
    data: TeamGraphData,
    teamName: string,
    commentReadState?: Record<string, unknown>,
    memberNodeIdByAlias?: ReadonlyMap<string, string>,
    leadId?: string,
    leadName?: string
  ): void {
    const taskStateById = new Map<string, Pick<TeamGraphData['tasks'][number], 'status'>>();
    const taskDisplayIds = new Map<string, string>();
    const memberColorByName = new Map<string, string>();

    for (const t of data.tasks) {
      taskStateById.set(t.id, { status: t.status });
      taskDisplayIds.set(t.id, t.displayId ?? `#${t.id.slice(0, 6)}`);
    }
    for (const member of data.members) {
      if (member.color) {
        memberColorByName.set(member.name, member.color);
      }
    }

    const rawTaskNodes: GraphNode[] = [];

    for (const task of data.tasks) {
      if (task.status === 'deleted') continue;
      const taskId = `task:${teamName}:${task.id}`;
      const ownerMemberId =
        leadId && memberNodeIdByAlias
          ? TeamGraphAdapter.#resolveTaskOwnerId(task.owner, leadId, leadName, memberNodeIdByAlias)
          : task.owner
            ? (memberNodeIdByAlias?.get(task.owner) ?? null)
            : null;
      const kanbanTaskState = data.kanbanState.tasks[task.id];
      const reviewerName = resolveTaskReviewer(task, kanbanTaskState);
      const isReviewCycle = isTaskInReviewCycle(task);

      const taskStatus = TeamGraphAdapter.#mapTaskStatusLiteral(task.status);
      const reviewState = TeamGraphAdapter.#mapReviewState(task.reviewState);

      const blockedByDisplayIds = task.blockedBy?.length
        ? task.blockedBy.map((id) => taskDisplayIds.get(id) ?? `#${id.slice(0, 6)}`)
        : undefined;
      const blocksDisplayIds = task.blocks?.length
        ? task.blocks.map((id) => taskDisplayIds.get(id) ?? `#${id.slice(0, 6)}`)
        : undefined;

      const totalCommentCount = task.comments?.length ?? 0;
      const unreadCommentCount = commentReadState
        ? getUnreadCount(
            commentReadState as Parameters<typeof getUnreadCount>[0],
            teamName,
            task.id,
            task.comments ?? []
          )
        : 0;

      rawTaskNodes.push({
        id: taskId,
        kind: 'task',
        label: task.displayId ?? `#${task.id.slice(0, 6)}`,
        sublabel: task.subject,
        state: TeamGraphAdapter.#mapTaskStatus(task.status),
        taskStatus,
        reviewState,
        reviewerName: isReviewCycle ? reviewerName : null,
        reviewMode: isReviewCycle ? (reviewerName ? 'assigned' : 'manual') : undefined,
        reviewerColor: reviewerName ? memberColorByName.get(reviewerName) : undefined,
        changePresence:
          task.changePresence === 'needs_attention' ? 'has_changes' : task.changePresence,
        displayId: task.displayId ?? undefined,
        ownerId: ownerMemberId,
        needsClarification: task.needsClarification ?? null,
        isBlocked: isTaskBlocked(task, taskStateById),
        blockedByDisplayIds,
        blocksDisplayIds,
        totalCommentCount: totalCommentCount > 0 ? totalCommentCount : undefined,
        unreadCommentCount: unreadCommentCount > 0 ? unreadCommentCount : undefined,
        domainRef: { kind: 'task', teamName, taskId: task.id },
      });
    }

    const { visibleNodes: visibleTaskNodes, visibleNodeIdByTaskId } =
      collapseOverflowStacksWithMeta(rawTaskNodes, teamName, 5);
    const visibleTaskIds = new Set(
      visibleTaskNodes.flatMap((taskNode) =>
        taskNode.domainRef.kind === 'task' ? [taskNode.domainRef.taskId] : []
      )
    );

    nodes.push(...visibleTaskNodes);

    for (const taskNode of visibleTaskNodes) {
      if (!taskNode.ownerId) continue;
      edges.push({
        id: `edge:own:${taskNode.ownerId}:${taskNode.id}`,
        source: taskNode.ownerId,
        target: taskNode.id,
        type: 'ownership',
      });
    }

    const seenBlockingRelations = new Set<string>();
    const blockingEdges = new Map<
      string,
      {
        source: string;
        target: string;
        aggregateCount: number;
        sourceTaskIds: Set<string>;
        targetTaskIds: Set<string>;
      }
    >();
    const addBlockingRelation = (blockerId: string, blockedId: string): void => {
      if (blockerId === blockedId) return;
      const rawRelationKey = `${blockerId}->${blockedId}`;
      if (seenBlockingRelations.has(rawRelationKey)) return;
      seenBlockingRelations.add(rawRelationKey);

      const sourceNodeId = visibleNodeIdByTaskId.get(blockerId);
      const targetNodeId = visibleNodeIdByTaskId.get(blockedId);
      if (!sourceNodeId || !targetNodeId || sourceNodeId === targetNodeId) {
        return;
      }

      const edgeId = TeamGraphAdapter.#buildBlockingEdgeId(sourceNodeId, targetNodeId);
      const existing = blockingEdges.get(edgeId);
      if (existing) {
        existing.aggregateCount += 1;
        existing.sourceTaskIds.add(blockerId);
        existing.targetTaskIds.add(blockedId);
        return;
      }
      blockingEdges.set(edgeId, {
        source: sourceNodeId,
        target: targetNodeId,
        aggregateCount: 1,
        sourceTaskIds: new Set([blockerId]),
        targetTaskIds: new Set([blockedId]),
      });
    };

    for (const task of data.tasks) {
      if (task.status === 'deleted') continue;
      const taskNodeId = `task:${teamName}:${task.id}`;

      for (const blockerId of task.blockedBy ?? []) {
        addBlockingRelation(blockerId, task.id);
      }

      for (const blockedId of task.blocks ?? []) {
        addBlockingRelation(task.id, blockedId);
      }

      if (!visibleTaskIds.has(task.id)) continue;

      for (const relatedId of task.related ?? []) {
        if (!visibleTaskIds.has(relatedId)) continue;
        const key =
          task.id.localeCompare(relatedId) <= 0
            ? `${task.id}:${relatedId}`
            : `${relatedId}:${task.id}`;
        if (this.#seenRelated.has(key)) continue;
        this.#seenRelated.add(key);
        edges.push({
          id: `edge:rel:${key}`,
          source: taskNodeId,
          target: `task:${teamName}:${relatedId}`,
          type: 'related',
        });
      }
    }

    edges.push(
      ...Array.from(blockingEdges.entries()).map(([edgeId, edge]) => ({
        id: edgeId,
        source: edge.source,
        target: edge.target,
        type: 'blocking' as const,
        aggregateCount: edge.aggregateCount,
        sourceTaskIds: Array.from(edge.sourceTaskIds),
        targetTaskIds: Array.from(edge.targetTaskIds),
        label:
          edge.aggregateCount > 1 &&
          (edge.source.includes(':overflow:') || edge.target.includes(':overflow:'))
            ? `${edge.aggregateCount} hidden blocking links`
            : undefined,
      }))
    );
  }

  #buildProcessNodes(
    nodes: GraphNode[],
    edges: GraphEdge[],
    data: TeamGraphData,
    teamName: string,
    memberNodeIdByAlias?: ReadonlyMap<string, string>
  ): void {
    for (const { process: proc, ownerId } of TeamGraphAdapter.#selectRelevantProcesses(
      data.processes,
      memberNodeIdByAlias
    )) {
      const procId = `process:${teamName}:${proc.id}`;

      nodes.push({
        id: procId,
        kind: 'process',
        label: proc.label,
        state: 'active',
        ownerId,
        processUrl: proc.url ?? undefined,
        processRegisteredBy: proc.registeredBy ?? undefined,
        processCommand: proc.command ?? undefined,
        processRegisteredAt: proc.registeredAt,
        domainRef: { kind: 'process', teamName, processId: proc.id },
      });

      if (ownerId) {
        edges.push({
          id: `edge:proc:${ownerId}:${procId}`,
          source: ownerId,
          target: procId,
          type: 'ownership',
        });
      }
    }
  }

  static #selectRelevantProcesses(
    processes: readonly TeamProcess[],
    memberNodeIdByAlias?: ReadonlyMap<string, string>
  ): { process: TeamProcess; ownerId: string }[] {
    const selectedByOwnerId = new Map<string, TeamProcess>();

    for (const process of processes) {
      const ownerId = process.registeredBy
        ? (memberNodeIdByAlias?.get(process.registeredBy) ?? null)
        : null;
      if (!ownerId) {
        continue;
      }

      const existing = selectedByOwnerId.get(ownerId);
      if (!existing || TeamGraphAdapter.#compareProcessPriority(process, existing) < 0) {
        selectedByOwnerId.set(ownerId, process);
      }
    }

    return Array.from(selectedByOwnerId.entries()).map(([ownerId, process]) => ({
      process,
      ownerId,
    }));
  }

  static #compareProcessPriority(left: TeamProcess, right: TeamProcess): number {
    const leftRank = left.stoppedAt ? 1 : 0;
    const rightRank = right.stoppedAt ? 1 : 0;
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }

    const leftTimestamp = left.stoppedAt ?? left.registeredAt;
    const rightTimestamp = right.stoppedAt ?? right.registeredAt;
    if (leftTimestamp !== rightTimestamp) {
      return rightTimestamp.localeCompare(leftTimestamp);
    }

    return left.id.localeCompare(right.id);
  }

  #attachActivityFeeds(
    nodes: GraphNode[],
    data: TeamGraphData,
    teamName: string,
    leadId: string,
    leadName: string
  ): void {
    const ownerNodeIds = new Set<string>();

    for (const node of nodes) {
      if (node.kind !== 'lead' && node.kind !== 'member') {
        continue;
      }
      ownerNodeIds.add(node.id);
      node.activityItems = [];
      node.activityOverflowCount = 0;
    }

    const entriesByOwnerNodeId = buildInlineActivityEntries({
      data: {
        ...data,
        messages: data.messageFeed,
      },
      teamName,
      leadId,
      leadName,
      ownerNodeIds,
    });

    for (const node of nodes) {
      if (node.kind !== 'lead' && node.kind !== 'member') {
        continue;
      }
      const activityItems = (entriesByOwnerNodeId.get(node.id) ?? []).map(
        (entry) => entry.graphItem
      );
      node.activityItems = activityItems;
      node.activityOverflowCount = Math.max(0, activityItems.length - 3);
    }
  }

  #buildMessageParticles(
    particles: GraphParticle[],
    nodes: GraphNode[],
    messages: readonly InboxMessage[],
    teamName: string,
    leadId: string,
    leadName: string,
    edges: GraphEdge[],
    memberNodeIdByAlias: ReadonlyMap<string, string>
  ): void {
    const ordered = [...messages].reverse();

    // First call: record all existing message IDs without creating particles.
    // This prevents old messages from spawning particles when the graph opens.
    if (!this.#initialMessagesSeen) {
      this.#initialMessagesSeen = true;
      this.#messageParticleCutoffMs = Date.now();
      for (const msg of ordered) {
        const msgKey = TeamGraphAdapter.#getMessageParticleKey(msg);
        this.#seenMessageIds.add(msgKey);
      }
      // Still create ghost nodes for cross-team (without particles)
      for (const msg of ordered) {
        if (msg.source === 'cross_team' || msg.source === 'cross_team_sent') {
          TeamGraphAdapter.#ensureCrossTeamNode(nodes, edges, msg, teamName, leadId);
        }
      }
      return;
    }

    // Track which ghost nodes we've already created this cycle
    const seenGhostTeams = new Set<string>();

    // Subsequent calls: only create particles for messages not yet seen.
    for (const msg of ordered) {
      const msgKey = TeamGraphAdapter.#getMessageParticleKey(msg);
      if (this.#seenMessageIds.has(msgKey)) continue;
      this.#seenMessageIds.add(msgKey);
      if (TeamGraphAdapter.#isBeforeParticleCutoff(msg.timestamp, this.#messageParticleCutoffMs)) {
        continue;
      }

      // Skip comment notifications — #buildCommentParticles handles them with real text
      if (msg.summary?.startsWith('Comment on ')) continue;

      // Handle noise messages: idle uses semantic label, others (shutdown, terminated) skip entirely
      const msgText = msg.text ?? '';
      const idleSemantic = classifyIdleNotificationText(msgText);
      if (!idleSemantic && isInboxNoiseMessage(msgText)) {
        continue; // skip shutdown_approved, teammate_terminated, shutdown_request
      }

      // Cross-team messages: create ghost node + edge + particle
      if (msg.source === 'cross_team' || msg.source === 'cross_team_sent') {
        const ghostNodeId = TeamGraphAdapter.#ensureCrossTeamNode(
          nodes,
          edges,
          msg,
          teamName,
          leadId
        );
        if (!ghostNodeId) continue;

        const edgeId = edges.find(
          (e) =>
            (e.source === ghostNodeId && e.target === leadId) ||
            (e.source === leadId && e.target === ghostNodeId)
        )?.id;
        if (!edgeId) continue;

        // incoming = from external team → lead (reverse on lead→ghost edge)
        // sent = from lead → external team (forward on lead→ghost edge)
        const isIncoming = msg.source === 'cross_team';
        const cleanText = stripCrossTeamPrefix(msg.text ?? '');
        const label = TeamGraphAdapter.#buildParticleLabel(msg.summary ?? cleanText, 'inbox');

        particles.push({
          id: `particle:msg:${teamName}:${msgKey}`,
          edgeId,
          progress: 0,
          kind: 'inbox_message',
          color: '#cc88ff',
          label,
          preview:
            getIdleGraphLabel(msg.text ?? '') ??
            TeamGraphAdapter.#buildParticlePreview(msg.summary ?? cleanText),
          reverse: !isIncoming, // ghost→lead edge: incoming = forward, sent = reverse
        });
        continue;
      }

      const edgeId = TeamGraphAdapter.#resolveMessageEdge(
        msg,
        leadId,
        leadName,
        edges,
        memberNodeIdByAlias
      );
      if (!edgeId) continue;

      // Determine direction: messages FROM a teammate TO lead should reverse
      // (edges are always lead→member, but message goes member→lead)
      const fromId = TeamGraphAdapter.#resolveParticipantId(
        msg.from ?? '',
        leadId,
        leadName,
        memberNodeIdByAlias
      );
      const isFromTeammate = fromId !== leadId;

      const particleLabel =
        getIdleGraphLabel(msgText) ??
        TeamGraphAdapter.#buildParticleLabel(msg.summary ?? msg.text, 'inbox');

      particles.push({
        id: `particle:msg:${teamName}:${msgKey}`,
        edgeId,
        progress: 0,
        kind: 'inbox_message',
        color: msg.color ?? '#66ccff',
        label: particleLabel,
        preview:
          getIdleGraphLabel(msgText) ??
          TeamGraphAdapter.#buildParticlePreview(msg.summary ?? msg.text),
        reverse: isFromTeammate,
      });
    }

    // Also ensure ghost nodes exist for ALL cross-team messages (not just new ones)
    for (const msg of ordered) {
      if (msg.source === 'cross_team' || msg.source === 'cross_team_sent') {
        const extTeam = TeamGraphAdapter.#extractExternalTeamName(msg.from ?? '');
        if (extTeam && !seenGhostTeams.has(extTeam)) {
          seenGhostTeams.add(extTeam);
          TeamGraphAdapter.#ensureCrossTeamNode(nodes, edges, msg, teamName, leadId);
        }
      }
    }
  }

  #buildCommentParticles(
    particles: GraphParticle[],
    data: TeamGraphData,
    teamName: string,
    leadId: string,
    leadName: string,
    edges: GraphEdge[],
    memberNodeIdByAlias: ReadonlyMap<string, string>
  ): void {
    // First call: record current comment counts without creating particles.
    // This prevents pre-existing comments from spawning particles when the graph opens.
    if (!this.#initialCommentsSeen) {
      this.#initialCommentsSeen = true;
      this.#commentParticleCutoffMs = Date.now();
      for (const task of data.tasks) {
        this.#seenCommentCounts.set(task.id, task.comments?.length ?? 0);
      }
      return;
    }

    // Build a member color lookup for assigning particle colors
    const memberColors = new Map<string, string>();
    for (const member of data.members) {
      if (member.color) memberColors.set(member.name, member.color);
    }

    for (const task of data.tasks) {
      if (task.status === 'deleted') continue;

      const prevCount = this.#seenCommentCounts.get(task.id) ?? 0;
      const currentCount = task.comments?.length ?? 0;

      if (currentCount > prevCount) {
        for (let index = prevCount; index < currentCount; index += 1) {
          const newComment = task.comments?.[index];
          if (!newComment) continue;
          if (
            TeamGraphAdapter.#isBeforeParticleCutoff(
              newComment.createdAt,
              this.#commentParticleCutoffMs
            )
          ) {
            continue;
          }
          const authorNodeId = TeamGraphAdapter.#resolveParticipantId(
            newComment.author,
            leadId,
            leadName,
            memberNodeIdByAlias
          );
          const taskNodeId = `task:${teamName}:${task.id}`;
          const authorEdge =
            edges.find((e) => e.source === authorNodeId && e.target === taskNodeId) ??
            edges.find((e) => e.source === taskNodeId && e.target === authorNodeId);

          const edgeId =
            authorEdge?.id ??
            (() => {
              const syntheticEdgeId = `edge:msg:${authorNodeId}:${taskNodeId}`;
              if (!edges.some((edge) => edge.id === syntheticEdgeId)) {
                edges.push({
                  id: syntheticEdgeId,
                  source: authorNodeId,
                  target: taskNodeId,
                  type: 'message',
                });
              }
              return syntheticEdgeId;
            })();

          if (authorNodeId) {
            particles.push({
              id: `particle:comment:${teamName}:${task.id}:${index + 1}`,
              edgeId,
              progress: 0,
              kind: 'task_comment',
              color: memberColors.get(newComment.author) ?? '#cc88ff',
              label: TeamGraphAdapter.#buildParticleLabel(newComment.text, 'comment'),
              preview: TeamGraphAdapter.#buildParticlePreview(newComment.text),
            });
          }
        }
      }

      this.#seenCommentCounts.set(task.id, currentCount);
    }
  }

  // ─── Static mappers ──────────────────────────────────────────────────────

  static #buildBlockingEdgeId(sourceNodeId: string, targetNodeId: string): string {
    return `edge:block:${sourceNodeId}:${targetNodeId}`;
  }

  static #buildMemberException(
    runtimeAdvisory: ResolvedTeamMember['runtimeAdvisory'],
    providerId: ResolvedTeamMember['providerId'],
    spawn: MemberSpawnStatusEntry | undefined,
    pendingApproval: boolean
  ): Pick<GraphNode, 'exceptionTone' | 'exceptionLabel'> | undefined {
    if (spawn?.launchState === 'failed_to_start' || spawn?.status === 'error') {
      return { exceptionTone: 'error', exceptionLabel: 'spawn failed' };
    }
    if (pendingApproval) {
      return { exceptionTone: 'warning', exceptionLabel: 'awaiting approval' };
    }
    if (spawn?.status === 'waiting' || spawn?.status === 'spawning') {
      return { exceptionTone: 'warning', exceptionLabel: 'starting' };
    }
    const runtimeAdvisoryLabel = getMemberRuntimeAdvisoryLabel(runtimeAdvisory, providerId);
    if (runtimeAdvisoryLabel) {
      return {
        exceptionTone: 'warning',
        exceptionLabel: runtimeAdvisoryLabel,
      };
    }
    return undefined;
  }

  static #mapMemberStatus(status: string, spawnStatus?: string): GraphNodeState {
    if (spawnStatus === 'spawning') return 'thinking';
    if (spawnStatus === 'error') return 'error';
    if (spawnStatus === 'waiting') return 'waiting';
    switch (status) {
      case 'active':
        return 'active';
      case 'idle':
        return 'idle';
      case 'terminated':
        return 'terminated';
      default:
        return 'idle';
    }
  }

  static #mapTaskStatus(status: string): GraphNodeState {
    switch (status) {
      case 'pending':
        return 'waiting';
      case 'in_progress':
        return 'active';
      case 'completed':
        return 'complete';
      default:
        return 'idle';
    }
  }

  static #mapTaskStatusLiteral(
    status: string
  ): 'pending' | 'in_progress' | 'completed' | 'deleted' {
    switch (status) {
      case 'pending':
        return 'pending';
      case 'in_progress':
        return 'in_progress';
      case 'completed':
        return 'completed';
      case 'deleted':
        return 'deleted';
      default:
        return 'pending';
    }
  }

  static #mapReviewState(state: string | undefined): 'none' | 'review' | 'needsFix' | 'approved' {
    switch (state) {
      case 'review':
        return 'review';
      case 'needsFix':
        return 'needsFix';
      case 'approved':
        return 'approved';
      default:
        return 'none';
    }
  }

  static #resolveMessageEdge(
    msg: InboxMessage,
    leadId: string,
    leadName: string,
    edges: GraphEdge[],
    memberNodeIdByAlias: ReadonlyMap<string, string>
  ): string | null {
    const { from, to } = msg;

    if (from && to) {
      const fromId = TeamGraphAdapter.#resolveParticipantId(
        from,
        leadId,
        leadName,
        memberNodeIdByAlias
      );
      const toId = TeamGraphAdapter.#resolveParticipantId(
        to,
        leadId,
        leadName,
        memberNodeIdByAlias
      );
      return (
        edges.find((e) => e.source === fromId && e.target === toId)?.id ??
        edges.find((e) => e.source === toId && e.target === fromId)?.id ??
        null
      );
    }

    if (from && !to) {
      const fromId = TeamGraphAdapter.#resolveParticipantId(
        from,
        leadId,
        leadName,
        memberNodeIdByAlias
      );
      return (
        edges.find(
          (e) =>
            (e.source === leadId && e.target === fromId) ||
            (e.source === fromId && e.target === leadId)
        )?.id ?? null
      );
    }

    return null;
  }

  static #resolveParticipantId(
    name: string,
    leadId: string,
    leadName: string | undefined,
    memberNodeIdByAlias: ReadonlyMap<string, string>
  ): string {
    const normalized = name.trim().toLowerCase();
    if (normalized === 'user' || normalized === 'team-lead') return leadId;
    if (normalized === leadName?.trim().toLowerCase()) return leadId;
    return memberNodeIdByAlias.get(name) ?? leadId;
  }

  static #resolveTaskOwnerId(
    ownerName: string | null | undefined,
    leadId: string,
    leadName: string | undefined,
    memberNodeIdByAlias: ReadonlyMap<string, string>
  ): string | null {
    if (!ownerName?.trim()) {
      return null;
    }
    const normalized = ownerName.trim().toLowerCase();
    if (normalized === 'user' || normalized === 'team-lead') {
      return leadId;
    }
    if (normalized === leadName?.trim().toLowerCase()) {
      return leadId;
    }
    return memberNodeIdByAlias.get(ownerName) ?? null;
  }

  /** Extract external team name from cross-team "from" field like "team-b.alice" */
  static #extractExternalTeamName(from: string): string | null {
    const dotIdx = from.indexOf('.');
    if (dotIdx <= 0) return null;
    return from.slice(0, dotIdx);
  }

  /** Create or find ghost node + edge for an external team. Returns ghost node ID. */
  static #ensureCrossTeamNode(
    nodes: GraphNode[],
    edges: GraphEdge[],
    msg: InboxMessage,
    teamName: string,
    leadId: string
  ): string | null {
    const extTeam = TeamGraphAdapter.#extractExternalTeamName(msg.from ?? '');
    if (!extTeam) return null;

    const ghostId = `crossteam:${extTeam}`;

    // Create ghost node if not exists
    if (!nodes.some((n) => n.id === ghostId)) {
      nodes.push({
        id: ghostId,
        kind: 'crossteam',
        label: extTeam,
        state: 'active',
        color: '#cc88ff',
        domainRef: { kind: 'crossteam', teamName, externalTeamName: extTeam },
      });
    }

    // Create edge ghost↔lead if not exists
    const edgeId = `edge:crossteam:${ghostId}:${leadId}`;
    if (!edges.some((e) => e.id === edgeId)) {
      edges.push({
        id: edgeId,
        source: ghostId,
        target: leadId,
        type: 'message',
      });
    }

    return ghostId;
  }

  static #buildParticleLabel(
    text: string | undefined,
    kind: 'inbox' | 'comment',
    max = 52
  ): string | undefined {
    const normalized = TeamGraphAdapter.#normalizeParticleText(text);
    const prefix = kind === 'comment' ? '\u{1F4AC}' : '\u{2709}';
    if (!normalized) return prefix;
    const clipped =
      normalized.length > max
        ? `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}\u2026`
        : normalized;
    return `${prefix} ${clipped}`;
  }

  static #buildParticlePreview(text: string | undefined, max = 180): string | undefined {
    const normalized = TeamGraphAdapter.#normalizeParticleText(text);
    if (!normalized) return undefined;
    return normalized.length > max
      ? `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}\u2026`
      : normalized;
  }

  static #normalizeParticleText(text: string | undefined): string | undefined {
    let normalized = text?.replace(/\s+/g, ' ').trim();
    if (!normalized) return normalized;
    normalized = normalized.replace(/#[a-f0-9]{6,}\s*/gi, '').trim();
    normalized = normalized.replace(/\|/g, ' - ');
    return normalized;
  }

  static #getMessageParticleKey(msg: InboxMessage): string {
    if (msg.messageId && msg.messageId.trim().length > 0) {
      return msg.messageId;
    }
    return [msg.timestamp, msg.from ?? '', msg.to ?? '', msg.summary ?? '', msg.text ?? ''].join(
      '\u0000'
    );
  }
}
