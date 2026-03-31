/**
 * TeamGraphAdapter — transforms Zustand TeamData → GraphDataPort.
 *
 * This is the ONLY file in this feature that imports from @renderer/store.
 * If the project data model changes, ONLY this class needs updating.
 *
 * Class-based with ES #private fields, caching, and DI-ready constructor.
 */

import { getUnreadCount } from '@renderer/services/commentReadStorage';
import { agentAvatarUrl } from '@renderer/utils/memberHelpers';
import { stripCrossTeamPrefix } from '@shared/constants/crossTeam';
import { getInboxJsonType, isInboxNoiseMessage } from '@shared/utils/inboxNoise';
import { isLeadMember } from '@shared/utils/leadDetection';

import type {
  GraphDataPort,
  GraphEdge,
  GraphNode,
  GraphNodeState,
  GraphParticle,
} from '@claude-teams/agent-graph';
import type {
  ActiveToolCall,
  InboxMessage,
  MemberSpawnStatusEntry,
  TeamData,
} from '@shared/types/team';
import type { LeadContextUsage } from '@shared/types/team';

export class TeamGraphAdapter {
  // ─── ES #private fields ──────────────────────────────────────────────────
  #lastTeamName = '';
  #lastDataHash = '';
  #cachedResult: GraphDataPort = TeamGraphAdapter.#emptyResult('');
  readonly #seenRelated = new Set<string>();
  readonly #seenMessageIds = new Set<string>();
  #initialMessagesSeen = false;
  readonly #seenCommentCounts = new Map<string, number>();
  #initialCommentsSeen = false;

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
   * Returns cached result if inputs haven't changed (referential check).
   */
  adapt(
    teamData: TeamData | null,
    teamName: string,
    spawnStatuses?: Record<string, MemberSpawnStatusEntry>,
    leadContext?: LeadContextUsage,
    pendingApprovalAgents?: Set<string>,
    activeTools?: Record<string, Record<string, ActiveToolCall>>,
    finishedVisible?: Record<string, Record<string, ActiveToolCall>>,
    toolHistory?: Record<string, ActiveToolCall[]>,
    commentReadState?: Record<string, unknown>
  ): GraphDataPort {
    if (teamData?.teamName !== teamName) {
      return TeamGraphAdapter.#emptyResult(teamName);
    }

    // Simple hash for change detection (avoids full deep equality)
    const totalComments = teamData.tasks.reduce((sum, t) => sum + (t.comments?.length ?? 0), 0);
    const memberKey = teamData.members
      .map(
        (member) =>
          `${member.name}:${member.status}:${member.currentTaskId ?? ''}:${member.role ?? ''}:${member.color ?? ''}:${member.agentType ?? ''}:${member.removedAt ?? ''}`
      )
      .sort()
      .join('|');
    const taskKey = teamData.tasks
      .map(
        (task) =>
          `${task.id}:${task.status}:${task.owner ?? ''}:${task.reviewState ?? ''}:${task.displayId ?? ''}:${task.subject}:${task.updatedAt ?? ''}`
      )
      .sort()
      .join('|');
    const processKey = teamData.processes
      .map(
        (proc) =>
          `${proc.id}:${proc.label}:${proc.registeredBy ?? ''}:${proc.url ?? ''}:${proc.stoppedAt ?? ''}`
      )
      .sort()
      .join('|');
    const messageKey = teamData.messages
      .slice(0, 25)
      .map((msg) => TeamGraphAdapter.#getMessageParticleKey(msg))
      .join('|');
    const commentKey = teamData.tasks
      .map((task) => {
        const comments = task.comments ?? [];
        const tail = comments
          .slice(Math.max(0, comments.length - 5))
          .map((comment) => `${comment.id}:${comment.author}:${comment.createdAt}`)
          .join(',');
        return `${task.id}:${comments.length}:${tail}`;
      })
      .sort()
      .join('|');
    const approvalKey = pendingApprovalAgents?.size
      ? Array.from(pendingApprovalAgents).sort().join(',')
      : '';
    const activeToolKey = activeTools
      ? Object.entries(activeTools)
          .flatMap(([memberName, tools]) =>
            Object.values(tools).map(
              (tool) =>
                `${memberName}:${tool.toolUseId}:${tool.state}:${tool.toolName}:${tool.preview ?? ''}:${tool.resultPreview ?? ''}:${tool.startedAt}:${tool.finishedAt ?? ''}`
            )
          )
          .sort()
          .join('|')
      : '';
    const finishedVisibleKey = finishedVisible
      ? Object.entries(finishedVisible)
          .flatMap(([memberName, tools]) =>
            Object.values(tools).map(
              (tool) =>
                `${memberName}:${tool.toolUseId}:${tool.state}:${tool.toolName}:${tool.preview ?? ''}:${tool.resultPreview ?? ''}:${tool.startedAt}:${tool.finishedAt ?? ''}`
            )
          )
          .sort()
          .join('|')
      : '';
    const historyKey = toolHistory
      ? Object.entries(toolHistory)
          .map(
            ([memberName, tools]) =>
              `${memberName}:${tools
                .slice(0, 3)
                .map(
                  (tool) =>
                    `${tool.toolUseId}:${tool.state}:${tool.toolName}:${tool.preview ?? ''}:${tool.resultPreview ?? ''}:${tool.startedAt}:${tool.finishedAt ?? ''}`
                )
                .join(',')}`
          )
          .sort()
          .join('|')
      : '';
    const hash = `${teamData.teamName}:${teamData.config.name ?? ''}:${teamData.config.color ?? ''}:${teamData.members.length}:${teamData.tasks.length}:${teamData.messages.length}:${teamData.processes.length}:${teamData.isAlive}:${leadContext?.percent}:${totalComments}:${memberKey}:${taskKey}:${processKey}:${messageKey}:${commentKey}:${approvalKey}:${activeToolKey}:${finishedVisibleKey}:${historyKey}:${commentReadState ? Object.keys(commentReadState).length : 0}`;
    if (hash === this.#lastDataHash && teamName === this.#lastTeamName) {
      return this.#cachedResult;
    }

    // Reset particle tracking when team changes
    if (teamName !== this.#lastTeamName) {
      this.#seenMessageIds.clear();
      this.#initialMessagesSeen = false;
      this.#seenCommentCounts.clear();
      this.#initialCommentsSeen = false;
    }

    this.#lastTeamName = teamName;
    this.#lastDataHash = hash;
    this.#seenRelated.clear();

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const particles: GraphParticle[] = [];

    const leadId = `lead:${teamName}`;
    const leadName = TeamGraphAdapter.#getLeadMemberName(teamData, teamName);

    this.#buildLeadNode(
      nodes,
      leadId,
      teamData,
      teamName,
      leadName,
      leadContext,
      activeTools,
      finishedVisible,
      toolHistory
    );
    this.#buildMemberNodes(
      nodes,
      edges,
      leadId,
      teamData,
      teamName,
      spawnStatuses,
      pendingApprovalAgents,
      activeTools,
      finishedVisible,
      toolHistory
    );
    this.#buildTaskNodes(nodes, edges, teamData, teamName, commentReadState);
    this.#buildProcessNodes(nodes, edges, teamData, teamName);
    this.#buildMessageParticles(
      particles,
      nodes,
      teamData.messages,
      teamName,
      leadId,
      leadName,
      edges
    );
    this.#buildCommentParticles(particles, teamData, teamName, leadId, leadName, edges);

    this.#cachedResult = {
      nodes,
      edges,
      particles,
      teamName,
      teamColor: teamData.config.color ?? undefined,
      isAlive: teamData.isAlive,
    };

    return this.#cachedResult;
  }

  // ─── Disposal ────────────────────────────────────────────────────────────

  [Symbol.dispose](): void {
    this.#cachedResult = TeamGraphAdapter.#emptyResult('');
    this.#seenRelated.clear();
    this.#seenMessageIds.clear();
    this.#initialMessagesSeen = false;
    this.#seenCommentCounts.clear();
    this.#initialCommentsSeen = false;
    this.#lastDataHash = '';
  }

  // ─── Private: node builders ──────────────────────────────────────────────

  static #getLeadMemberName(data: TeamData, teamName: string): string {
    return data.members.find((member) => isLeadMember(member))?.name ?? `${teamName}-lead`;
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
    data: TeamData,
    teamName: string,
    leadName: string,
    leadContext?: LeadContextUsage,
    activeTools?: Record<string, Record<string, ActiveToolCall>>,
    finishedVisible?: Record<string, Record<string, ActiveToolCall>>,
    toolHistory?: Record<string, ActiveToolCall[]>
  ): void {
    const percent = leadContext?.percent;
    const activeTool = TeamGraphAdapter.#selectVisibleTool(
      activeTools?.[leadName],
      finishedVisible?.[leadName]
    );
    nodes.push({
      id: leadId,
      kind: 'lead',
      label: data.config.name || teamName,
      state: !data.isAlive
        ? 'idle'
        : Object.keys(activeTools?.[leadName] ?? {}).length > 0
          ? 'tool_calling'
          : 'active',
      color: data.config.color ?? undefined,
      contextUsage: percent != null ? Math.max(0, Math.min(1, percent / 100)) : undefined,
      avatarUrl: agentAvatarUrl(leadName, 64),
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
      domainRef: { kind: 'lead', teamName, memberName: leadName },
    });
  }

  #buildMemberNodes(
    nodes: GraphNode[],
    edges: GraphEdge[],
    leadId: string,
    data: TeamData,
    teamName: string,
    spawnStatuses?: Record<string, MemberSpawnStatusEntry>,
    pendingApprovalAgents?: Set<string>,
    activeTools?: Record<string, Record<string, ActiveToolCall>>,
    finishedVisible?: Record<string, Record<string, ActiveToolCall>>,
    toolHistory?: Record<string, ActiveToolCall[]>
  ): void {
    for (const member of data.members) {
      if (member.removedAt) continue;
      if (isLeadMember(member)) continue;

      const memberId = `member:${teamName}:${member.name}`;
      const spawn = spawnStatuses?.[member.name];
      const activeTool = TeamGraphAdapter.#selectVisibleTool(
        activeTools?.[member.name],
        finishedVisible?.[member.name]
      );
      const hasRunningTool = Object.keys(activeTools?.[member.name] ?? {}).length > 0;

      nodes.push({
        id: memberId,
        kind: 'member',
        label: member.name,
        state: hasRunningTool
          ? 'tool_calling'
          : TeamGraphAdapter.#mapMemberStatus(member.status, spawn?.status),
        color: member.color ?? undefined,
        role: member.role ?? undefined,
        spawnStatus: spawn?.status,
        avatarUrl: agentAvatarUrl(member.name, 64),
        currentTaskId: member.currentTaskId ?? undefined,
        currentTaskSubject: member.currentTaskId
          ? data.tasks.find((t) => t.id === member.currentTaskId)?.subject
          : undefined,
        pendingApproval: pendingApprovalAgents?.has(member.name) ?? false,
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
    data: TeamData,
    teamName: string,
    commentReadState?: Record<string, unknown>
  ): void {
    // Build lookup tables for fast resolution
    const completedTaskIds = new Set<string>();
    const taskDisplayIds = new Map<string, string>();
    for (const t of data.tasks) {
      if (t.status === 'completed' || t.status === 'deleted') completedTaskIds.add(t.id);
      taskDisplayIds.set(t.id, t.displayId ?? `#${t.id.slice(0, 6)}`);
    }

    for (const task of data.tasks) {
      if (task.status === 'deleted') continue;
      const taskId = `task:${teamName}:${task.id}`;
      const ownerMemberId = task.owner ? `member:${teamName}:${task.owner}` : null;

      // Task is blocked if any blockedBy task is still not completed
      const isBlocked =
        (task.blockedBy?.length ?? 0) > 0 &&
        task.blockedBy!.some((id) => !completedTaskIds.has(id));

      // Resolve display IDs for dependencies
      const blockedByDisplayIds = task.blockedBy?.length
        ? task.blockedBy.map((id) => taskDisplayIds.get(id) ?? `#${id.slice(0, 6)}`)
        : undefined;
      const blocksDisplayIds = task.blocks?.length
        ? task.blocks.map((id) => taskDisplayIds.get(id) ?? `#${id.slice(0, 6)}`)
        : undefined;

      // Comment counts
      const totalCommentCount = task.comments?.length ?? 0;
      const unreadCommentCount = commentReadState
        ? getUnreadCount(
            commentReadState as Parameters<typeof getUnreadCount>[0],
            teamName,
            task.id,
            task.comments ?? []
          )
        : 0;

      nodes.push({
        id: taskId,
        kind: 'task',
        label: task.displayId ?? `#${task.id.slice(0, 6)}`,
        sublabel: task.subject,
        state: TeamGraphAdapter.#mapTaskStatus(task.status),
        taskStatus: TeamGraphAdapter.#mapTaskStatusLiteral(task.status),
        reviewState: TeamGraphAdapter.#mapReviewState(task.reviewState),
        displayId: task.displayId ?? undefined,
        ownerId: ownerMemberId,
        needsClarification: task.needsClarification ?? null,
        isBlocked,
        blockedByDisplayIds,
        blocksDisplayIds,
        totalCommentCount: totalCommentCount > 0 ? totalCommentCount : undefined,
        unreadCommentCount: unreadCommentCount > 0 ? unreadCommentCount : undefined,
        domainRef: { kind: 'task', teamName, taskId: task.id },
      });

      if (ownerMemberId) {
        edges.push({
          id: `edge:own:${ownerMemberId}:${taskId}`,
          source: ownerMemberId,
          target: taskId,
          type: 'ownership',
        });
      }

      const seenBlockEdges = new Set<string>();
      for (const blockedById of task.blockedBy ?? []) {
        const edgeId = `edge:block:task:${teamName}:${blockedById}:${taskId}`;
        if (seenBlockEdges.has(edgeId)) continue;
        seenBlockEdges.add(edgeId);
        edges.push({
          id: edgeId,
          source: `task:${teamName}:${blockedById}`,
          target: taskId,
          type: 'blocking',
        });
      }

      for (const blocksId of task.blocks ?? []) {
        const edgeId = `edge:block:${taskId}:task:${teamName}:${blocksId}`;
        if (seenBlockEdges.has(edgeId)) continue;
        seenBlockEdges.add(edgeId);
        edges.push({
          id: edgeId,
          source: taskId,
          target: `task:${teamName}:${blocksId}`,
          type: 'blocking',
        });
      }

      for (const relatedId of task.related ?? []) {
        const key = [task.id, relatedId].sort().join(':');
        if (this.#seenRelated.has(key)) continue;
        this.#seenRelated.add(key);
        edges.push({
          id: `edge:rel:${key}`,
          source: taskId,
          target: `task:${teamName}:${relatedId}`,
          type: 'related',
        });
      }
    }
  }

  #buildProcessNodes(
    nodes: GraphNode[],
    edges: GraphEdge[],
    data: TeamData,
    teamName: string
  ): void {
    for (const proc of data.processes) {
      if (proc.stoppedAt) continue;
      const procId = `process:${teamName}:${proc.id}`;
      const ownerId = proc.registeredBy ? `member:${teamName}:${proc.registeredBy}` : null;

      nodes.push({
        id: procId,
        kind: 'process',
        label: proc.label,
        state: 'active',
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

  #buildMessageParticles(
    particles: GraphParticle[],
    nodes: GraphNode[],
    messages: readonly InboxMessage[],
    teamName: string,
    leadId: string,
    leadName: string,
    edges: GraphEdge[]
  ): void {
    const ordered = [...messages].reverse();

    // First call: record all existing message IDs without creating particles.
    // This prevents old messages from spawning particles when the graph opens.
    if (!this.#initialMessagesSeen) {
      this.#initialMessagesSeen = true;
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

      // Skip comment notifications — #buildCommentParticles handles them with real text
      if (msg.summary?.startsWith('Comment on ')) continue;

      // Handle noise messages: idle shows as "idle", others (shutdown, terminated) skip entirely
      const msgText = msg.text ?? '';
      const noiseType = getInboxJsonType(msgText);
      if (noiseType === 'idle_notification') {
        // Show idle as a simple label, don't skip
      } else if (isInboxNoiseMessage(msgText)) {
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
          reverse: !isIncoming, // ghost→lead edge: incoming = forward, sent = reverse
        });
        continue;
      }

      const edgeId = TeamGraphAdapter.#resolveMessageEdge(msg, teamName, leadId, leadName, edges);
      if (!edgeId) continue;

      // Determine direction: messages FROM a teammate TO lead should reverse
      // (edges are always lead→member, but message goes member→lead)
      const fromId = TeamGraphAdapter.#resolveParticipantId(
        msg.from ?? '',
        teamName,
        leadId,
        leadName
      );
      const isFromTeammate = fromId !== leadId;

      // For idle notifications, show a clean "idle" label instead of raw JSON
      const particleLabel =
        noiseType === 'idle_notification'
          ? 'idle'
          : TeamGraphAdapter.#buildParticleLabel(msg.summary ?? msg.text, 'inbox');

      particles.push({
        id: `particle:msg:${teamName}:${msgKey}`,
        edgeId,
        progress: 0,
        kind: 'inbox_message',
        color: msg.color ?? '#66ccff',
        label: particleLabel,
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
    data: TeamData,
    teamName: string,
    leadId: string,
    leadName: string,
    edges: GraphEdge[]
  ): void {
    // First call: record current comment counts without creating particles.
    // This prevents pre-existing comments from spawning particles when the graph opens.
    if (!this.#initialCommentsSeen) {
      this.#initialCommentsSeen = true;
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
          const authorNodeId = TeamGraphAdapter.#resolveParticipantId(
            newComment.author,
            teamName,
            leadId,
            leadName
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
            });
          }
        }
      }

      this.#seenCommentCounts.set(task.id, currentCount);
    }
  }

  // ─── Static mappers ──────────────────────────────────────────────────────

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
    teamName: string,
    leadId: string,
    leadName: string,
    edges: GraphEdge[]
  ): string | null {
    const { from, to } = msg;

    if (from && to) {
      const fromId = TeamGraphAdapter.#resolveParticipantId(from, teamName, leadId, leadName);
      const toId = TeamGraphAdapter.#resolveParticipantId(to, teamName, leadId, leadName);
      return (
        edges.find((e) => e.source === fromId && e.target === toId)?.id ??
        edges.find((e) => e.source === toId && e.target === fromId)?.id ??
        null
      );
    }

    if (from && !to) {
      const fromId = TeamGraphAdapter.#resolveParticipantId(from, teamName, leadId, leadName);
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
    teamName: string,
    leadId: string,
    leadName?: string
  ): string {
    const normalized = name.trim().toLowerCase();
    if (normalized === 'user' || normalized === 'team-lead') return leadId;
    if (leadName && normalized === leadName.trim().toLowerCase()) return leadId;
    return `member:${teamName}:${name}`;
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
    let normalized = text?.replace(/\s+/g, ' ').trim();
    // Clean up raw task ID hashes like "#363e78de done|sent to review" → "done | sent to review"
    if (normalized) {
      normalized = normalized.replace(/#[a-f0-9]{6,}\s*/gi, '').trim();
      // Clean pipe separators
      normalized = normalized.replace(/\|/g, ' - ');
    }
    const prefix = kind === 'comment' ? '\u{1F4AC}' : '\u{2709}';
    if (!normalized) return prefix;
    const clipped =
      normalized.length > max
        ? `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}\u2026`
        : normalized;
    return `${prefix} ${clipped}`;
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
