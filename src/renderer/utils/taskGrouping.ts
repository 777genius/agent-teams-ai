import { normalizePath } from '@renderer/utils/pathNormalize';
import { splitPath } from '@shared/utils/platformPath';
import { differenceInDays, isToday, isYesterday } from 'date-fns';

import { DATE_CATEGORY_ORDER } from '../types/tabs';

import type { DateCategory } from '../types/tabs';
import type { GlobalTask } from '@shared/types';

export type DateGroupedTasks = Record<DateCategory, GlobalTask[]>;

export interface ProjectTaskGroup {
  projectKey: string;
  projectLabel: string;
  tasks: GlobalTask[];
}

/** Returns updatedAt if available, otherwise createdAt. */
function getEffectiveDate(task: GlobalTask): string | undefined {
  return task.updatedAt ?? task.createdAt;
}

function getEffectiveTs(task: GlobalTask): number {
  const d = getEffectiveDate(task);
  return d ? new Date(d).getTime() : 0;
}

/**
 * Build a map: teamName → max effective timestamp among its tasks.
 * Used to sort team sub-groups by most recent activity (not alphabetically).
 */
function buildTeamMaxTs(tasks: GlobalTask[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tasks) {
    const ts = getEffectiveTs(t);
    const cur = m.get(t.teamName) ?? 0;
    if (ts > cur) m.set(t.teamName, ts);
  }
  return m;
}

/**
 * Sort comparator: teams ordered by most recent task (desc),
 * within the same team — by individual task date (desc).
 */
function compareByTeamFreshness(
  a: GlobalTask,
  b: GlobalTask,
  teamMaxTs: Map<string, number>
): number {
  if (a.teamName !== b.teamName) {
    const teamTsA = teamMaxTs.get(a.teamName) ?? 0;
    const teamTsB = teamMaxTs.get(b.teamName) ?? 0;
    return teamTsB - teamTsA;
  }
  return getEffectiveTs(b) - getEffectiveTs(a);
}

function getDateCategory(dateStr: string | undefined): DateCategory {
  if (!dateStr) return 'Older';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 'Older';
  if (isToday(d)) return 'Today';
  if (isYesterday(d)) return 'Yesterday';
  if (differenceInDays(new Date(), d) <= 7) return 'Previous 7 Days';
  return 'Older';
}

export function groupTasksByDate(tasks: GlobalTask[]): DateGroupedTasks {
  const groups: DateGroupedTasks = {
    Today: [],
    Yesterday: [],
    'Previous 7 Days': [],
    Older: [],
  };

  for (const task of tasks) {
    const cat = getDateCategory(getEffectiveDate(task));
    groups[cat].push(task);
  }

  for (const cat of DATE_CATEGORY_ORDER) {
    const teamTs = buildTeamMaxTs(groups[cat]);
    groups[cat].sort((a, b) => compareByTeamFreshness(a, b, teamTs));
  }

  return groups;
}

export function getNonEmptyTaskCategories(groups: DateGroupedTasks): DateCategory[] {
  return DATE_CATEGORY_ORDER.filter((cat) => groups[cat].length > 0);
}

export const NO_PROJECT_KEY = '__no_project__';
export const NO_PROJECT_LABEL = 'No project';

function trimTrailingPathSep(p: string): string {
  let s = p;
  while (s.length > 0 && (s.endsWith('/') || s.endsWith('\\'))) s = s.slice(0, -1);
  return s;
}

export function projectLabelFromPath(path: string): string {
  const normalized = trimTrailingPathSep(path);
  const segments = splitPath(normalized);
  return segments.length > 0 ? segments[segments.length - 1] : path || NO_PROJECT_LABEL;
}

/**
 * Flat sort: newest (by updatedAt/createdAt) first, no grouping.
 * Within the same team, tasks are ordered by freshness.
 * Teams with more recent activity appear first.
 */
export function sortTasksByFreshness(tasks: GlobalTask[]): GlobalTask[] {
  const teamTs = buildTeamMaxTs(tasks);
  return [...tasks].sort((a, b) => compareByTeamFreshness(a, b, teamTs));
}

export function groupTasksByProject(tasks: GlobalTask[]): ProjectTaskGroup[] {
  const byKey = new Map<string, { path: string; tasks: GlobalTask[] }>();

  for (const task of tasks) {
    const path = task.projectPath?.trim() ?? '';
    const key = path ? normalizePath(trimTrailingPathSep(path)) : NO_PROJECT_KEY;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { path: path || '', tasks: [] };
      byKey.set(key, entry);
    }
    entry.tasks.push(task);
  }

  for (const entry of byKey.values()) {
    const teamTs = buildTeamMaxTs(entry.tasks);
    entry.tasks.sort((a, b) => compareByTeamFreshness(a, b, teamTs));
  }

  const groups: ProjectTaskGroup[] = [];
  for (const [key, { path, tasks: list }] of byKey) {
    const projectLabel = key === NO_PROJECT_KEY ? NO_PROJECT_LABEL : projectLabelFromPath(path);
    groups.push({ projectKey: key, projectLabel, tasks: list });
  }

  groups.sort((a, b) => {
    const tsA = Math.max(...a.tasks.map(getEffectiveTs));
    const tsB = Math.max(...b.tasks.map(getEffectiveTs));
    return tsB - tsA;
  });

  return groups;
}
