import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api, isElectronMode } from '@renderer/api';
import { confirm } from '@renderer/components/common/ConfirmDialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useCollapsedGroups } from '@renderer/hooks/useCollapsedGroups';
import { useTaskLocalState } from '@renderer/hooks/useTaskLocalState';
import { useTheme } from '@renderer/hooks/useTheme';
import { cn } from '@renderer/lib/utils';
import { markTaskUnread } from '@renderer/services/commentReadStorage';
import { useStore } from '@renderer/store';
import { getCurrentProvisioningProgressForTeam } from '@renderer/store/slices/teamSlice';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { normalizePath } from '@renderer/utils/pathNormalize';
import { projectColor } from '@renderer/utils/projectColor';
import {
  getNonEmptyTaskCategories,
  groupTasksByDate,
  groupTasksByProject,
  NO_PROJECT_KEY,
  sortTasksByFreshness,
} from '@renderer/utils/taskGrouping';
import { isTeamListStatusRunning, resolveTeamStatus } from '@renderer/utils/teamListStatus';
import { deriveTaskDisplayId } from '@shared/utils/taskIdentity';
import {
  Archive,
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  ListTodo,
  Pin,
  Search,
  X,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { AnimatedHeightReveal } from '../team/activity/AnimatedHeightReveal';
import { type ComboboxOption } from '../ui/combobox';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

import {
  canProjectGroupShowLess,
  canProjectGroupShowMore,
  getNextProjectGroupVisibleCount,
  getPreviousProjectGroupVisibleCount,
  getProjectGroupVisibleCount,
  syncProjectGroupVisibleCountByKey,
} from './projectGroupPagination';
import { SidebarTaskItem } from './SidebarTaskItem';
import { TaskContextMenu } from './TaskContextMenu';
import { TaskFiltersPopover } from './TaskFiltersPopover';
import {
  defaultTaskFiltersState,
  getTaskUnreadCount,
  taskMatchesStatus,
  useReadStateSnapshot,
} from './taskFiltersState';

import type { TaskFiltersState } from './taskFiltersState';
import type { GlobalTask, LeadActivityState, TeamSummary } from '@shared/types';

const TASK_GROUPING_STORAGE_KEY = 'sidebarTasksGrouping';

export type TaskGroupingMode = 'none' | 'project' | 'time';

function loadGroupingMode(): TaskGroupingMode {
  try {
    const v = localStorage.getItem(TASK_GROUPING_STORAGE_KEY);
    if (v === 'none' || v === 'project' || v === 'time') return v;
  } catch {
    /* ignore */
  }
  return 'project';
}

function saveGroupingMode(mode: TaskGroupingMode): void {
  try {
    localStorage.setItem(TASK_GROUPING_STORAGE_KEY, mode);
  } catch {
    /* ignore */
  }
}

export type TaskSortMode = 'time' | 'project' | 'team' | 'unread';

const TASK_SORT_STORAGE_KEY = 'sidebarTasksSort';

const SORT_OPTIONS = [
  { id: 'time', labelKey: 'tasksPanel.sort.byTime' },
  { id: 'unread', labelKey: 'tasksPanel.sort.byUnread' },
  { id: 'project', labelKey: 'tasksPanel.sort.byProject' },
  { id: 'team', labelKey: 'tasksPanel.sort.byTeam' },
] as const satisfies readonly { id: TaskSortMode; labelKey: string }[];

function loadSortMode(): TaskSortMode {
  try {
    const v = localStorage.getItem(TASK_SORT_STORAGE_KEY);
    if (v === 'time' || v === 'project' || v === 'team' || v === 'unread') return v;
  } catch {
    /* ignore */
  }
  return 'time';
}

function saveSortMode(mode: TaskSortMode): void {
  try {
    localStorage.setItem(TASK_SORT_STORAGE_KEY, mode);
  } catch {
    /* ignore */
  }
}

function applySortMode(
  tasks: GlobalTask[],
  mode: TaskSortMode,
  readState?: ReturnType<typeof useReadStateSnapshot>
): GlobalTask[] {
  const sorted = [...tasks];
  switch (mode) {
    case 'time':
      return sortTasksByFreshness(sorted);
    case 'unread':
      return sorted.sort((a, b) => {
        const ua = readState ? getTaskUnreadCount(readState, a.teamName, a.id, a.comments) : 0;
        const ub = readState ? getTaskUnreadCount(readState, b.teamName, b.id, b.comments) : 0;
        if (ub !== ua) return ub - ua;
        return (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? '');
      });
    case 'project':
      return sorted.sort((a, b) => {
        const pa = a.projectPath ?? '';
        const pb = b.projectPath ?? '';
        const cmp = pa.localeCompare(pb);
        if (cmp !== 0) return cmp;
        return (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? '');
      });
    case 'team':
      return sorted.sort((a, b) => {
        const cmp = a.teamDisplayName.localeCompare(b.teamDisplayName);
        if (cmp !== 0) return cmp;
        return (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? '');
      });
    default:
      return sortTasksByFreshness(sorted);
  }
}

export interface GlobalTaskListProps {
  /** When true, do not render the header row (Tasks + Filters); parent renders tabs and filters. */
  hideHeader?: boolean;
  /** External filters state when used with sidebar tabs. */
  filters?: TaskFiltersState;
  onFiltersChange?: (f: TaskFiltersState) => void;
  filtersPopoverOpen?: boolean;
  onFiltersPopoverOpenChange?: (open: boolean) => void;
}

const dateCategoryLabels: Record<string, string> = {
  'Previous 7 Days': 'Last 7 Days',
  Older: 'Earlier',
};

type ProjectTaskGroupData = ReturnType<typeof groupTasksByProject>[number];
const EMPTY_TASKS: GlobalTask[] = [];
const EMPTY_PROJECT_GROUPS: ProjectTaskGroupData[] = [];
const EMPTY_DATE_GROUPS: ReturnType<typeof groupTasksByDate> = {
  Today: [],
  Yesterday: [],
  'Previous 7 Days': [],
  Older: [],
};
const EMPTY_DATE_CATEGORIES: ReturnType<typeof getNonEmptyTaskCategories> = [];

function applySearch(tasks: GlobalTask[], query: string): GlobalTask[] {
  if (!query.trim()) return tasks;
  const q = query.toLowerCase();
  return tasks.filter(
    (t) =>
      t.subject.toLowerCase().includes(q) ||
      t.owner?.toLowerCase().includes(q) ||
      t.teamDisplayName.toLowerCase().includes(q)
  );
}

function applyProjectFilter(tasks: GlobalTask[], projectPath: string | null): GlobalTask[] {
  if (!projectPath) return tasks;
  const normalized = normalizePath(projectPath);
  return tasks.filter((t) => t.projectPath && normalizePath(t.projectPath) === normalized);
}

function buildTaskTeamSummary(task: GlobalTask): TeamSummary {
  return {
    teamName: task.teamName,
    displayName: task.teamDisplayName,
    description: '',
    memberCount: 0,
    taskCount: 0,
    lastActivity: task.updatedAt ?? task.createdAt ?? null,
    projectPath: task.projectPath,
  };
}

function buildTaskLocalPresentationKey(task: GlobalTask): string {
  return `${task.teamName}:${task.id}`;
}

function buildTaskLocalPresentationState(
  task: GlobalTask,
  pinnedIds: ReadonlySet<string>,
  archivedIds: ReadonlySet<string>,
  renamedSubjects: ReadonlyMap<string, string>
): TaskLocalPresentationState {
  const key = buildTaskLocalPresentationKey(task);
  return {
    key,
    pinned: pinnedIds.has(key),
    archived: archivedIds.has(key),
    renamedSubject: renamedSubjects.get(key),
  };
}

function buildTaskLocalPresentationByTask(
  tasks: readonly GlobalTask[],
  pinnedIds: ReadonlySet<string>,
  archivedIds: ReadonlySet<string>,
  renamedSubjects: ReadonlyMap<string, string>
): WeakMap<GlobalTask, TaskLocalPresentationState> {
  const presentationByTask = new WeakMap<GlobalTask, TaskLocalPresentationState>();
  for (const task of tasks) {
    presentationByTask.set(
      task,
      buildTaskLocalPresentationState(task, pinnedIds, archivedIds, renamedSubjects)
    );
  }
  return presentationByTask;
}

type TaskRowAction = (teamName: string, taskId: string) => void;
type TaskRowDeleteAction = (teamName: string, taskId: string) => void | Promise<void>;
type TeamBooleanResolver = (teamName: string) => boolean;
type TaskOwnerColorResolver = (task: GlobalTask) => string | null | undefined;
type TeamHeaderFormatter = (teamDisplayName: string) => string;
type ProjectGroupVisibleCountChange = (projectKey: string, visibleCount: number) => void;
type TeamMemberColorInput = Parameters<typeof buildMemberColorMap>[0][number];

interface TaskLocalPresentationState {
  key: string;
  pinned: boolean;
  archived: boolean;
  renamedSubject: string | undefined;
}

type TaskLocalPresentationResolver = (task: GlobalTask) => TaskLocalPresentationState;
interface SidebarTeamsDerived {
  identityKey: string;
  filterTeams: { teamName: string; displayName: string }[];
  statusSummaries: TeamSummary[];
  memberColorByTeam: Map<string, Map<string, string>>;
}

let cachedSidebarTeamsSignature: string | null = null;
let cachedSidebarTeamsSource: readonly TeamSummary[] | null = null;
let cachedSidebarTeamsDerived: SidebarTeamsDerived = {
  identityKey: '',
  filterTeams: [],
  statusSummaries: [],
  memberColorByTeam: new Map(),
};
const cachedSidebarTeamSignatureByTeam = new WeakMap<TeamSummary, string>();
let cachedLeadOfflineTeamsSource: Partial<Record<string, LeadActivityState>> | null = null;
let cachedLeadOfflineTeamsSignature = '';
let cachedLeadOfflineTeamNames: string[] = [];

function encodeSignaturePart(part: unknown): string {
  const text = part == null ? '' : String(part);
  return `${text.length}:${text}|`;
}

function pushSignaturePart(parts: string[], part: unknown): void {
  parts.push(encodeSignaturePart(part));
}

function getSidebarTeamSignature(team: TeamSummary): string {
  const cached = cachedSidebarTeamSignatureByTeam.get(team);
  if (cached !== undefined) return cached;

  let signature = '';
  signature += encodeSignaturePart(team.teamName);
  signature += encodeSignaturePart(team.displayName);
  signature += encodeSignaturePart(team.projectPath);
  signature += encodeSignaturePart(team.lastActivity);
  signature += encodeSignaturePart(team.partialLaunchFailure ? 1 : 0);
  signature += encodeSignaturePart(team.teamLaunchState);
  for (const member of team.members ?? []) {
    const colorMember = member as TeamMemberColorInput;
    signature += encodeSignaturePart(colorMember.name);
    signature += encodeSignaturePart(colorMember.color);
    signature += encodeSignaturePart(colorMember.agentType);
    signature += encodeSignaturePart(colorMember.removedAt);
  }

  cachedSidebarTeamSignatureByTeam.set(team, signature);
  return signature;
}

function buildSidebarTeamsSignature(teams: readonly TeamSummary[]): string {
  let signature = '';
  for (const team of teams) {
    signature += getSidebarTeamSignature(team);
  }
  return signature;
}

function buildTeamNamesIdentityKey(teams: readonly TeamSummary[]): string {
  const signatureParts: string[] = [];
  for (const team of teams) {
    pushSignaturePart(signatureParts, team.teamName);
  }
  return signatureParts.join('');
}

function selectLeadOfflineTeamNames(
  leadActivityByTeam: Partial<Record<string, LeadActivityState>>
): string[] {
  if (leadActivityByTeam === cachedLeadOfflineTeamsSource) {
    return cachedLeadOfflineTeamNames;
  }

  const offlineTeamNames: string[] = [];
  for (const [teamName, activity] of Object.entries(leadActivityByTeam)) {
    if (activity === 'offline') {
      offlineTeamNames.push(teamName);
    }
  }
  offlineTeamNames.sort();

  const signatureParts: string[] = [];
  for (const teamName of offlineTeamNames) {
    pushSignaturePart(signatureParts, teamName);
  }
  const signature = signatureParts.join('');

  if (signature === cachedLeadOfflineTeamsSignature) {
    cachedLeadOfflineTeamsSource = leadActivityByTeam;
    return cachedLeadOfflineTeamNames;
  }

  cachedLeadOfflineTeamsSource = leadActivityByTeam;
  cachedLeadOfflineTeamsSignature = signature;
  cachedLeadOfflineTeamNames = offlineTeamNames;
  return cachedLeadOfflineTeamNames;
}

function selectSidebarTeamsDerived(teams: readonly TeamSummary[]): SidebarTeamsDerived {
  if (teams === cachedSidebarTeamsSource) {
    return cachedSidebarTeamsDerived;
  }

  const signature = buildSidebarTeamsSignature(teams);
  if (signature === cachedSidebarTeamsSignature) {
    cachedSidebarTeamsSource = teams;
    return cachedSidebarTeamsDerived;
  }

  const memberColorByTeam = new Map<string, Map<string, string>>();
  for (const team of teams) {
    if (team.members && team.members.length > 0) {
      memberColorByTeam.set(team.teamName, buildMemberColorMap(team.members));
    }
  }

  cachedSidebarTeamsSource = teams;
  cachedSidebarTeamsSignature = signature;
  cachedSidebarTeamsDerived = {
    identityKey: buildTeamNamesIdentityKey(teams),
    filterTeams: teams.map((team) => ({
      teamName: team.teamName,
      displayName: team.displayName,
    })),
    statusSummaries: teams.map((team) => ({
      teamName: team.teamName,
      displayName: team.displayName,
      description: '',
      memberCount: team.memberCount,
      taskCount: team.taskCount,
      projectPath: team.projectPath,
      lastActivity: team.lastActivity,
      partialLaunchFailure: team.partialLaunchFailure,
      teamLaunchState: team.teamLaunchState,
    })),
    memberColorByTeam,
  };
  return cachedSidebarTeamsDerived;
}

interface GlobalTaskRowProps {
  task: GlobalTask;
  taskLocalKey: string;
  isPinned: boolean;
  isArchived: boolean;
  isNew: boolean;
  teamOffline: boolean;
  renamingKey: string | null;
  hideTeamName?: boolean;
  hideProjectName?: boolean;
  showTeamName?: boolean;
  revealTeamNameOnTaskHover?: boolean;
  isLight: boolean;
  onTogglePin: TaskRowAction;
  onToggleArchive: TaskRowAction;
  onMarkUnread: TaskRowAction;
  onRename: TaskRowAction;
  onDelete: TaskRowDeleteAction;
  onRenameComplete: (teamName: string, taskId: string, newSubject: string) => void;
  onRenameCancel: () => void;
  displaySubjectOverride?: string;
  ownerColorName?: string | null;
}

function taskCommentsDisplayEqual(
  prev: GlobalTask['comments'],
  next: GlobalTask['comments']
): boolean {
  if (prev === next) return true;
  if (!prev || !next) return (prev?.length ?? 0) === (next?.length ?? 0);
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i += 1) {
    if (prev[i].id !== next[i].id || prev[i].createdAt !== next[i].createdAt) {
      return false;
    }
  }
  return true;
}

function taskSidebarFieldsEqual(prev: GlobalTask, next: GlobalTask): boolean {
  return (
    prev === next ||
    (prev.id === next.id &&
      prev.teamName === next.teamName &&
      prev.teamDisplayName === next.teamDisplayName &&
      prev.teamDeleted === next.teamDeleted &&
      prev.subject === next.subject &&
      prev.owner === next.owner &&
      prev.status === next.status &&
      prev.createdAt === next.createdAt &&
      prev.updatedAt === next.updatedAt &&
      prev.projectPath === next.projectPath &&
      prev.reviewState === next.reviewState &&
      prev.kanbanColumn === next.kanbanColumn &&
      prev.deletedAt === next.deletedAt &&
      taskCommentsDisplayEqual(prev.comments, next.comments))
  );
}

function effectiveRenamingKey(taskLocalKey: string, renamingKey: string | null): string | null {
  return renamingKey === taskLocalKey ? renamingKey : null;
}

const GlobalTaskRow = memo(
  function GlobalTaskRow({
    task,
    taskLocalKey,
    isPinned,
    isArchived,
    isNew,
    teamOffline,
    renamingKey,
    hideTeamName,
    hideProjectName,
    showTeamName,
    revealTeamNameOnTaskHover,
    isLight,
    onTogglePin,
    onToggleArchive,
    onMarkUnread,
    onRename,
    onDelete,
    onRenameComplete,
    onRenameCancel,
    displaySubjectOverride,
    ownerColorName,
  }: GlobalTaskRowProps): React.JSX.Element {
    const rowRenamingKey = effectiveRenamingKey(taskLocalKey, renamingKey);

    const handleTogglePin = useCallback(() => {
      onTogglePin(task.teamName, task.id);
    }, [onTogglePin, task.id, task.teamName]);

    const handleToggleArchive = useCallback(() => {
      onToggleArchive(task.teamName, task.id);
    }, [onToggleArchive, task.id, task.teamName]);

    const handleMarkUnread = useCallback(() => {
      onMarkUnread(task.teamName, task.id);
    }, [onMarkUnread, task.id, task.teamName]);

    const handleRename = useCallback(() => {
      onRename(task.teamName, task.id);
    }, [onRename, task.id, task.teamName]);

    const handleDelete = useCallback(() => {
      void onDelete(task.teamName, task.id);
    }, [onDelete, task.id, task.teamName]);

    return (
      <TaskContextMenu
        task={task}
        isPinned={isPinned}
        isArchived={isArchived}
        onTogglePin={handleTogglePin}
        onToggleArchive={handleToggleArchive}
        onMarkUnread={handleMarkUnread}
        onRename={handleRename}
        onDelete={handleDelete}
      >
        <AnimatedHeightReveal animate={isNew}>
          <SidebarTaskItem
            task={task}
            hideTeamName={hideTeamName}
            hideProjectName={hideProjectName}
            showTeamName={showTeamName}
            revealTeamNameOnTaskHover={revealTeamNameOnTaskHover}
            isLight={isLight}
            teamOffline={teamOffline}
            renamingKey={rowRenamingKey}
            onRenameComplete={onRenameComplete}
            onRenameCancel={onRenameCancel}
            displaySubjectOverride={displaySubjectOverride}
            ownerColorName={ownerColorName}
          />
        </AnimatedHeightReveal>
      </TaskContextMenu>
    );
  },
  (prev, next) =>
    taskSidebarFieldsEqual(prev.task, next.task) &&
    prev.taskLocalKey === next.taskLocalKey &&
    prev.isPinned === next.isPinned &&
    prev.isArchived === next.isArchived &&
    prev.isNew === next.isNew &&
    prev.teamOffline === next.teamOffline &&
    effectiveRenamingKey(prev.taskLocalKey, prev.renamingKey) ===
      effectiveRenamingKey(next.taskLocalKey, next.renamingKey) &&
    prev.hideTeamName === next.hideTeamName &&
    prev.hideProjectName === next.hideProjectName &&
    prev.showTeamName === next.showTeamName &&
    prev.revealTeamNameOnTaskHover === next.revealTeamNameOnTaskHover &&
    prev.isLight === next.isLight &&
    prev.onTogglePin === next.onTogglePin &&
    prev.onToggleArchive === next.onToggleArchive &&
    prev.onMarkUnread === next.onMarkUnread &&
    prev.onRename === next.onRename &&
    prev.onDelete === next.onDelete &&
    prev.onRenameComplete === next.onRenameComplete &&
    prev.onRenameCancel === next.onRenameCancel &&
    prev.displaySubjectOverride === next.displaySubjectOverride &&
    prev.ownerColorName === next.ownerColorName
);

interface TaskRowsProps {
  tasks: GlobalTask[];
  visibleCount?: number;
  keyPrefix?: string;
  getTaskLocalPresentation: TaskLocalPresentationResolver;
  isNewTask: (task: GlobalTask) => boolean;
  isTeamOffline: TeamBooleanResolver;
  renamingKey: string | null;
  hideTeamName?: boolean;
  hideProjectName?: boolean;
  showTeamName?: boolean;
  revealTeamNameOnTaskHover?: boolean;
  isLight: boolean;
  showTeamHeader?: boolean;
  pinnedOverride?: boolean;
  archivedOverride?: boolean;
  formatTeamHeader?: TeamHeaderFormatter;
  onTogglePin: TaskRowAction;
  onToggleArchive: TaskRowAction;
  onMarkUnread: TaskRowAction;
  onRename: TaskRowAction;
  onDelete: TaskRowDeleteAction;
  onRenameComplete: (teamName: string, taskId: string, newSubject: string) => void;
  onRenameCancel: () => void;
  getOwnerColorName: TaskOwnerColorResolver;
}

type TaskRowsDerivedProps = Pick<
  TaskRowsProps,
  | 'tasks'
  | 'visibleCount'
  | 'getTaskLocalPresentation'
  | 'isNewTask'
  | 'isTeamOffline'
  | 'pinnedOverride'
  | 'archivedOverride'
  | 'getOwnerColorName'
>;

function getTaskRowsVisibleTasks(
  props: Pick<TaskRowsProps, 'tasks' | 'visibleCount'>
): GlobalTask[] {
  return typeof props.visibleCount === 'number'
    ? props.tasks.slice(0, props.visibleCount)
    : props.tasks;
}

function areTaskRowsDerivedValuesEqual(
  prev: TaskRowsDerivedProps,
  next: TaskRowsDerivedProps
): boolean {
  const prevVisibleTasks = getTaskRowsVisibleTasks(prev);
  const nextVisibleTasks = getTaskRowsVisibleTasks(next);
  if (!areTaskSidebarArraysEqual(prevVisibleTasks, nextVisibleTasks)) {
    return false;
  }

  for (let index = 0; index < prevVisibleTasks.length; index += 1) {
    const prevTask = prevVisibleTasks[index];
    const nextTask = nextVisibleTasks[index];
    if (!prevTask || !nextTask) {
      return false;
    }
    const prevLocalPresentation = prev.getTaskLocalPresentation(prevTask);
    const nextLocalPresentation = next.getTaskLocalPresentation(nextTask);
    if (
      (prev.pinnedOverride ?? prevLocalPresentation.pinned) !==
        (next.pinnedOverride ?? nextLocalPresentation.pinned) ||
      (prev.archivedOverride ?? prevLocalPresentation.archived) !==
        (next.archivedOverride ?? nextLocalPresentation.archived) ||
      prev.isNewTask(prevTask) !== next.isNewTask(nextTask) ||
      prev.isTeamOffline(prevTask.teamName) !== next.isTeamOffline(nextTask.teamName) ||
      prevLocalPresentation.renamedSubject !== nextLocalPresentation.renamedSubject ||
      prev.getOwnerColorName(prevTask) !== next.getOwnerColorName(nextTask)
    ) {
      return false;
    }
  }

  return true;
}

const TaskRows = memo(function TaskRows({
  tasks,
  visibleCount,
  keyPrefix = '',
  getTaskLocalPresentation,
  isNewTask,
  isTeamOffline,
  renamingKey,
  hideTeamName,
  hideProjectName,
  showTeamName,
  revealTeamNameOnTaskHover,
  isLight,
  showTeamHeader,
  pinnedOverride,
  archivedOverride,
  formatTeamHeader,
  onTogglePin,
  onToggleArchive,
  onMarkUnread,
  onRename,
  onDelete,
  onRenameComplete,
  onRenameCancel,
  getOwnerColorName,
}: TaskRowsProps): React.JSX.Element {
  let lastTeam: string | null = null;
  const visibleTasks = typeof visibleCount === 'number' ? tasks.slice(0, visibleCount) : tasks;

  return (
    <>
      {visibleTasks.map((task) => {
        const taskLocalPresentation = getTaskLocalPresentation(task);
        const taskKey = `${keyPrefix}${task.teamName}-${task.id}`;
        const row = (
          <GlobalTaskRow
            key={taskKey}
            task={task}
            taskLocalKey={taskLocalPresentation.key}
            isPinned={pinnedOverride ?? taskLocalPresentation.pinned}
            isArchived={archivedOverride ?? taskLocalPresentation.archived}
            isNew={isNewTask(task)}
            hideTeamName={hideTeamName}
            hideProjectName={hideProjectName}
            showTeamName={showTeamName}
            revealTeamNameOnTaskHover={revealTeamNameOnTaskHover}
            isLight={isLight}
            teamOffline={isTeamOffline(task.teamName)}
            ownerColorName={getOwnerColorName(task)}
            renamingKey={renamingKey}
            onTogglePin={onTogglePin}
            onToggleArchive={onToggleArchive}
            onMarkUnread={onMarkUnread}
            onRename={onRename}
            onDelete={onDelete}
            onRenameComplete={onRenameComplete}
            onRenameCancel={onRenameCancel}
            displaySubjectOverride={taskLocalPresentation.renamedSubject}
          />
        );

        if (!showTeamHeader || !formatTeamHeader) {
          return row;
        }

        const shouldShowTeamHeader = task.teamName !== lastTeam;
        lastTeam = task.teamName;

        return (
          <div key={taskKey}>
            {shouldShowTeamHeader && (
              <div className="px-3 pb-0.5 pt-1.5 text-[10px] font-medium text-text-muted">
                {formatTeamHeader(task.teamDisplayName)}
              </div>
            )}
            {row}
          </div>
        );
      })}
    </>
  );
}, areTaskRowsPropsEqual);

function areTaskRowsPropsEqual(prev: TaskRowsProps, next: TaskRowsProps): boolean {
  return (
    prev.visibleCount === next.visibleCount &&
    prev.keyPrefix === next.keyPrefix &&
    prev.hideTeamName === next.hideTeamName &&
    prev.hideProjectName === next.hideProjectName &&
    prev.showTeamName === next.showTeamName &&
    prev.revealTeamNameOnTaskHover === next.revealTeamNameOnTaskHover &&
    prev.isLight === next.isLight &&
    prev.showTeamHeader === next.showTeamHeader &&
    prev.pinnedOverride === next.pinnedOverride &&
    prev.archivedOverride === next.archivedOverride &&
    prev.formatTeamHeader === next.formatTeamHeader &&
    prev.renamingKey === next.renamingKey &&
    prev.onTogglePin === next.onTogglePin &&
    prev.onToggleArchive === next.onToggleArchive &&
    prev.onMarkUnread === next.onMarkUnread &&
    prev.onRename === next.onRename &&
    prev.onDelete === next.onDelete &&
    prev.onRenameComplete === next.onRenameComplete &&
    prev.onRenameCancel === next.onRenameCancel &&
    areTaskRowsDerivedValuesEqual(prev, next)
  );
}

function areTaskSidebarArraysEqual(
  prev: readonly GlobalTask[],
  next: readonly GlobalTask[]
): boolean {
  if (prev === next) return true;
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i += 1) {
    if (!taskSidebarFieldsEqual(prev[i], next[i])) {
      return false;
    }
  }
  return true;
}

interface ProjectTaskGroupProps {
  group: ProjectTaskGroupData;
  isCollapsed: boolean;
  showTeamHeader: boolean;
  visibleCount: number;
  noProjectGroupColor: ReturnType<typeof projectColor>;
  showMoreLabel: string;
  showLessLabel: string;
  getTaskLocalPresentation: TaskLocalPresentationResolver;
  isNewTask: (task: GlobalTask) => boolean;
  isTeamOffline: TeamBooleanResolver;
  renamingKey: string | null;
  isLight: boolean;
  formatTeamHeader: TeamHeaderFormatter;
  onToggleGroup: (projectKey: string) => void;
  onVisibleCountChange: ProjectGroupVisibleCountChange;
  onTogglePin: TaskRowAction;
  onToggleArchive: TaskRowAction;
  onMarkUnread: TaskRowAction;
  onRename: TaskRowAction;
  onDelete: TaskRowDeleteAction;
  onRenameComplete: (teamName: string, taskId: string, newSubject: string) => void;
  onRenameCancel: () => void;
  getOwnerColorName: TaskOwnerColorResolver;
}

const ProjectTaskGroup = memo(
  function ProjectTaskGroup({
    group,
    isCollapsed,
    showTeamHeader,
    visibleCount,
    noProjectGroupColor,
    showMoreLabel,
    showLessLabel,
    getTaskLocalPresentation,
    isNewTask,
    isTeamOffline,
    renamingKey,
    isLight,
    formatTeamHeader,
    onToggleGroup,
    onVisibleCountChange,
    onTogglePin,
    onToggleArchive,
    onMarkUnread,
    onRename,
    onDelete,
    onRenameComplete,
    onRenameCancel,
    getOwnerColorName,
  }: ProjectTaskGroupProps): React.JSX.Element | null {
    if (group.tasks.length === 0) return null;

    const isNoProjectGroup = group.projectKey === NO_PROJECT_KEY;
    const groupColor = isNoProjectGroup ? noProjectGroupColor : projectColor(group.projectLabel);
    const showMoreVisible = canProjectGroupShowMore(visibleCount, group.tasks.length);
    const showLessVisible = canProjectGroupShowLess(visibleCount, group.tasks.length);

    return (
      <div>
        <button
          type="button"
          onClick={() => onToggleGroup(group.projectKey)}
          className="hover:bg-surface-raised/40 sticky top-0 z-10 flex w-full cursor-pointer items-center gap-1.5 p-2 transition-colors"
          style={{
            backgroundColor: 'var(--color-surface-sidebar)',
            backgroundImage: isNoProjectGroup
              ? undefined
              : `linear-gradient(90deg, ${groupColor.glow} 0%, transparent 80%)`,
            boxShadow: `inset 2px 0 0 ${groupColor.border}, inset 0 -1px 0 var(--color-border)`,
          }}
        >
          {isCollapsed ? (
            <ChevronRight className="size-3 shrink-0 text-text-muted" />
          ) : (
            <ChevronDown className="size-3 shrink-0 text-text-muted" />
          )}
          <Folder
            className="size-3.5 shrink-0"
            style={{ color: groupColor.icon }}
            aria-hidden="true"
          />
          <span
            className="truncate text-[11px] font-bold leading-none"
            style={{ color: groupColor.icon }}
          >
            {group.projectLabel}
          </span>
          <span className="ml-auto shrink-0 text-[10px] font-normal text-text-muted">
            {group.tasks.length}
          </span>
        </button>
        {!isCollapsed && (
          <TaskRows
            tasks={group.tasks}
            visibleCount={visibleCount}
            getTaskLocalPresentation={getTaskLocalPresentation}
            isNewTask={isNewTask}
            isTeamOffline={isTeamOffline}
            isLight={isLight}
            hideTeamName
            hideProjectName
            showTeamHeader={showTeamHeader}
            formatTeamHeader={formatTeamHeader}
            renamingKey={renamingKey}
            onTogglePin={onTogglePin}
            onToggleArchive={onToggleArchive}
            onMarkUnread={onMarkUnread}
            onRename={onRename}
            onDelete={onDelete}
            onRenameComplete={onRenameComplete}
            onRenameCancel={onRenameCancel}
            getOwnerColorName={getOwnerColorName}
          />
        )}
        {!isCollapsed && (showMoreVisible || showLessVisible) && (
          <div className="flex items-center gap-2 px-3 pb-2 pt-1">
            {showMoreVisible && (
              <button
                type="button"
                className="text-[11px] font-medium text-text-muted transition-colors hover:text-text"
                onClick={() =>
                  onVisibleCountChange(
                    group.projectKey,
                    getNextProjectGroupVisibleCount(visibleCount, group.tasks.length)
                  )
                }
              >
                {showMoreLabel}
              </button>
            )}
            {showLessVisible && (
              <button
                type="button"
                className="text-[11px] font-medium text-text-muted transition-colors hover:text-text"
                onClick={() =>
                  onVisibleCountChange(
                    group.projectKey,
                    getPreviousProjectGroupVisibleCount(visibleCount, group.tasks.length)
                  )
                }
              >
                {showLessLabel}
              </button>
            )}
          </div>
        )}
      </div>
    );
  },
  (prev, next) =>
    prev.group.projectKey === next.group.projectKey &&
    prev.group.projectLabel === next.group.projectLabel &&
    prev.group.tasks.length === next.group.tasks.length &&
    prev.isCollapsed === next.isCollapsed &&
    prev.showTeamHeader === next.showTeamHeader &&
    prev.visibleCount === next.visibleCount &&
    prev.noProjectGroupColor === next.noProjectGroupColor &&
    prev.showMoreLabel === next.showMoreLabel &&
    prev.showLessLabel === next.showLessLabel &&
    prev.renamingKey === next.renamingKey &&
    prev.isLight === next.isLight &&
    prev.formatTeamHeader === next.formatTeamHeader &&
    prev.onToggleGroup === next.onToggleGroup &&
    prev.onVisibleCountChange === next.onVisibleCountChange &&
    prev.onTogglePin === next.onTogglePin &&
    prev.onToggleArchive === next.onToggleArchive &&
    prev.onMarkUnread === next.onMarkUnread &&
    prev.onRename === next.onRename &&
    prev.onDelete === next.onDelete &&
    prev.onRenameComplete === next.onRenameComplete &&
    prev.onRenameCancel === next.onRenameCancel &&
    areTaskRowsDerivedValuesEqual(
      {
        tasks: prev.group.tasks,
        visibleCount: prev.visibleCount,
        getTaskLocalPresentation: prev.getTaskLocalPresentation,
        isNewTask: prev.isNewTask,
        isTeamOffline: prev.isTeamOffline,
        getOwnerColorName: prev.getOwnerColorName,
      },
      {
        tasks: next.group.tasks,
        visibleCount: next.visibleCount,
        getTaskLocalPresentation: next.getTaskLocalPresentation,
        isNewTask: next.isNewTask,
        isTeamOffline: next.isTeamOffline,
        getOwnerColorName: next.getOwnerColorName,
      }
    )
);

export const GlobalTaskList = memo<GlobalTaskListProps>(function GlobalTaskList({
  hideHeader = false,
  filters: externalFilters,
  onFiltersChange: externalOnFiltersChange,
  filtersPopoverOpen: externalFiltersPopoverOpen,
  onFiltersPopoverOpenChange: externalOnFiltersPopoverOpenChange,
}: GlobalTaskListProps = {}): React.JSX.Element {
  const { t } = useAppTranslation('common');
  const { isLight } = useTheme();
  const {
    globalTasks,
    globalTasksLoading,
    globalTasksInitialized,
    fetchAllTasks,
    fetchProjects,
    fetchRepositoryGroups,
    softDeleteTask,
    projects,
    projectsLoading,
    projectsInitialized,
    projectsError,
    viewMode,
    repositoryGroups,
    repositoryGroupsLoading,
    repositoryGroupsInitialized,
    repositoryGroupsError,
    provisioningRuns,
    currentProvisioningRunIdByTeam,
    leadOfflineTeamNames,
  } = useStore(
    useShallow((s) => ({
      globalTasks: s.globalTasks,
      globalTasksLoading: s.globalTasksLoading,
      globalTasksInitialized: s.globalTasksInitialized,
      fetchAllTasks: s.fetchAllTasks,
      fetchProjects: s.fetchProjects,
      fetchRepositoryGroups: s.fetchRepositoryGroups,
      softDeleteTask: s.softDeleteTask,
      projects: s.projects,
      projectsLoading: s.projectsLoading,
      projectsInitialized: s.projectsInitialized,
      projectsError: s.projectsError,
      viewMode: s.viewMode,
      repositoryGroups: s.repositoryGroups,
      repositoryGroupsLoading: s.repositoryGroupsLoading,
      repositoryGroupsInitialized: s.repositoryGroupsInitialized,
      repositoryGroupsError: s.repositoryGroupsError,
      provisioningRuns: s.provisioningRuns,
      currentProvisioningRunIdByTeam: s.currentProvisioningRunIdByTeam,
      leadOfflineTeamNames: selectLeadOfflineTeamNames(s.leadActivityByTeam),
    }))
  );
  const sidebarTeams = useStore((s) => selectSidebarTeamsDerived(s.teams));

  const [internalFilters, setInternalFilters] = useState(defaultTaskFiltersState);
  const [internalFiltersPopoverOpen, setInternalFiltersPopoverOpen] = useState(false);
  const filters = externalFilters ?? internalFilters;
  const setFilters = externalOnFiltersChange ?? setInternalFilters;
  const filtersPopoverOpen = externalFiltersPopoverOpen ?? internalFiltersPopoverOpen;
  const setFiltersPopoverOpen = externalOnFiltersPopoverOpenChange ?? setInternalFiltersPopoverOpen;
  const [searchQuery, setSearchQuery] = useState('');
  const [searchVisible, setSearchVisible] = useState(false);
  const [groupingMode, setGroupingModeState] = useState<TaskGroupingMode>(loadGroupingMode);
  const [groupingPopoverOpen, setGroupingPopoverOpen] = useState(false);
  const [sortMode, setSortModeState] = useState<TaskSortMode>(loadSortMode);
  const [sortPopoverOpen, setSortPopoverOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [renamingTaskKey, setRenamingTaskKey] = useState<string | null>(null);
  const [aliveTeams, setAliveTeams] = useState<string[]>([]);
  const [aliveTeamsInitialized, setAliveTeamsInitialized] = useState(false);
  const [projectRequestedVisibleCountByKey, setProjectRequestedVisibleCountByKey] = useState<
    Record<string, number>
  >({});
  const searchInputRef = useRef<HTMLInputElement>(null);
  const hasFetchedRef = useRef(false);
  const readState = useReadStateSnapshot();
  const taskLocalState = useTaskLocalState();
  const electronMode = isElectronMode();

  useEffect(() => {
    if (searchVisible) {
      searchInputRef.current?.focus();
    }
  }, [searchVisible]);

  const taskLocalPresentationByTask = useMemo(
    () =>
      buildTaskLocalPresentationByTask(
        globalTasks,
        taskLocalState.pinnedIds,
        taskLocalState.archivedIds,
        taskLocalState.renamedSubjects
      ),
    [
      globalTasks,
      taskLocalState.pinnedIds,
      taskLocalState.archivedIds,
      taskLocalState.renamedSubjects,
    ]
  );

  const getTaskLocalPresentation = useCallback(
    (task: GlobalTask): TaskLocalPresentationState =>
      taskLocalPresentationByTask.get(task) ??
      buildTaskLocalPresentationState(
        task,
        taskLocalState.pinnedIds,
        taskLocalState.archivedIds,
        taskLocalState.renamedSubjects
      ),
    [
      taskLocalPresentationByTask,
      taskLocalState.pinnedIds,
      taskLocalState.archivedIds,
      taskLocalState.renamedSubjects,
    ]
  );

  const provisioningState = useMemo(
    () => ({ currentProvisioningRunIdByTeam, provisioningRuns }),
    [currentProvisioningRunIdByTeam, provisioningRuns]
  );

  const fetchAliveTeams = useCallback(async (): Promise<string[] | null> => {
    if (!electronMode || !api.teams?.aliveList) return null;
    try {
      return await api.teams.aliveList();
    } catch {
      return null;
    }
  }, [electronMode]);

  // --- New-task animation tracking (same pattern as ChatHistory) ---
  const knownTaskIdsRef = useRef<Set<string>>(new Set());
  const isInitialTaskLoadRef = useRef(true);

  const newTaskIds = useMemo(() => {
    if (!globalTasksInitialized || globalTasks.length === 0) {
      return new Set<string>();
    }

    // eslint-disable-next-line react-hooks/refs -- Synchronous diff is required so new rows mount with animate=true.
    if (isInitialTaskLoadRef.current) {
      isInitialTaskLoadRef.current = false;
      for (const t of globalTasks) {
        // eslint-disable-next-line react-hooks/refs -- Synchronous diff is required so new rows mount with animate=true.
        knownTaskIdsRef.current.add(buildTaskLocalPresentationKey(t));
      }
      return new Set<string>();
    }

    const newIds = new Set<string>();
    for (const t of globalTasks) {
      const key = buildTaskLocalPresentationKey(t);
      // eslint-disable-next-line react-hooks/refs -- Synchronous diff is required so new rows mount with animate=true.
      if (!knownTaskIdsRef.current.has(key)) {
        newIds.add(key);
        // eslint-disable-next-line react-hooks/refs -- Synchronous diff is required so new rows mount with animate=true.
        knownTaskIdsRef.current.add(key);
      }
    }
    return newIds;
  }, [globalTasks, globalTasksInitialized]);

  const isNewTask = useCallback(
    (task: GlobalTask): boolean => newTaskIds.has(buildTaskLocalPresentationKey(task)),
    [newTaskIds]
  );

  useEffect(() => {
    let cancelled = false;
    void fetchAliveTeams().then((list) => {
      if (!cancelled && list) {
        setAliveTeams(list);
        setAliveTeamsInitialized(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [fetchAliveTeams, sidebarTeams.identityKey]);

  const readyProgressRefreshKey = useMemo(() => {
    return Object.entries(currentProvisioningRunIdByTeam)
      .map(([teamName, runId]) => {
        if (!runId) return null;
        const progress = provisioningRuns[runId];
        return progress?.state === 'ready'
          ? `${teamName}:${progress.runId}:${progress.updatedAt}`
          : null;
      })
      .filter((item): item is string => Boolean(item))
      .join('|');
  }, [currentProvisioningRunIdByTeam, provisioningRuns]);

  useEffect(() => {
    if (!readyProgressRefreshKey) return;
    let cancelled = false;
    void fetchAliveTeams().then((list) => {
      if (!cancelled && list) {
        setAliveTeams(list);
        setAliveTeamsInitialized(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [fetchAliveTeams, readyProgressRefreshKey]);

  const offlineTeamNames = useMemo(() => {
    const result = new Set<string>();
    const leadOfflineTeams = new Set(leadOfflineTeamNames);
    if (aliveTeamsInitialized) {
      const teamSummariesByName = new Map<string, TeamSummary>();
      for (const team of sidebarTeams.statusSummaries) {
        teamSummariesByName.set(team.teamName, team);
      }
      for (const task of globalTasks) {
        if (!teamSummariesByName.has(task.teamName)) {
          teamSummariesByName.set(task.teamName, buildTaskTeamSummary(task));
        }
      }

      for (const team of teamSummariesByName.values()) {
        if (leadOfflineTeams.has(team.teamName)) {
          result.add(team.teamName);
          continue;
        }
        const status = resolveTeamStatus(
          team,
          team.teamName,
          aliveTeams,
          getCurrentProvisioningProgressForTeam(provisioningState, team.teamName),
          {}
        );
        if (!isTeamListStatusRunning(status)) {
          result.add(team.teamName);
        }
      }
    }
    for (const teamName of leadOfflineTeamNames) {
      result.add(teamName);
    }
    return result;
  }, [
    aliveTeams,
    aliveTeamsInitialized,
    globalTasks,
    leadOfflineTeamNames,
    provisioningState,
    sidebarTeams.statusSummaries,
  ]);

  const getOwnerColorName = useCallback(
    (task: GlobalTask): string | null | undefined => {
      if (!task.owner) return null;
      const teamColorMap = sidebarTeams.memberColorByTeam.get(task.teamName);
      return teamColorMap ? (teamColorMap.get(task.owner) ?? null) : undefined;
    },
    [sidebarTeams.memberColorByTeam]
  );
  const isTeamOffline = useCallback(
    (teamName: string): boolean => offlineTeamNames.has(teamName),
    [offlineTeamNames]
  );
  const formatTeamHeader = useCallback(
    (teamDisplayName: string): string => t('tasksPanel.teamLabel', { team: teamDisplayName }),
    [t]
  );
  const handleProjectGroupVisibleCountChange = useCallback(
    (projectKey: string, visibleCount: number): void => {
      setProjectRequestedVisibleCountByKey((prev) => ({
        ...prev,
        [projectKey]: visibleCount,
      }));
    },
    []
  );

  const setGroupingMode = (mode: TaskGroupingMode): void => {
    setGroupingModeState(mode);
    saveGroupingMode(mode);
  };

  const setSortMode = (mode: TaskSortMode): void => {
    setSortModeState(mode);
    saveSortMode(mode);
  };

  const groupingModeLabel =
    groupingMode === 'none'
      ? t('tasksPanel.groupModes.none')
      : groupingMode === 'project'
        ? t('tasksPanel.groupModes.project')
        : t('tasksPanel.groupModes.time');

  const handleRenameComplete = useCallback(
    (teamName: string, taskId: string, newSubject: string): void => {
      taskLocalState.renameTask(teamName, taskId, newSubject);
      setRenamingTaskKey(null);
    },
    [taskLocalState]
  );

  const handleRenameCancel = useCallback((): void => {
    setRenamingTaskKey(null);
  }, []);

  const handleMarkTaskUnread = useCallback((teamName: string, taskId: string): void => {
    markTaskUnread(teamName, taskId);
  }, []);

  const handleToggleTaskPin = useCallback(
    (teamName: string, taskId: string): void => {
      taskLocalState.togglePin(teamName, taskId);
    },
    [taskLocalState]
  );

  const handleToggleTaskArchive = useCallback(
    (teamName: string, taskId: string): void => {
      taskLocalState.toggleArchive(teamName, taskId);
    },
    [taskLocalState]
  );

  const handleStartTaskRename = useCallback((teamName: string, taskId: string): void => {
    setRenamingTaskKey(`${teamName}:${taskId}`);
  }, []);

  const handleDeleteTask = useCallback(
    async (teamName: string, taskId: string): Promise<void> => {
      const confirmed = await confirm({
        title: t('tasksPanel.deleteConfirm.title'),
        message: t('tasksPanel.deleteConfirm.message', { taskId: deriveTaskDisplayId(taskId) }),
        confirmLabel: t('tasksPanel.deleteConfirm.confirmLabel'),
        cancelLabel: t('tasksPanel.deleteConfirm.cancelLabel'),
        variant: 'danger',
      });
      if (confirmed) {
        try {
          await softDeleteTask(teamName, taskId);
          await fetchAllTasks();
        } catch (err) {
          void confirm({
            title: t('tasksPanel.deleteFailed.title'),
            message:
              err instanceof Error ? err.message : t('tasksPanel.deleteFailed.fallbackMessage'),
            confirmLabel: t('tasksPanel.deleteFailed.confirmLabel'),
            variant: 'danger',
          });
        }
      }
    },
    [fetchAllTasks, softDeleteTask, t]
  );

  // Fetch tasks on mount — loading guard in the store action prevents
  // duplicate IPC calls when the centralized init chain is already fetching.
  useEffect(() => {
    if (!hasFetchedRef.current && !globalTasksLoading) {
      hasFetchedRef.current = true;
      void fetchAllTasks();
    }
  }, [fetchAllTasks, globalTasksLoading]);

  useEffect(() => {
    if (!filtersPopoverOpen) {
      return;
    }
    if (
      viewMode === 'grouped' &&
      !repositoryGroupsInitialized &&
      !repositoryGroupsLoading &&
      !repositoryGroupsError
    ) {
      void fetchRepositoryGroups();
    } else if (viewMode === 'flat' && !projectsInitialized && !projectsLoading && !projectsError) {
      void fetchProjects();
    }
  }, [
    fetchProjects,
    fetchRepositoryGroups,
    filtersPopoverOpen,
    projectsError,
    projectsInitialized,
    projectsLoading,
    repositoryGroupsError,
    repositoryGroupsInitialized,
    repositoryGroupsLoading,
    viewMode,
  ]);

  // Build project combobox options from available projects/repos
  const projectFilterOptions = useMemo((): ComboboxOption[] => {
    const items =
      viewMode === 'grouped'
        ? repositoryGroups
            .filter((r) => r.totalSessions > 0)
            .map((r) => ({
              value: r.worktrees[0]?.path ?? r.id,
              label: r.name,
              path: r.worktrees[0]?.path,
            }))
        : projects
            .filter((p) => (p.totalSessions ?? p.sessions.length) > 0)
            .map((p) => ({
              value: p.path,
              label: p.name,
              path: p.path,
            }));

    return items.map((item) => ({
      value: item.value,
      label: item.label,
      description: item.path,
    }));
  }, [viewMode, repositoryGroups, projects]);

  // Resolve project filter from filters state
  const selectedProjectPath = filters.projectPath;
  const hasArchivedTasks = useMemo(
    () => globalTasks.some((t) => getTaskLocalPresentation(t).archived),
    [globalTasks, getTaskLocalPresentation]
  );
  const effectiveShowArchived = showArchived && hasArchivedTasks;

  const filtered = useMemo(() => {
    let result = globalTasks;
    result = applyProjectFilter(result, selectedProjectPath);
    result = result.filter((t) => taskMatchesStatus(t, filters.statusIds));
    if (filters.teamName) {
      result = result.filter((t) => t.teamName === filters.teamName);
    }
    if (filters.readFilter === 'unread') {
      result = result.filter(
        (t) => getTaskUnreadCount(readState, t.teamName, t.id, t.comments) > 0
      );
    } else if (filters.readFilter === 'read') {
      result = result.filter(
        (t) => getTaskUnreadCount(readState, t.teamName, t.id, t.comments) === 0
      );
    }
    result = applySearch(result, searchQuery);
    // Archive filtering
    if (effectiveShowArchived) {
      result = result.filter((t) => getTaskLocalPresentation(t).archived);
    } else {
      result = result.filter((t) => !getTaskLocalPresentation(t).archived);
    }
    return result;
  }, [
    globalTasks,
    selectedProjectPath,
    filters.statusIds,
    filters.teamName,
    filters.readFilter,
    searchQuery,
    readState,
    effectiveShowArchived,
    getTaskLocalPresentation,
  ]);

  // Split into pinned and normal (non-pinned) tasks
  const pinnedTasks = useMemo(
    () => filtered.filter((t) => getTaskLocalPresentation(t).pinned),
    [filtered, getTaskLocalPresentation]
  );
  const normalTasks = useMemo(
    () => filtered.filter((t) => !getTaskLocalPresentation(t).pinned),
    [filtered, getTaskLocalPresentation]
  );
  const sortedPinnedTasks = useMemo(() => sortTasksByFreshness(pinnedTasks), [pinnedTasks]);

  const sortedFlat = useMemo(
    () => (groupingMode === 'none' ? applySortMode(normalTasks, sortMode, readState) : EMPTY_TASKS),
    [groupingMode, normalTasks, sortMode, readState]
  );
  const grouped = useMemo(
    () => (groupingMode === 'time' ? groupTasksByDate(normalTasks) : EMPTY_DATE_GROUPS),
    [groupingMode, normalTasks]
  );
  const categories = useMemo(
    () => (groupingMode === 'time' ? getNonEmptyTaskCategories(grouped) : EMPTY_DATE_CATEGORIES),
    [grouped, groupingMode]
  );
  const projectGroups = useMemo(
    () => (groupingMode === 'project' ? groupTasksByProject(normalTasks) : EMPTY_PROJECT_GROUPS),
    [groupingMode, normalTasks]
  );
  const projectTeamCountByKey = useMemo(
    () =>
      new Map(
        groupTasksByProject(globalTasks).map((group) => [
          group.projectKey,
          new Set(group.tasks.map((task) => task.teamName)).size,
        ])
      ),
    [globalTasks]
  );

  // Collapsed group keys for each grouping mode
  const projectGroupKeys = useMemo(
    () => projectGroups.filter((g) => g.tasks.length > 0).map((g) => g.projectKey),
    [projectGroups]
  );
  const timeGroupKeys = useMemo(() => categories.map((c) => c), [categories]);
  const projectGroupVisibility = useMemo(
    () =>
      projectGroups.map((group) => ({
        projectKey: group.projectKey,
        taskCount: group.tasks.length,
      })),
    [projectGroups]
  );
  const projectVisibleCountByKey = useMemo(
    () =>
      syncProjectGroupVisibleCountByKey(projectRequestedVisibleCountByKey, projectGroupVisibility),
    [projectRequestedVisibleCountByKey, projectGroupVisibility]
  );
  const taskFilterTeams = useMemo(() => sidebarTeams.filterTeams, [sidebarTeams.filterTeams]);

  const { isCollapsed: isProjectGroupCollapsed, toggle: toggleProjectGroup } = useCollapsedGroups(
    'project',
    projectGroupKeys
  );
  const { isCollapsed: isTimeGroupCollapsed, toggle: toggleTimeGroup } = useCollapsedGroups(
    'time',
    timeGroupKeys
  );
  const handleToggleProjectGroup = useCallback(
    (projectKey: string): void => {
      toggleProjectGroup(projectKey);
    },
    [toggleProjectGroup]
  );

  const hasContent =
    pinnedTasks.length > 0 ||
    (groupingMode === 'none'
      ? sortedFlat.length > 0
      : groupingMode === 'time'
        ? categories.length > 0
        : projectGroups.some((g) => g.tasks.length > 0));

  const noProjectGroupColor = useMemo(
    () => ({
      border: 'var(--color-border)',
      glow: 'transparent',
      icon: 'var(--color-text-muted)',
      text: 'var(--color-text-secondary)',
    }),
    []
  );

  return (
    <div className="flex size-full min-w-0 flex-col overflow-x-hidden">
      {!hideHeader && (
        <div
          className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <span className="text-[12px] font-semibold text-text-secondary">
            {t('tasksPanel.title')}
          </span>
        </div>
      )}

      {/* Controls */}
      <div className="shrink-0 border-b" style={{ borderColor: 'var(--color-border)' }}>
        <div className="flex items-center gap-1.5 px-2 py-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(
                  'flex shrink-0 items-center justify-center rounded p-0.5 text-text-muted transition-colors hover:text-text-secondary',
                  (searchVisible || searchQuery) && 'bg-surface-raised text-text'
                )}
                onClick={() => {
                  setSearchVisible(true);
                  searchInputRef.current?.focus();
                }}
                aria-label={t('tasksPanel.searchPlaceholder')}
              >
                <Search className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('tasksPanel.searchPlaceholder')}</TooltipContent>
          </Tooltip>

          <Popover open={sortPopoverOpen} onOpenChange={setSortPopoverOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="flex shrink-0 items-center justify-center rounded p-0.5 text-text-muted transition-colors hover:text-text-secondary data-[state=open]:bg-surface-raised data-[state=open]:text-text"
              >
                <ArrowUpDown className="size-3.5" />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-40 p-1" align="end" sideOffset={6}>
              <div className="flex flex-col">
                {SORT_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => {
                      setSortMode(opt.id);
                      setSortPopoverOpen(false);
                    }}
                    className={cn(
                      'flex items-center gap-2 rounded px-2 py-1.5 text-[12px] transition-colors',
                      sortMode === opt.id
                        ? 'bg-surface-raised text-text'
                        : 'hover:bg-surface-raised/60 text-text-secondary hover:text-text'
                    )}
                  >
                    <Check
                      className={cn(
                        'size-3 shrink-0',
                        sortMode === opt.id ? 'opacity-100' : 'opacity-0'
                      )}
                    />
                    {t(opt.labelKey)}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>

          <Popover open={groupingPopoverOpen} onOpenChange={setGroupingPopoverOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="flex min-w-0 shrink items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-text-muted transition-colors hover:bg-surface-raised hover:text-text data-[state=open]:bg-surface-raised data-[state=open]:text-text"
                aria-label={t('tasksPanel.groupByAria')}
              >
                <span className="truncate">{groupingModeLabel}</span>
                <ChevronDown className="size-3 shrink-0" />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-36 p-1" align="end" sideOffset={6}>
              <div className="flex flex-col">
                {(['none', 'project', 'time'] as const).map((mode) => {
                  const label =
                    mode === 'none'
                      ? t('tasksPanel.groupModes.none')
                      : mode === 'project'
                        ? t('tasksPanel.groupModes.project')
                        : t('tasksPanel.groupModes.time');
                  return (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => {
                        setGroupingMode(mode);
                        setGroupingPopoverOpen(false);
                      }}
                      className={cn(
                        'flex items-center gap-2 rounded px-2 py-1.5 text-[12px] transition-colors',
                        groupingMode === mode
                          ? 'bg-surface-raised text-text'
                          : 'hover:bg-surface-raised/60 text-text-secondary hover:text-text'
                      )}
                    >
                      <Check
                        className={cn(
                          'size-3 shrink-0',
                          groupingMode === mode ? 'opacity-100' : 'opacity-0'
                        )}
                      />
                      {label}
                    </button>
                  );
                })}
              </div>
            </PopoverContent>
          </Popover>

          <div className="ml-auto flex items-center gap-1">
            {hasArchivedTasks && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setShowArchived(!showArchived)}
                    className={cn(
                      'rounded p-0.5 transition-colors',
                      effectiveShowArchived
                        ? 'bg-surface-raised text-text-secondary'
                        : 'text-text-muted hover:text-text-secondary'
                    )}
                  >
                    <Archive className="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {effectiveShowArchived
                    ? t('tasksPanel.hideArchived')
                    : t('tasksPanel.showArchived')}
                </TooltipContent>
              </Tooltip>
            )}
            <TaskFiltersPopover
              open={filtersPopoverOpen}
              onOpenChange={setFiltersPopoverOpen}
              teams={taskFilterTeams}
              projectOptions={projectFilterOptions}
              filters={filters}
              onFiltersChange={setFilters}
              onApply={() => {}}
            />
          </div>
        </div>

        {searchVisible && (
          <div className="flex items-center gap-1.5 px-2 pb-1.5">
            <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1">
              <Search className="size-3 shrink-0 text-text-muted" />
              <input
                ref={searchInputRef}
                type="text"
                placeholder={t('tasksPanel.searchPlaceholder')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="min-w-0 flex-1 bg-transparent text-[12px] text-text placeholder:text-text-muted focus:outline-none"
              />
              {(searchQuery || searchVisible) && (
                <button
                  type="button"
                  className="shrink-0 text-text-muted hover:text-text-secondary"
                  onClick={() => {
                    setSearchQuery('');
                    setSearchVisible(false);
                  }}
                  aria-label="Clear search"
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Pinned tasks section */}
      {pinnedTasks.length > 0 && !effectiveShowArchived && (
        <div className="shrink-0 border-b" style={{ borderColor: 'var(--color-border)' }}>
          <div className="flex items-center gap-1 px-2 py-1">
            <Pin className="size-3 text-text-muted" />
            <span className="text-[11px] text-text-muted">{t('tasksPanel.pinned')}</span>
          </div>
          <TaskRows
            tasks={sortedPinnedTasks}
            keyPrefix="pinned-"
            getTaskLocalPresentation={getTaskLocalPresentation}
            isNewTask={isNewTask}
            isTeamOffline={isTeamOffline}
            isLight={isLight}
            pinnedOverride={true}
            archivedOverride={false}
            showTeamName={groupingMode !== 'none'}
            renamingKey={renamingTaskKey}
            onTogglePin={handleToggleTaskPin}
            onToggleArchive={handleToggleTaskArchive}
            onMarkUnread={handleMarkTaskUnread}
            onRename={handleStartTaskRename}
            onDelete={handleDeleteTask}
            onRenameComplete={handleRenameComplete}
            onRenameCancel={handleRenameCancel}
            getOwnerColorName={getOwnerColorName}
          />
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        {globalTasksLoading && !globalTasksInitialized && (
          <div className="space-y-2 p-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-[48px] animate-pulse rounded bg-surface-raised" />
            ))}
          </div>
        )}

        {globalTasksInitialized && !hasContent && (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-text-muted">
            <ListTodo className="size-8 opacity-40" />
            <span className="text-[12px]">
              {searchQuery || selectedProjectPath
                ? t('tasksPanel.empty.noMatchingTasks')
                : t('tasksPanel.empty.noTasks')}
            </span>
          </div>
        )}

        {groupingMode === 'none' && (
          <TaskRows
            tasks={sortedFlat}
            getTaskLocalPresentation={getTaskLocalPresentation}
            isNewTask={isNewTask}
            isTeamOffline={isTeamOffline}
            isLight={isLight}
            renamingKey={renamingTaskKey}
            onTogglePin={handleToggleTaskPin}
            onToggleArchive={handleToggleTaskArchive}
            onMarkUnread={handleMarkTaskUnread}
            onRename={handleStartTaskRename}
            onDelete={handleDeleteTask}
            onRenameComplete={handleRenameComplete}
            onRenameCancel={handleRenameCancel}
            getOwnerColorName={getOwnerColorName}
          />
        )}

        {groupingMode === 'project' &&
          projectGroups.map((group) => {
            const visibleCount = getProjectGroupVisibleCount(
              projectVisibleCountByKey[group.projectKey],
              group.tasks.length
            );
            return (
              <ProjectTaskGroup
                key={group.projectKey}
                group={group}
                isCollapsed={isProjectGroupCollapsed(group.projectKey)}
                showTeamHeader={(projectTeamCountByKey.get(group.projectKey) ?? 0) > 1}
                visibleCount={visibleCount}
                noProjectGroupColor={noProjectGroupColor}
                showMoreLabel={t('tasksPanel.showMore')}
                showLessLabel={t('tasksPanel.showLess')}
                getTaskLocalPresentation={getTaskLocalPresentation}
                isNewTask={isNewTask}
                isTeamOffline={isTeamOffline}
                isLight={isLight}
                renamingKey={renamingTaskKey}
                formatTeamHeader={formatTeamHeader}
                onToggleGroup={handleToggleProjectGroup}
                onVisibleCountChange={handleProjectGroupVisibleCountChange}
                onTogglePin={handleToggleTaskPin}
                onToggleArchive={handleToggleTaskArchive}
                onMarkUnread={handleMarkTaskUnread}
                onRename={handleStartTaskRename}
                onDelete={handleDeleteTask}
                onRenameComplete={handleRenameComplete}
                onRenameCancel={handleRenameCancel}
                getOwnerColorName={getOwnerColorName}
              />
            );
          })}

        {groupingMode === 'time' &&
          categories.map((category) => {
            const tasks = grouped[category];
            const isGroupCollapsed = isTimeGroupCollapsed(category);

            return (
              <div key={category}>
                <button
                  type="button"
                  onClick={() => toggleTimeGroup(category)}
                  className="hover:bg-surface-raised/40 sticky top-0 z-10 flex w-full cursor-pointer items-center gap-1 px-2 py-1.5 text-[11px] font-semibold text-text-secondary transition-colors"
                  style={{ backgroundColor: 'var(--color-surface-sidebar)' }}
                >
                  {isGroupCollapsed ? (
                    <ChevronRight className="size-3 shrink-0 text-text-muted" />
                  ) : (
                    <ChevronDown className="size-3 shrink-0 text-text-muted" />
                  )}
                  <span className="truncate">{dateCategoryLabels[category] ?? category}</span>
                  <span className="ml-auto shrink-0 text-[10px] font-normal text-text-muted">
                    {tasks.length}
                  </span>
                </button>

                {!isGroupCollapsed && (
                  <TaskRows
                    tasks={tasks}
                    getTaskLocalPresentation={getTaskLocalPresentation}
                    isNewTask={isNewTask}
                    isTeamOffline={isTeamOffline}
                    isLight={isLight}
                    showTeamHeader
                    formatTeamHeader={formatTeamHeader}
                    renamingKey={renamingTaskKey}
                    onTogglePin={handleToggleTaskPin}
                    onToggleArchive={handleToggleTaskArchive}
                    onMarkUnread={handleMarkTaskUnread}
                    onRename={handleStartTaskRename}
                    onDelete={handleDeleteTask}
                    onRenameComplete={handleRenameComplete}
                    onRenameCancel={handleRenameCancel}
                    getOwnerColorName={getOwnerColorName}
                  />
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
});
