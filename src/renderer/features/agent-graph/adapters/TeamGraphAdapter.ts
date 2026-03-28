/**
 * TeamGraphAdapter — transforms Zustand TeamData → GraphDataPort.
 *
 * This is the ONLY file in this feature that imports from @renderer/store.
 * If the project data model changes, ONLY this class needs updating.
 *
 * Class-based with ES #private fields, caching, and DI-ready constructor.
 */

import { isLeadMember } from '@shared/utils/leadDetection';
import { agentAvatarUrl } from '@renderer/utils/memberHelpers';

import type {
  GraphDataPort,
  GraphEdge,
  GraphNode,
  GraphNodeState,
  GraphParticle,
} from '@claude-teams/agent-graph';
import type { InboxMessage, MemberSpawnStatusEntry, TeamData } from '@shared/types/team';
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
    leadContext?: LeadContextUsage
  ): GraphDataPort {
    if (teamData?.teamName !== teamName) {
      return TeamGraphAdapter.#emptyResult(teamName);
    }

    // Simple hash for change detection (avoids full deep equality)
    const totalComments = teamData.tasks.reduce((sum, t) => sum + (t.comments?.length ?? 0), 0);
    const hash = `${teamData.teamName}:${teamData.members.length}:${teamData.tasks.length}:${teamData.messages.length}:${teamData.isAlive}:${leadContext?.percent}:${totalComments}`;
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

    this.#buildLeadNode(nodes, leadId, teamData, teamName, leadContext);
    this.#buildMemberNodes(nodes, edges, leadId, teamData, teamName, spawnStatuses);
    this.#buildTaskNodes(nodes, edges, teamData, teamName);
    this.#buildProcessNodes(nodes, edges, teamData, teamName);
    this.#buildMessageParticles(particles, teamData.messages, teamName, leadId, edges);
    this.#buildCommentParticles(particles, teamData, teamName, edges);

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

  #buildLeadNode(
    nodes: GraphNode[],
    leadId: string,
    data: TeamData,
    teamName: string,
    leadContext?: LeadContextUsage
  ): void {
    const percent = leadContext?.percent;
    nodes.push({
      id: leadId,
      kind: 'lead',
      label: data.config.name || teamName,
      state: data.isAlive ? 'active' : 'idle',
      color: data.config.color ?? undefined,
      contextUsage: percent != null ? Math.max(0, Math.min(1, percent / 100)) : undefined,
      avatarUrl: agentAvatarUrl('team-lead', 64),
      domainRef: { kind: 'lead', teamName },
    });
  }

  #buildMemberNodes(
    nodes: GraphNode[],
    edges: GraphEdge[],
    leadId: string,
    data: TeamData,
    teamName: string,
    spawnStatuses?: Record<string, MemberSpawnStatusEntry>
  ): void {
    for (const member of data.members) {
      if (member.removedAt) continue;
      if (isLeadMember(member)) continue;

      const memberId = `member:${teamName}:${member.name}`;
      const spawn = spawnStatuses?.[member.name];

      nodes.push({
        id: memberId,
        kind: 'member',
        label: member.name,
        state: TeamGraphAdapter.#mapMemberStatus(member.status, spawn?.status),
        color: member.color ?? undefined,
        role: member.role ?? undefined,
        spawnStatus: spawn?.status,
        avatarUrl: agentAvatarUrl(member.name, 64),
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

  #buildTaskNodes(nodes: GraphNode[], edges: GraphEdge[], data: TeamData, teamName: string): void {
    for (const task of data.tasks) {
      if (task.status === 'deleted') continue;
      const taskId = `task:${teamName}:${task.id}`;
      const ownerMemberId = task.owner ? `member:${teamName}:${task.owner}` : null;

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
    messages: readonly InboxMessage[],
    teamName: string,
    leadId: string,
    edges: GraphEdge[]
  ): void {
    const recent = messages.slice(-20);

    // First call: record all existing message IDs without creating particles.
    // This prevents old messages from spawning particles when the graph opens.
    if (!this.#initialMessagesSeen) {
      this.#initialMessagesSeen = true;
      for (const msg of recent) {
        const msgKey = msg.messageId ?? msg.timestamp;
        this.#seenMessageIds.add(msgKey);
      }
      return;
    }

    // Subsequent calls: only create particles for messages not yet seen.
    for (const msg of recent) {
      const msgKey = msg.messageId ?? msg.timestamp;
      if (this.#seenMessageIds.has(msgKey)) continue;
      this.#seenMessageIds.add(msgKey);

      const edgeId = TeamGraphAdapter.#resolveMessageEdge(msg, teamName, leadId, edges);
      if (!edgeId) continue;

      const ts = typeof msg.timestamp === 'string' ? new Date(msg.timestamp).getTime() : 0;
      particles.push({
        id: `particle:msg:${msgKey}`,
        edgeId,
        progress: (ts % 800) / 1000,
        kind: 'message',
        color: msg.color ?? '#66ccff',
        label: msg.summary ?? undefined,
      });
    }
  }

  #buildCommentParticles(
    particles: GraphParticle[],
    data: TeamData,
    teamName: string,
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

      if (currentCount > prevCount && prevCount > 0) {
        // New comment(s) detected — create a particle from the author to the task
        const newComment = task.comments![currentCount - 1];
        const authorNodeId = `member:${teamName}:${newComment.author}`;
        const taskNodeId = `task:${teamName}:${task.id}`;
        const authorEdge = edges.find((e) => e.source === authorNodeId && e.target === taskNodeId);

        if (authorEdge) {
          particles.push({
            id: `particle:comment:${task.id}:${currentCount}`,
            edgeId: authorEdge.id,
            progress: 0,
            kind: 'message',
            color: memberColors.get(newComment.author) ?? '#cc88ff',
            label: '\u{1F4AC}',
          });
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
    edges: GraphEdge[]
  ): string | null {
    const { from, to } = msg;

    if (from && to) {
      const fromId = TeamGraphAdapter.#resolveParticipantId(from, teamName, leadId);
      const toId = TeamGraphAdapter.#resolveParticipantId(to, teamName, leadId);
      return (
        edges.find((e) => e.source === fromId && e.target === toId)?.id ??
        edges.find((e) => e.source === toId && e.target === fromId)?.id ??
        null
      );
    }

    if (from && !to) {
      const fromId = TeamGraphAdapter.#resolveParticipantId(from, teamName, leadId);
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

  static #resolveParticipantId(name: string, teamName: string, leadId: string): string {
    if (name === 'user' || name === 'team-lead') return leadId;
    return `member:${teamName}:${name}`;
  }
}
