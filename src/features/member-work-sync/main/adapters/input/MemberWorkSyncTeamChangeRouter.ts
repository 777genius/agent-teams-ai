import { extractMemberWorkSyncTaskId } from './MemberWorkSyncTaskImpactResolver';

import type {
  MemberWorkSyncEventQueue,
  MemberWorkSyncTriggerReason,
} from '../../infrastructure/MemberWorkSyncEventQueue';
import type { MemberWorkSyncTaskImpactResolver } from './MemberWorkSyncTaskImpactResolver';
import type { TeamChangeEvent, ToolActivityEventPayload } from '@shared/types';

interface MemberTurnSettledEventPayload {
  memberName?: string;
  sourceId?: string;
  provider?: string;
}

interface MemberWorkSyncRosterSource {
  loadActiveMemberNames(teamName: string): Promise<string[]>;
}

interface MemberWorkSyncMemberStorageMaterializer {
  materializeMember(teamName: string, memberName: string): Promise<void>;
}

const TEAM_WIDE_REASONS: Partial<Record<TeamChangeEvent['type'], MemberWorkSyncTriggerReason>> = {
  config: 'config_changed',
  'log-source-change': 'runtime_activity',
  process: 'runtime_activity',
  'lead-activity': 'runtime_activity',
};

function parseInboxRecipient(detail: string | undefined): string | null {
  if (!detail) {
    return null;
  }
  const match = /^inboxes\/(.+)\.json$/.exec(detail);
  return match?.[1]?.trim() || null;
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

function parseMemberTurnSettled(detail: string | undefined): MemberTurnSettledEventPayload | null {
  if (!detail) {
    return null;
  }
  try {
    const parsed = JSON.parse(detail) as MemberTurnSettledEventPayload;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export class MemberWorkSyncTeamChangeRouter {
  private readonly quiescedTeams = new Set<string>();
  private readonly inFlightByTeam = new Map<string, Set<Promise<void>>>();

  constructor(
    private readonly rosterSource: MemberWorkSyncRosterSource,
    private readonly queue: MemberWorkSyncEventQueue,
    private readonly materializer?: MemberWorkSyncMemberStorageMaterializer,
    private readonly taskImpactResolver?: MemberWorkSyncTaskImpactResolver
  ) {}

  async enqueueStartupScan(teamNames: string[]): Promise<void> {
    for (const teamName of teamNames) {
      if (this.quiescedTeams.has(teamName)) continue;
      await this.runTracked(teamName, () => this.enqueueTeam(teamName, 'startup_scan', 30_000));
    }
  }

  noteTeamChange(event: TeamChangeEvent): void {
    if (this.quiescedTeams.has(event.teamName)) return;

    if (event.type === 'lead-activity' && event.detail === 'offline') {
      this.queue.dropTeam(event.teamName);
      this.runTracked(event.teamName, () =>
        this.enqueueTeam(event.teamName, 'runtime_activity', 0)
      );
      return;
    }

    if (event.type === 'member-spawn') {
      const memberName = event.detail?.trim();
      if (memberName) {
        this.queue.enqueue({
          teamName: event.teamName,
          memberName,
          triggerReason: 'member_spawned',
          runAfterMs: 30_000,
        });
      } else {
        void this.enqueueTeam(event.teamName, 'member_spawned', 30_000).catch(() => undefined);
      }
      return;
    }

    if (event.type === 'tool-activity') {
      const payload = parseToolActivity(event.detail);
      if (payload?.action === 'finish' && payload.memberName) {
        this.queue.enqueue({
          teamName: event.teamName,
          memberName: payload.memberName,
          triggerReason: 'tool_finished',
        });
      }
      return;
    }

    if (event.type === 'member-turn-settled') {
      const payload = parseMemberTurnSettled(event.detail);
      const memberName = payload?.memberName?.trim();
      if (memberName) {
        this.queue.enqueue({
          teamName: event.teamName,
          memberName,
          triggerReason: 'turn_settled',
        });
      }
      return;
    }

    if (event.type === 'task' || event.type === 'task-log-change') {
      const triggerReason = event.type === 'task' ? 'task_changed' : 'runtime_activity';
      this.runTracked(event.teamName, async () => {
        await this.enqueueTaskRelatedMembers(event, triggerReason).catch(() =>
          this.enqueueTeam(event.teamName, triggerReason).catch(() => undefined)
        );
      });
      return;
    }

    if (event.type === 'inbox' || event.type === 'lead-message') {
      const recipient = parseInboxRecipient(event.detail);
      if (recipient) {
        this.queue.enqueue({
          teamName: event.teamName,
          memberName: recipient,
          triggerReason: 'inbox_changed',
        });
      }
      return;
    }

    const teamWideReason = TEAM_WIDE_REASONS[event.type];
    if (teamWideReason) {
      this.runTracked(event.teamName, () => this.enqueueTeam(event.teamName, teamWideReason));
    }
  }

  async quiesceTeam(teamName: string): Promise<void> {
    const normalizedTeamName = teamName.trim();
    if (!normalizedTeamName) return;
    this.quiescedTeams.add(normalizedTeamName);
    await this.queue.quiesceTeam(normalizedTeamName);
    while (true) {
      const pending = [...(this.inFlightByTeam.get(normalizedTeamName) ?? [])];
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
    await this.queue.quiesceTeam(normalizedTeamName);
  }

  resumeTeam(teamName: string): void {
    const normalizedTeamName = teamName.trim();
    this.quiescedTeams.delete(normalizedTeamName);
    this.queue.resumeTeam(normalizedTeamName);
  }

  private async enqueueTeam(
    teamName: string,
    triggerReason: MemberWorkSyncTriggerReason,
    runAfterMs?: number
  ): Promise<void> {
    if (this.quiescedTeams.has(teamName)) return;
    const activeMembers = await this.rosterSource.loadActiveMemberNames(teamName);
    if (this.quiescedTeams.has(teamName)) return;
    const materializer = this.materializer;
    if (materializer) {
      await this.materializeMembers(teamName, activeMembers);
    }
    for (const memberName of activeMembers) {
      if (this.quiescedTeams.has(teamName)) return;
      this.queue.enqueue({ teamName, memberName, triggerReason, runAfterMs });
    }
  }

  private async enqueueTaskRelatedMembers(
    event: TeamChangeEvent,
    triggerReason: MemberWorkSyncTriggerReason
  ): Promise<void> {
    const taskId = extractMemberWorkSyncTaskId({
      taskId: event.taskId,
      detail: event.detail,
    });
    if (!taskId || !this.taskImpactResolver) {
      await this.enqueueTeam(event.teamName, triggerReason);
      return;
    }

    const impact = await this.taskImpactResolver.resolve({
      teamName: event.teamName,
      taskId,
    });
    if (impact.fallbackTeamWide || impact.memberNames.length === 0) {
      await this.enqueueTeam(event.teamName, triggerReason);
      return;
    }
    const materializer = this.materializer;
    if (materializer) {
      await this.materializeMembers(event.teamName, impact.memberNames);
    }
    for (const memberName of impact.memberNames) {
      this.queue.enqueue({
        teamName: event.teamName,
        memberName,
        triggerReason,
      });
    }
  }

  private async materializeMembers(
    teamName: string,
    memberNames: readonly string[]
  ): Promise<void> {
    if (!this.materializer) {
      return;
    }
    for (const memberName of memberNames) {
      if (this.quiescedTeams.has(teamName)) return;
      await this.materializer.materializeMember(teamName, memberName).catch(() => undefined);
    }
  }

  private runTracked(teamName: string, operation: () => Promise<void>): Promise<void> {
    if (this.quiescedTeams.has(teamName)) return Promise.resolve();
    const promise = (async () => {
      if (!this.quiescedTeams.has(teamName)) await operation();
    })()
      .catch(() => undefined)
      .finally(() => {
        const teamPromises = this.inFlightByTeam.get(teamName);
        teamPromises?.delete(promise);
        if (teamPromises?.size === 0) this.inFlightByTeam.delete(teamName);
      });
    const teamPromises = this.inFlightByTeam.get(teamName) ?? new Set<Promise<void>>();
    teamPromises.add(promise);
    this.inFlightByTeam.set(teamName, teamPromises);
    return promise;
  }
}
