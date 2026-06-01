import type { MemberWorkSyncBusySignalPort } from '../../core/application';
import type { TeamChangeEvent, ToolActivityEventPayload } from '@shared/types';

const DEFAULT_TOOL_ACTIVITY_BUSY_GRACE_MS = 90_000;
const DEFAULT_ACTIVE_TOOL_STALE_MS = 10 * 60_000;

interface MemberActivityState {
  activeToolStartedAtByToolId: Map<string, string>;
  recentBusyUntilByToolId: Map<string, string>;
}

function memberKey(teamName: string, memberName: string): string {
  return `${teamName}\0${memberName.trim().toLowerCase()}`;
}

function parseToolActivity(detail: string | undefined): ToolActivityEventPayload | null {
  if (!detail) {
    return null;
  }
  try {
    const parsed = JSON.parse(detail) as ToolActivityEventPayload;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function parseIsoMs(value: string | undefined, fallbackMs: number): number {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallbackMs;
}

function addMsIso(baseIso: string, ms: number): string {
  return new Date(Date.parse(baseIso) + ms).toISOString();
}

function maxIso(values: Iterable<string>): string | null {
  let max: string | null = null;
  for (const value of values) {
    if (!max || Date.parse(value) > Date.parse(max)) {
      max = value;
    }
  }
  return max;
}

export class MemberWorkSyncToolActivityBusySignal implements MemberWorkSyncBusySignalPort {
  private readonly activityByMember = new Map<string, MemberActivityState>();
  private readonly busyGraceMs: number;
  private readonly activeToolStaleMs: number;

  constructor(options: { busyGraceMs?: number; activeToolStaleMs?: number } = {}) {
    this.busyGraceMs = Math.max(0, options.busyGraceMs ?? DEFAULT_TOOL_ACTIVITY_BUSY_GRACE_MS);
    this.activeToolStaleMs = Math.max(
      this.busyGraceMs,
      options.activeToolStaleMs ?? DEFAULT_ACTIVE_TOOL_STALE_MS
    );
  }

  noteTeamChange(event: TeamChangeEvent): void {
    if (event.type === 'lead-activity' && event.detail === 'offline') {
      this.dropTeam(event.teamName);
      return;
    }

    if (event.type !== 'tool-activity') {
      return;
    }

    const payload = parseToolActivity(event.detail);
    if (!payload) {
      return;
    }

    if (payload.action === 'start' && payload.activity) {
      this.noteStart(
        event.teamName,
        payload.activity.memberName,
        payload.activity.toolUseId,
        payload.activity.startedAt
      );
      return;
    }

    if (payload.action === 'finish' && payload.memberName && payload.toolUseId) {
      this.noteFinish(event.teamName, payload.memberName, payload.toolUseId, payload.finishedAt);
      return;
    }

    if (payload.action === 'reset') {
      this.noteReset(event.teamName, payload.memberName, payload.toolUseIds);
    }
  }

  async isBusy(input: {
    teamName: string;
    memberName: string;
    nowIso: string;
  }): Promise<{ busy: boolean; reason?: string; retryAfterIso?: string }> {
    const key = memberKey(input.teamName, input.memberName);
    const state = this.activityByMember.get(key);
    if (!state) {
      return { busy: false };
    }

    this.pruneState(key, state, input.nowIso);

    if (state.activeToolStartedAtByToolId.size > 0) {
      return {
        busy: true,
        reason: 'active_tool_activity',
        retryAfterIso: addMsIso(input.nowIso, this.busyGraceMs),
      };
    }

    const retryAfterIso = maxIso(state.recentBusyUntilByToolId.values());
    if (retryAfterIso) {
      return {
        busy: true,
        reason: 'recent_tool_activity',
        retryAfterIso,
      };
    }

    return { busy: false };
  }

  private noteStart(
    teamName: string,
    memberName: string,
    toolUseId: string,
    startedAt: string | undefined
  ): void {
    const normalizedToolUseId = toolUseId.trim();
    if (!memberName.trim() || !normalizedToolUseId) {
      return;
    }
    const state = this.getOrCreateState(teamName, memberName);
    const startedAtMs = parseIsoMs(startedAt, Date.now());
    state.activeToolStartedAtByToolId.set(normalizedToolUseId, new Date(startedAtMs).toISOString());
    state.recentBusyUntilByToolId.delete(normalizedToolUseId);
  }

  private noteFinish(
    teamName: string,
    memberName: string,
    toolUseId: string,
    finishedAt: string | undefined
  ): void {
    const normalizedToolUseId = toolUseId.trim();
    if (!memberName.trim() || !normalizedToolUseId) {
      return;
    }
    const finishedAtMs = parseIsoMs(finishedAt, Date.now());
    const busyUntilIso = new Date(finishedAtMs + this.busyGraceMs).toISOString();
    const state = this.getOrCreateState(teamName, memberName);
    state.activeToolStartedAtByToolId.delete(normalizedToolUseId);
    state.recentBusyUntilByToolId.set(normalizedToolUseId, busyUntilIso);
  }

  private noteReset(teamName: string, memberName?: string, toolUseIds?: string[]): void {
    const normalizedMemberName = memberName?.trim();
    if (!normalizedMemberName) {
      this.dropTeam(teamName);
      return;
    }

    const key = memberKey(teamName, normalizedMemberName);
    const state = this.activityByMember.get(key);
    if (!state) {
      return;
    }

    const normalizedToolUseIds = new Set(
      (toolUseIds ?? []).map((toolUseId) => toolUseId.trim()).filter(Boolean)
    );
    if (normalizedToolUseIds.size === 0) {
      this.activityByMember.delete(key);
      return;
    }

    for (const toolUseId of normalizedToolUseIds) {
      state.activeToolStartedAtByToolId.delete(toolUseId);
      state.recentBusyUntilByToolId.delete(toolUseId);
    }
    if (state.activeToolStartedAtByToolId.size === 0 && state.recentBusyUntilByToolId.size === 0) {
      this.activityByMember.delete(key);
    }
  }

  private getOrCreateState(teamName: string, memberName: string): MemberActivityState {
    const key = memberKey(teamName, memberName);
    const existing = this.activityByMember.get(key);
    if (existing) {
      return existing;
    }
    const created: MemberActivityState = {
      activeToolStartedAtByToolId: new Map(),
      recentBusyUntilByToolId: new Map(),
    };
    this.activityByMember.set(key, created);
    return created;
  }

  private pruneState(key: string, state: MemberActivityState, nowIso: string): void {
    const nowMs = Date.parse(nowIso);
    if (Number.isFinite(nowMs)) {
      for (const [toolUseId, startedAtIso] of state.activeToolStartedAtByToolId) {
        const startedAtMs = Date.parse(startedAtIso);
        if (!Number.isFinite(startedAtMs) || nowMs - startedAtMs >= this.activeToolStaleMs) {
          state.activeToolStartedAtByToolId.delete(toolUseId);
        }
      }
    }
    for (const [toolUseId, busyUntilIso] of state.recentBusyUntilByToolId) {
      if (Date.parse(busyUntilIso) <= nowMs) {
        state.recentBusyUntilByToolId.delete(toolUseId);
      }
    }
    if (state.activeToolStartedAtByToolId.size === 0 && state.recentBusyUntilByToolId.size === 0) {
      this.activityByMember.delete(key);
    }
  }

  private dropTeam(teamName: string): void {
    for (const key of this.activityByMember.keys()) {
      if (key.startsWith(`${teamName}\0`)) {
        this.activityByMember.delete(key);
      }
    }
  }
}
