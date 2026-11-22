import { isLeadMember } from '@shared/utils/leadDetection';

import type { TeamSummary, TeamTaskWithKanban } from '@shared/types';

export function getSummaryKnownTeammateCount(summary: TeamSummary | undefined): number {
  if (!summary) {
    return 0;
  }
  const normalizedLeadName = summary.leadName?.trim().toLowerCase();
  const rosterNames = new Set<string>();
  for (const member of summary.members ?? []) {
    const name = member.name?.trim();
    if (!name) {
      continue;
    }
    const normalizedName = name.toLowerCase();
    if (
      normalizedName === 'user' ||
      isLeadMember({ name }) ||
      (normalizedLeadName && normalizedName === normalizedLeadName)
    ) {
      continue;
    }
    rosterNames.add(normalizedName);
  }
  const launchNames = new Set<string>();
  for (const rawName of [...(summary.missingMembers ?? []), ...(summary.skippedMembers ?? [])]) {
    const name = rawName.trim();
    if (!name) {
      continue;
    }
    const normalizedName = name.toLowerCase();
    if (
      normalizedName === 'user' ||
      isLeadMember({ name }) ||
      (normalizedLeadName && normalizedName === normalizedLeadName)
    ) {
      continue;
    }
    launchNames.add(normalizedName);
  }
  const activeRosterCount = Math.max(summary.memberCount, rosterNames.size);
  if (activeRosterCount > 0) {
    return activeRosterCount;
  }
  return Math.max(
    summary.expectedMemberCount ?? 0,
    launchNames.size,
    (summary.confirmedCount ?? 0) +
      (summary.pendingCount ?? 0) +
      (summary.failedCount ?? 0) +
      (summary.skippedCount ?? 0)
  );
}

export function filterKanbanTasks(
  tasks: TeamTaskWithKanban[],
  query: string
): TeamTaskWithKanban[] {
  if (query.startsWith('#')) {
    const id = query.slice(1);
    return tasks.filter((t) => t.id === id || t.displayId === id);
  }
  const lower = query.toLowerCase();
  return tasks.filter(
    (t) =>
      t.id.toLowerCase().includes(lower) ||
      (t.displayId?.toLowerCase().includes(lower) ?? false) ||
      t.subject.toLowerCase().includes(lower) ||
      (t.owner?.toLowerCase().includes(lower) ?? false)
  );
}

export function buildMessagesPanelTasksSignature(tasks: readonly TeamTaskWithKanban[]): string {
  return JSON.stringify(
    tasks.map((task) => [
      task.id,
      task.displayId ?? '',
      task.subject,
      task.owner ?? '',
      task.reviewer ?? '',
      task.status,
      task.reviewState ?? '',
      task.kanbanColumn ?? '',
    ])
  );
}
