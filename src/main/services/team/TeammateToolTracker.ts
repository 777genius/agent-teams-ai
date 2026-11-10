import { extractToolPreview, extractToolResultPreview } from '@shared/utils/toolSummary';
import * as fs from 'fs/promises';

import type { TeamLogSourceTracker } from './TeamLogSourceTracker';
import type { TeamMemberLogsFinder } from './TeamMemberLogsFinder';
import type { ActiveToolCall, TeamChangeEvent, ToolActivityEventPayload } from '@shared/types';

const MAX_SEEN_FINISHED_IDS = 512;

interface FileState {
  memberName: string;
  sessionId: string;
  lastSize: number;
  lastMtimeMs: number;
  lineCarry: string;
  activeTools: Map<string, ActiveToolCall>;
  seenFinished: Set<string>;
}

interface TeamState {
  enabled: boolean;
  epoch: number;
  filesByPath: Map<string, FileState>;
  refreshInFlight: boolean;
  refreshQueued: boolean;
}

interface AttributedSubagentFile {
  memberName: string;
  sessionId: string;
  filePath: string;
  mtimeMs: number;
}

interface ParsedFileSnapshot {
  lastSize: number;
  lastMtimeMs: number;
  lineCarry: string;
  activeTools: Map<string, ActiveToolCall>;
  seenFinished: Set<string>;
}

export class TeammateToolTracker {
  private readonly stateByTeam = new Map<string, TeamState>();

  constructor(
    private readonly logsFinder: TeamMemberLogsFinder,
    private readonly logSourceTracker: TeamLogSourceTracker,
    private readonly emitTeamChange: (event: TeamChangeEvent) => void
  ) {}

  async setTracking(teamName: string, enabled: boolean): Promise<void> {
    if (enabled) {
      await this.enableTracking(teamName);
      return;
    }
    await this.disableTracking(teamName);
  }

  async dispose(): Promise<void> {
    await Promise.all(
      [...this.stateByTeam.keys()].map((teamName) => this.disableTracking(teamName))
    );
  }

  handleLogSourceChange(teamName: string): void {
    const state = this.stateByTeam.get(teamName);
    if (!state?.enabled) return;
    void this.refreshTeam(teamName);
  }

  handleTeamOffline(teamName: string): void {
    const state = this.stateByTeam.get(teamName);
    if (!state?.enabled) return;
    state.epoch += 1;
    this.resetAllTrackedTools(teamName, state.filesByPath);
    state.filesByPath.clear();
    state.refreshQueued = false;
  }

  private getOrCreateState(teamName: string): TeamState {
    const existing = this.stateByTeam.get(teamName);
    if (existing) return existing;
    const created: TeamState = {
      enabled: false,
      epoch: 0,
      filesByPath: new Map(),
      refreshInFlight: false,
      refreshQueued: false,
    };
    this.stateByTeam.set(teamName, created);
    return created;
  }

  private async enableTracking(teamName: string): Promise<void> {
    const state = this.getOrCreateState(teamName);
    if (state.enabled) {
      await this.refreshTeam(teamName);
      return;
    }
    state.enabled = true;
    state.epoch += 1;
    state.filesByPath.clear();
    state.refreshQueued = false;
    await this.logSourceTracker.enableTracking(teamName, 'tool_activity');
    await this.refreshTeam(teamName);
  }

  private async disableTracking(teamName: string): Promise<void> {
    const state = this.stateByTeam.get(teamName);
    if (!state) {
      await this.logSourceTracker.disableTracking(teamName, 'tool_activity');
      return;
    }
    state.enabled = false;
    state.epoch += 1;
    this.resetAllTrackedTools(teamName, state.filesByPath);
    state.filesByPath.clear();
    state.refreshQueued = false;
    await this.logSourceTracker.disableTracking(teamName, 'tool_activity');
  }

  private async refreshTeam(teamName: string): Promise<void> {
    const state = this.getOrCreateState(teamName);
    if (!state.enabled) return;

    if (state.refreshInFlight) {
      state.refreshQueued = true;
      return;
    }

    state.refreshInFlight = true;
    try {
      do {
        state.refreshQueued = false;
        const expectedEpoch = state.epoch;
        await this.performRefresh(teamName, expectedEpoch);
      } while (state.enabled && state.refreshQueued);
    } finally {
      state.refreshInFlight = false;
    }
  }

  private async performRefresh(teamName: string, expectedEpoch: number): Promise<void> {
    const state = this.stateByTeam.get(teamName);
    if (!state?.enabled || state.epoch !== expectedEpoch) return;

    const attributedFiles = await this.logsFinder.listAttributedSubagentFiles(teamName);
    const currentState = this.stateByTeam.get(teamName);
    if (!currentState?.enabled || currentState.epoch !== expectedEpoch) return;

    const fileByPath = new Map(attributedFiles.map((file) => [file.filePath, file]));

    for (const [filePath, fileState] of currentState.filesByPath.entries()) {
      if (fileByPath.has(filePath)) continue;
      this.emitTargetedReset(teamName, fileState.memberName, [...fileState.activeTools.keys()]);
      currentState.filesByPath.delete(filePath);
    }

    for (const file of attributedFiles) {
      const liveState = this.stateByTeam.get(teamName);
      if (!liveState?.enabled || liveState.epoch !== expectedEpoch) return;

      const existing = liveState.filesByPath.get(file.filePath);
      let stat;
      try {
        stat = await fs.stat(file.filePath);
      } catch {
        if (existing) {
          this.emitTargetedReset(teamName, existing.memberName, [...existing.activeTools.keys()]);
          liveState.filesByPath.delete(file.filePath);
        }
        continue;
      }
      if (!stat.isFile()) continue;

      const attributionChanged =
        existing &&
        (existing.memberName !== file.memberName || existing.sessionId !== file.sessionId);

      if (!existing || attributionChanged) {
        const parsed = await this.parseFileSnapshot(file, stat.size, stat.mtimeMs);
        const latestState = this.stateByTeam.get(teamName);
        if (!latestState?.enabled || latestState.epoch !== expectedEpoch) return;
        if (existing) {
          this.emitTargetedReset(teamName, existing.memberName, [...existing.activeTools.keys()]);
        }
        latestState.filesByPath.set(
          file.filePath,
          this.applyParsedSnapshot(
            teamName,
            file,
            attributionChanged ? null : (existing ?? null),
            parsed
          )
        );
        continue;
      }

      if (stat.size < existing.lastSize) {
        const parsed = await this.parseFileSnapshot(file, stat.size, stat.mtimeMs);
        const latestState = this.stateByTeam.get(teamName);
        if (!latestState?.enabled || latestState.epoch !== expectedEpoch) return;
        latestState.filesByPath.set(
          file.filePath,
          this.applyParsedSnapshot(teamName, file, existing, parsed)
        );
        continue;
      }

      if (stat.size === existing.lastSize && stat.mtimeMs === existing.lastMtimeMs) {
        continue;
      }

      if (stat.size === existing.lastSize) {
        const parsed = await this.parseFileSnapshot(file, stat.size, stat.mtimeMs);
        const latestState = this.stateByTeam.get(teamName);
        if (!latestState?.enabled || latestState.epoch !== expectedEpoch) return;
        latestState.filesByPath.set(
          file.filePath,
          this.applyParsedSnapshot(teamName, file, existing, parsed)
        );
        continue;
      }

      const nextState = await this.applyDelta(teamName, file, existing, stat.size, stat.mtimeMs);
      const latestState = this.stateByTeam.get(teamName);
      if (!latestState?.enabled || latestState.epoch !== expectedEpoch) return;
      latestState.filesByPath.set(file.filePath, nextState);
    }
  }

  private async parseFileSnapshot(
    file: AttributedSubagentFile,
    size: number,
    mtimeMs: number
  ): Promise<ParsedFileSnapshot> {
    const content = await fs.readFile(file.filePath, 'utf8').catch(() => '');
    const { lines, carry } = splitJsonLines(content);
    const activeTools = new Map<string, ActiveToolCall>();
    const seenFinished = new Set<string>();

    for (const line of lines) {
      this.consumeJsonLine(line, file, activeTools, seenFinished);
    }

    return {
      lastSize: size,
      lastMtimeMs: mtimeMs,
      lineCarry: carry,
      activeTools,
      seenFinished,
    };
  }

  private applyParsedSnapshot(
    teamName: string,
    file: AttributedSubagentFile,
    existing: FileState | null,
    parsed: ParsedFileSnapshot
  ): FileState {
    const previousActive = existing?.activeTools ?? new Map<string, ActiveToolCall>();
    const nextActiveIds = new Set(parsed.activeTools.keys());
    const removedIds = [...previousActive.keys()].filter(
      (toolUseId) => !nextActiveIds.has(toolUseId)
    );
    if (removedIds.length > 0 && existing) {
      this.emitTargetedReset(teamName, existing.memberName, removedIds);
    }

    for (const [toolUseId, activity] of parsed.activeTools.entries()) {
      if (previousActive.has(toolUseId)) continue;
      this.emitStart(teamName, activity);
    }

    return {
      memberName: file.memberName,
      sessionId: file.sessionId,
      lastSize: parsed.lastSize,
      lastMtimeMs: parsed.lastMtimeMs,
      lineCarry: parsed.lineCarry,
      activeTools: parsed.activeTools,
      seenFinished: parsed.seenFinished,
    };
  }

  private async applyDelta(
    teamName: string,
    file: AttributedSubagentFile,
    fileState: FileState,
    nextSize: number,
    nextMtimeMs: number
  ): Promise<FileState> {
    const nextActiveTools = new Map(fileState.activeTools);
    const nextSeenFinished = new Set(fileState.seenFinished);
    const appendedChunk = await readAppendedChunk(file.filePath, fileState.lastSize, nextSize);
    const { lines, carry } = splitJsonLines(fileState.lineCarry + appendedChunk);

    for (const line of lines) {
      this.consumeJsonLine(line, file, nextActiveTools, nextSeenFinished, {
        emitStart: (activity) => this.emitStart(teamName, activity),
        emitFinish: (activity, result) => this.emitFinish(teamName, activity, result),
      });
    }

    return {
      memberName: fileState.memberName,
      sessionId: fileState.sessionId,
      lastSize: nextSize,
      lastMtimeMs: nextMtimeMs,
      lineCarry: carry,
      activeTools: nextActiveTools,
      seenFinished: nextSeenFinished,
    };
  }

  private consumeJsonLine(
    line: string,
    file: AttributedSubagentFile,
    activeTools: Map<string, ActiveToolCall>,
    seenFinished: Set<string>,
    emitters?: {
      emitStart?: (activity: ActiveToolCall) => void;
      emitFinish?: (activity: ActiveToolCall, result: FinishPayload) => void;
    }
  ): void {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    const timestamp = extractEntryTimestamp(entry) ?? new Date().toISOString();
    const content = extractEntryContent(entry);
    if (!content) return;

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const typedBlock = block;
      if (typedBlock.type === 'tool_use') {
        const rawId = typeof typedBlock.id === 'string' ? typedBlock.id.trim() : '';
        if (!rawId) continue;
        const toolUseId = buildCompositeToolUseId(file.sessionId, rawId);
        if (activeTools.has(toolUseId) || seenFinished.has(toolUseId)) continue;
        const toolName = typeof typedBlock.name === 'string' ? typedBlock.name : 'Tool';
        const input =
          typedBlock.input && typeof typedBlock.input === 'object'
            ? (typedBlock.input as Record<string, unknown>)
            : {};
        const activity: ActiveToolCall = {
          memberName: file.memberName,
          toolUseId,
          toolName,
          preview: extractToolPreview(toolName, input),
          startedAt: timestamp,
          source: 'member_log',
          state: 'running',
        };
        activeTools.set(toolUseId, activity);
        emitters?.emitStart?.(activity);
        continue;
      }

      if (typedBlock.type !== 'tool_result' || typeof typedBlock.tool_use_id !== 'string') continue;
      const toolUseId = buildCompositeToolUseId(file.sessionId, typedBlock.tool_use_id);
      const active = activeTools.get(toolUseId);
      if (active) {
        activeTools.delete(toolUseId);
        pushBoundedSetValue(seenFinished, toolUseId, MAX_SEEN_FINISHED_IDS);
        emitters?.emitFinish?.(active, {
          finishedAt: timestamp,
          resultPreview: extractToolResultPreview(typedBlock.content),
          isError: typedBlock.is_error === true,
        });
        continue;
      }

      pushBoundedSetValue(seenFinished, toolUseId, MAX_SEEN_FINISHED_IDS);
    }
  }

  private emitStart(teamName: string, activity: ActiveToolCall): void {
    const payload: ToolActivityEventPayload = {
      action: 'start',
      activity: {
        memberName: activity.memberName,
        toolUseId: activity.toolUseId,
        toolName: activity.toolName,
        preview: activity.preview,
        startedAt: activity.startedAt,
        source: activity.source,
      },
    };
    this.emitTeamChange({
      type: 'tool-activity',
      teamName,
      detail: JSON.stringify(payload),
    });
  }

  private emitFinish(teamName: string, activity: ActiveToolCall, result: FinishPayload): void {
    const payload: ToolActivityEventPayload = {
      action: 'finish',
      memberName: activity.memberName,
      toolUseId: activity.toolUseId,
      finishedAt: result.finishedAt,
      resultPreview: result.resultPreview,
      isError: result.isError,
    };
    this.emitTeamChange({
      type: 'tool-activity',
      teamName,
      detail: JSON.stringify(payload),
    });
  }

  private emitTargetedReset(teamName: string, memberName: string, toolUseIds: string[]): void {
    if (toolUseIds.length === 0) return;
    const payload: ToolActivityEventPayload = {
      action: 'reset',
      memberName,
      toolUseIds,
    };
    this.emitTeamChange({
      type: 'tool-activity',
      teamName,
      detail: JSON.stringify(payload),
    });
  }

  private resetAllTrackedTools(teamName: string, filesByPath: Map<string, FileState>): void {
    for (const fileState of filesByPath.values()) {
      this.emitTargetedReset(teamName, fileState.memberName, [...fileState.activeTools.keys()]);
    }
  }
}

interface FinishPayload {
  finishedAt: string;
  resultPreview?: string;
  isError?: boolean;
}

function buildCompositeToolUseId(sessionId: string, rawToolUseId: string): string {
  return `member_log:${sessionId}:${rawToolUseId}`;
}

function extractEntryContent(entry: Record<string, unknown>): Record<string, unknown>[] | null {
  if (Array.isArray(entry.content)) return entry.content as Record<string, unknown>[];
  const message = entry.message;
  if (
    message &&
    typeof message === 'object' &&
    Array.isArray((message as { content?: unknown[] }).content)
  ) {
    return (message as { content: Record<string, unknown>[] }).content;
  }
  return null;
}

function extractEntryTimestamp(entry: Record<string, unknown>): string | null {
  if (typeof entry.timestamp === 'string' && entry.timestamp.trim().length > 0) {
    return entry.timestamp;
  }
  const message = entry.message;
  if (
    message &&
    typeof message === 'object' &&
    typeof (message as { timestamp?: unknown }).timestamp === 'string'
  ) {
    return (message as { timestamp: string }).timestamp;
  }
  return null;
}

function splitJsonLines(text: string): { lines: string[]; carry: string } {
  const normalized = text.replace(/\r\n/g, '\n');
  const rawParts = normalized.split('\n');
  let carry = rawParts.pop() ?? '';
  const lines = rawParts.map((part) => part.trim()).filter((part) => part.length > 0);
  const trimmedCarry = carry.trim();
  if (trimmedCarry.length > 0) {
    try {
      JSON.parse(trimmedCarry);
      lines.push(trimmedCarry);
      carry = '';
    } catch {
      carry = trimmedCarry;
    }
  } else {
    carry = '';
  }
  return { lines, carry };
}

async function readAppendedChunk(filePath: string, start: number, end: number): Promise<string> {
  if (end <= start) return '';
  const length = end - start;
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return buffer.toString('utf8');
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function pushBoundedSetValue(set: Set<string>, value: string, limit: number): void {
  if (set.has(value)) {
    set.delete(value);
  }
  set.add(value);
  while (set.size > limit) {
    const oldest = set.values().next().value;
    if (!oldest) break;
    set.delete(oldest);
  }
}
