import { normalizePath } from '@renderer/utils/pathNormalize';
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
    const cat = getDateCategory(task.createdAt);
    groups[cat].push(task);
  }

  for (const cat of DATE_CATEGORY_ORDER) {
    groups[cat].sort((a, b) => {
      const cmp = a.teamName.localeCompare(b.teamName);
      if (cmp !== 0) return cmp;
      const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return dateB - dateA;
    });
  }

  return groups;
}

export function getNonEmptyTaskCategories(groups: DateGroupedTasks): DateCategory[] {
  return DATE_CATEGORY_ORDER.filter((cat) => groups[cat].length > 0);
}

const NO_PROJECT_KEY = '__no_project__';
const NO_PROJECT_LABEL = 'Without project';

function trimTrailingPathSep(p: string): string {
  let s = p;
  while (s.length > 0 && (s.endsWith('/') || s.endsWith('\\'))) s = s.slice(0, -1);
  return s;
}

function projectLabelFromPath(path: string): string {
  const normalized = trimTrailingPathSep(path);
  const segments = normalized
    .split('/')
    .flatMap((s) => s.split('\\'))
    .filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : path || NO_PROJECT_LABEL;
}

export function groupTasksByProject(tasks: GlobalTask[]): ProjectTaskGroup[] {
  const byKey = new Map<string, { path: string; tasks: GlobalTask[] }>();

  for (const task of tasks) {
    const path = task.projectPath?.trim() ?? '';
    const key = path ? normalizePath(path) : NO_PROJECT_KEY;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { path: path || '', tasks: [] };
      byKey.set(key, entry);
    }
    entry.tasks.push(task);
  }

  for (const entry of byKey.values()) {
    entry.tasks.sort((a, b) => {
      const cmp = a.teamName.localeCompare(b.teamName);
      if (cmp !== 0) return cmp;
      const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return dateB - dateA;
    });
  }

  const groups: ProjectTaskGroup[] = [];
  for (const [key, { path, tasks: list }] of byKey) {
    const projectLabel = key === NO_PROJECT_KEY ? NO_PROJECT_LABEL : projectLabelFromPath(path);
    groups.push({ projectKey: key, projectLabel, tasks: list });
  }

  groups.sort((a, b) => {
    const tsA = Math.max(
      ...a.tasks.map((t) => (t.createdAt ? new Date(t.createdAt).getTime() : 0))
    );
    const tsB = Math.max(
      ...b.tasks.map((t) => (t.createdAt ? new Date(t.createdAt).getTime() : 0))
    );
    return tsB - tsA;
  });

  return groups;
}
