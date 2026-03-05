/**
 * SubagentResolver service - Links Task calls to subagent files and detects parallelism.
 *
 * Responsibilities:
 * - Find subagent JSONL files in {sessionId}/subagents/ directory
 * - Parse each subagent file
 * - Calculate start/end times and metrics
 * - Detect parallel execution (100ms overlap threshold)
 * - Link subagents to parent Task tool calls
 */

import { type ParsedMessage, type Process, type SessionMetrics, type ToolCall } from '@main/types';
import { calculateMetrics, checkMessagesOngoing, parseJsonlFile } from '@main/utils/jsonl';
import { createLogger } from '@shared/utils/logger';
import * as path from 'path';

import { type ProjectScanner } from './ProjectScanner';

const logger = createLogger('Discovery:SubagentResolver');

/** Parallel detection window in milliseconds */
const PARALLEL_WINDOW_MS = 100;

export class SubagentResolver {
  private projectScanner: ProjectScanner;

  constructor(projectScanner: ProjectScanner) {
    this.projectScanner = projectScanner;
  }

  // ===========================================================================
  // Main Resolution
  // ===========================================================================

  /**
   * Resolve all subagents for a session.
   */
  async resolveSubagents(
    projectId: string,
    sessionId: string,
    taskCalls: ToolCall[],
    messages?: ParsedMessage[]
  ): Promise<Process[]> {
    // Get subagent files
    const subagentFiles = await this.projectScanner.listSubagentFiles(projectId, sessionId);

    if (subagentFiles.length === 0) {
      return [];
    }

    // Parse subagent files with bounded concurrency to avoid overwhelming SFTP.
    const parseConcurrency = this.projectScanner.getFileSystemProvider().type === 'ssh' ? 4 : 24;
    const subagents = await this.collectInBatches(
      subagentFiles,
      parseConcurrency,
      async (filePath) => this.parseSubagentFile(filePath)
    );

    // Filter out failed parses
    const validSubagents = subagents.filter((s): s is Process => s !== null);

    // Link to Task calls using tool result data from parent session messages
    this.linkToTaskCalls(validSubagents, taskCalls, messages ?? []);

    // Propagate team metadata to continuation files via parentUuid chain
    this.propagateTeamMetadata(validSubagents);

    // Detect parallel execution
    this.detectParallelExecution(validSubagents);

    // Enrich team metadata colors from messages
    if (messages) {
      this.enrichTeamColors(validSubagents, messages);
    }

    // Sort by start time
    validSubagents.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

    return validSubagents;
  }

  // ===========================================================================
  // Subagent Parsing
  // ===========================================================================

  /**
   * Parse a single subagent file.
   */
  private async parseSubagentFile(filePath: string): Promise<Process | null> {
    try {
      const messages = await parseJsonlFile(filePath, this.projectScanner.getFileSystemProvider());

      if (messages.length === 0) {
        return null;
      }

      // Filter out warmup subagents - these are pre-warming agents spawned by Claude Code
      // that have "Warmup" as the first user message and should not be displayed
      if (this.isWarmupSubagent(messages)) {
        return null;
      }

      // Extract agent ID from filename (agent-{id}.jsonl)
      const filename = path.basename(filePath);
      const agentId = filename.replace(/^agent-/, '').replace(/\.jsonl$/, '');

      // Filter out compact files (context compaction artifacts, not real subagents)
      if (agentId.startsWith('acompact')) {
        return null;
      }

      // Calculate timing
      const { startTime, endTime, durationMs } = this.calculateTiming(messages);

      // Calculate metrics
      const metrics = calculateMetrics(messages);

      // Check if subagent is still in progress
      const isOngoing = checkMessagesOngoing(messages);

      return {
        id: agentId,
        filePath,
        messages,
        startTime,
        endTime,
        durationMs,
        metrics,
        isParallel: false, // Will be set by detectParallelExecution
        isOngoing,
      };
    } catch (error) {
      logger.error(`Error parsing subagent file ${filePath}:`, error);
      return null;
    }
  }

  /**
   * Check if this is a warmup subagent that should be filtered out.
   * Warmup subagents are pre-warming agents spawned by Claude Code that have:
   * - First user message with content exactly "Warmup"
   * - isSidechain: true (all subagents have this)
   */
  private isWarmupSubagent(messages: ParsedMessage[]): boolean {
    // Find the first user message
    const firstUserMessage = messages.find((m) => m.type === 'user');
    if (!firstUserMessage) {
      return false;
    }

    // Check if content is exactly "Warmup" (string, not array)
    return firstUserMessage.content === 'Warmup';
  }

  /**
   * Extract the teammate_id attribute from the first <teammate-message> tag in a subagent's messages.
   * Returns the teammate_id string if found, undefined otherwise.
   * Used for deterministic matching of team member files to their spawning Task calls.
   */
  private extractTeammateId(messages: ParsedMessage[]): string | undefined {
    const firstUserMessage = messages.find((m) => m.type === 'user');
    if (!firstUserMessage) return undefined;

    const text = typeof firstUserMessage.content === 'string' ? firstUserMessage.content : '';
    const match = /<teammate-message\s[^>]*?\bteammate_id="([^"]+)"/.exec(text);
    return match?.[1];
  }

  /**
   * Calculate timing from messages.
   */
  private calculateTiming(messages: ParsedMessage[]): {
    startTime: Date;
    endTime: Date;
    durationMs: number;
  } {
    const timestamps = messages.map((m) => m.timestamp.getTime()).filter((t) => !isNaN(t));

    if (timestamps.length === 0) {
      const now = new Date();
      return { startTime: now, endTime: now, durationMs: 0 };
    }

    const minTime = Math.min(...timestamps);
    const maxTime = Math.max(...timestamps);

    return {
      startTime: new Date(minTime),
      endTime: new Date(maxTime),
      durationMs: maxTime - minTime,
    };
  }

  // ===========================================================================
  // Task Call Linking
  // ===========================================================================

  /**
   * Link subagents to their parent Task tool calls.
   *
   * Uses result-based matching: reads tool_result messages from the parent session
   * to find agentId values, then matches subagent files by their ID. Falls back to
   * positional matching (without wrap-around) for any remaining unmatched subagents.
   *
   * After matching, enriches subagents with Task call metadata (description, subagentType).
   */
  private linkToTaskCalls(
    subagents: Process[],
    taskCalls: ToolCall[],
    messages: ParsedMessage[]
  ): void {
    // Filter to only Task calls
    const taskCallsOnly = taskCalls.filter((tc) => tc.isTask);

    if (taskCallsOnly.length === 0 || subagents.length === 0) {
      return;
    }

    // Build a map: agentId → taskCallId from tool result messages
    // Tool results for Task calls contain an agentId field linking to the subagent file
    const agentIdToTaskId = new Map<string, string>();
    for (const msg of messages) {
      if (!msg.toolUseResult) continue;
      const result = msg.toolUseResult;
      // Check both camelCase (regular subagents) and snake_case (team spawns) field names
      const agentId = (result.agentId ?? result.agent_id) as string | undefined;
      if (!agentId) continue;

      // Find the Task call ID from sourceToolUseID or toolResults[0].toolUseId
      const taskCallId = msg.sourceToolUseID ?? msg.toolResults[0]?.toolUseId;
      if (taskCallId) {
        agentIdToTaskId.set(agentId, taskCallId);
      }
    }

    // Build a lookup from task call ID → ToolCall for enrichment
    const taskCallById = new Map(taskCallsOnly.map((tc) => [tc.id, tc]));

    // Track which subagents and tasks got matched
    const matchedSubagentIds = new Set<string>();
    const matchedTaskIds = new Set<string>();

    // Phase 1: Result-based matching (agentId from tool results)
    // Works for regular subagents (Explore, etc.) where agentId = file UUID
    for (const subagent of subagents) {
      const taskCallId = agentIdToTaskId.get(subagent.id);
      if (!taskCallId) continue;

      const taskCall = taskCallById.get(taskCallId);
      if (!taskCall) continue;

      this.enrichSubagentFromTask(subagent, taskCall);
      subagent.linkType = 'agent-id';
      matchedSubagentIds.add(subagent.id);
      matchedTaskIds.add(taskCallId);
    }

    // Phase 2: Deterministic teammate_id matching for team members
    // Team spawns use agent_id = "name@team_name" (not a file UUID), so Phase 1 can't match them.
    // Instead, match by comparing Task call input.name to the teammate_id XML attribute
    // in the subagent file's first <teammate-message> tag.
    const teamTaskCalls = taskCallsOnly.filter(
      (tc) =>
        !matchedTaskIds.has(tc.id) &&
        typeof tc.input?.team_name === 'string' &&
        typeof tc.input?.name === 'string'
    );

    if (teamTaskCalls.length > 0) {
      // Pre-extract teammate_ids from unmatched subagent files
      const subagentTeammateIds = new Map<string, string>();
      for (const subagent of subagents) {
        if (matchedSubagentIds.has(subagent.id)) continue;
        const teammateId = this.extractTeammateId(subagent.messages);
        if (teammateId) {
          subagentTeammateIds.set(subagent.id, teammateId);
        }
      }

      // Match each team Task call to the earliest subagent file with matching teammate_id
      for (const taskCall of teamTaskCalls) {
        const inputName = taskCall.input?.name as string;

        let bestMatch: Process | undefined;
        for (const subagent of subagents) {
          if (matchedSubagentIds.has(subagent.id)) continue;
          if (subagentTeammateIds.get(subagent.id) !== inputName) continue;
          if (!bestMatch || subagent.startTime < bestMatch.startTime) {
            bestMatch = subagent;
          }
        }

        if (bestMatch) {
          this.enrichSubagentFromTask(bestMatch, taskCall);
          bestMatch.linkType = 'team-member-id';
          matchedSubagentIds.add(bestMatch.id);
          matchedTaskIds.add(taskCall.id);
        }
      }
    }

    // Mark remaining unmatched subagents as unlinked (no Phase 3 positional fallback)
    for (const subagent of subagents) {
      if (!matchedSubagentIds.has(subagent.id) && !subagent.linkType) {
        subagent.linkType = 'unlinked';
      }
    }
  }

  /**
   * Enrich a subagent with metadata from its parent Task call.
   * Intentionally mutates the subagent in place for consistency with other resolution methods.
   */
  private enrichSubagentFromTask(subagent: Process, taskCall: ToolCall): void {
    /* eslint-disable no-param-reassign -- Mutation is intentional; subagent is enriched in place */
    subagent.parentTaskId = taskCall.id;
    subagent.description = taskCall.taskDescription;
    subagent.subagentType = taskCall.taskSubagentType;

    // Extract team metadata from Task call input
    const teamName = taskCall.input?.team_name as string | undefined;
    const memberName = taskCall.input?.name as string | undefined;
    if (teamName && memberName) {
      subagent.team = { teamName, memberName, memberColor: '' };
    }
    /* eslint-enable no-param-reassign -- End of intentional mutation block */
  }

  /**
   * Enrich team member subagents with color information from tool results.
   * Teammate spawned results contain color information.
   */
  private enrichTeamColors(subagents: Process[], messages: ParsedMessage[]): void {
    for (const msg of messages) {
      if (!msg.toolUseResult) continue;
      // sourceToolUseID may be absent on teammate_spawned results;
      // fall back to toolResults[0].toolUseId
      const sourceId = msg.sourceToolUseID ?? msg.toolResults[0]?.toolUseId;
      if (!sourceId) continue;
      const result = msg.toolUseResult;
      if (result.status === 'teammate_spawned' && result.color) {
        // Set color on ALL subagents sharing this parentTaskId
        // (primary file + continuation files from parentUuid chain propagation)
        for (const subagent of subagents) {
          if (subagent.parentTaskId === sourceId && subagent.team) {
            subagent.team.memberColor = result.color as string;
          }
        }
      }
    }
  }

  /**
   * Propagate team metadata to continuation files via parentUuid chain.
   *
   * Team members generate multiple JSONL files (one per activation/turn).
   * Only the primary file is matched by linkToTaskCalls (Phase 2 description match).
   * Continuation files (task assignments, shutdown responses) are linked to the
   * same teammate by following the parentUuid chain: a continuation file's first
   * message.parentUuid matches the last message.uuid of the previous file.
   */
  private propagateTeamMetadata(subagents: Process[]): void {
    // Build map: last message uuid → subagent (for chain lookups)
    const lastUuidToSubagent = new Map<string, Process>();
    for (const subagent of subagents) {
      if (subagent.messages.length === 0) continue;
      const lastMsg = subagent.messages[subagent.messages.length - 1];
      if (lastMsg.uuid) {
        lastUuidToSubagent.set(lastMsg.uuid, subagent);
      }
    }

    // For each subagent without team metadata, follow parentUuid chain
    // to find an ancestor with team metadata and propagate it
    const maxDepth = 10;
    for (const subagent of subagents) {
      if (subagent.team) continue; // Already has team metadata
      if (subagent.messages.length === 0) continue;

      const firstMsg = subagent.messages[0];
      if (!firstMsg.parentUuid) continue;

      // Walk the chain upward
      let ancestor: Process | undefined = lastUuidToSubagent.get(firstMsg.parentUuid);
      let depth = 0;

      while (ancestor && !ancestor.team && depth < maxDepth) {
        if (ancestor.messages.length === 0) break;
        const parentUuid = ancestor.messages[0].parentUuid;
        if (!parentUuid) break;
        ancestor = lastUuidToSubagent.get(parentUuid);
        depth++;
      }

      if (ancestor?.team) {
        subagent.team = { ...ancestor.team };
        subagent.parentTaskId = subagent.parentTaskId ?? ancestor.parentTaskId;
        subagent.description = subagent.description ?? ancestor.description;
        subagent.subagentType = subagent.subagentType ?? ancestor.subagentType;
        subagent.linkType = subagent.linkType ?? (ancestor.linkType ? 'parent-chain' : undefined);
      }
    }
  }

  // ===========================================================================
  // Parallel Detection
  // ===========================================================================

  /**
   * Detect parallel execution among subagents.
   * Subagents with start times within PARALLEL_WINDOW_MS are marked as parallel.
   */
  private detectParallelExecution(subagents: Process[]): void {
    if (subagents.length < 2) return;

    // Sort by start time
    const sorted = [...subagents].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

    // Group by start time buckets
    const groups: Process[][] = [];
    let currentGroup: Process[] = [];
    let groupStartTime = 0;

    for (const agent of sorted) {
      const startMs = agent.startTime.getTime();

      if (currentGroup.length === 0) {
        // Start new group
        currentGroup.push(agent);
        groupStartTime = startMs;
      } else if (startMs - groupStartTime <= PARALLEL_WINDOW_MS) {
        // Add to current group
        currentGroup.push(agent);
      } else {
        // Finalize current group and start new one
        if (currentGroup.length > 0) {
          groups.push(currentGroup);
        }
        currentGroup = [agent];
        groupStartTime = startMs;
      }
    }

    // Don't forget the last group
    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }

    // Mark agents in groups with multiple members as parallel
    for (const group of groups) {
      if (group.length > 1) {
        for (const agent of group) {
          agent.isParallel = true;
        }
      }
    }
  }

  // ===========================================================================
  // Utility Methods
  // ===========================================================================

  /**
   * Get subagent by ID.
   */
  findSubagentById(subagents: Process[], id: string): Process | undefined {
    return subagents.find((s) => s.id === id);
  }

  /**
   * Get parallel subagent groups.
   */
  getParallelGroups(subagents: Process[]): Process[][] {
    const parallelAgents = subagents.filter((s) => s.isParallel);
    if (parallelAgents.length === 0) return [];

    // Group by start time
    const sorted = [...parallelAgents].sort(
      (a, b) => a.startTime.getTime() - b.startTime.getTime()
    );

    const groups: Process[][] = [];
    let currentGroup: Process[] = [];
    let groupStartTime = 0;

    for (const agent of sorted) {
      const startMs = agent.startTime.getTime();

      if (currentGroup.length === 0) {
        currentGroup.push(agent);
        groupStartTime = startMs;
      } else if (startMs - groupStartTime <= PARALLEL_WINDOW_MS) {
        currentGroup.push(agent);
      } else {
        groups.push(currentGroup);
        currentGroup = [agent];
        groupStartTime = startMs;
      }
    }

    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }

    return groups.filter((g) => g.length > 1);
  }

  /**
   * Calculate total metrics for all subagents.
   */
  getTotalSubagentMetrics(subagents: Process[]): SessionMetrics {
    if (subagents.length === 0) {
      return {
        durationMs: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        messageCount: 0,
      };
    }

    let totalDuration = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let messageCount = 0;

    for (const agent of subagents) {
      totalDuration += agent.durationMs;
      inputTokens += agent.metrics.inputTokens;
      outputTokens += agent.metrics.outputTokens;
      cacheReadTokens += agent.metrics.cacheReadTokens;
      cacheCreationTokens += agent.metrics.cacheCreationTokens;
      messageCount += agent.metrics.messageCount;
    }

    return {
      durationMs: totalDuration,
      totalTokens: inputTokens + outputTokens,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      messageCount,
    };
  }

  private async collectInBatches<T, R>(
    items: T[],
    batchSize: number,
    mapper: (item: T) => Promise<R>
  ): Promise<R[]> {
    const safeBatchSize = Math.max(1, batchSize);
    const results: R[] = [];

    for (let i = 0; i < items.length; i += safeBatchSize) {
      const batch = items.slice(i, i + safeBatchSize);
      const settled = await Promise.allSettled(batch.map((item) => mapper(item)));
      for (const result of settled) {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        }
      }
    }

    return results;
  }
}
