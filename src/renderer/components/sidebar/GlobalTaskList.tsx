import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { confirm } from '@renderer/components/common/ConfirmDialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useCollapsedGroups } from '@renderer/hooks/useCollapsedGroups';
import { useTaskLocalState } from '@renderer/hooks/useTaskLocalState';
import { useTaskProjectFilterOptions } from '@renderer/hooks/useTaskProjectFilterOptions';
import { useTaskTeamStatus } from '@renderer/hooks/useTaskTeamStatus';
import { useTheme } from '@renderer/hooks/useTheme';
import { cn } from '@renderer/lib/utils';
import { markTaskUnread } from '@renderer/services/commentReadStorage';
import { useStore } from '@renderer/store';
import {
  getNonEmptyTaskCategories,
  groupTasksByDate,
  groupTasksByProject,
  sortProjectGroupsByPin,
  sortTasksByFreshness,
} from '@renderer/utils/taskGrouping';
import { deriveTaskDisplayId } from '@shared/utils/taskIdentity';
import { Check, ChevronDown, ChevronRight, ListTodo, Pin, Search, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { AnimatedHeightReveal } from '../team/activity/AnimatedHeightReveal';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

import {
  getProjectGroupVisibleCount,
  syncProjectGroupVisibleCountByKey,
} from './projectGroupPagination';
import { ProjectTaskGroup } from './ProjectTaskGroup';
import { SidebarTaskItem } from './SidebarTaskItem';
import { selectSidebarTeamsDerived } from './sidebarTeamSelectors';
import { TaskContextMenu } from './TaskContextMenu';
import { TaskFiltersPopover } from './TaskFiltersPopover';
import { defaultTaskFiltersState, useReadStateSnapshot } from './taskFiltersState';
import { TaskSortPopover } from './TaskSortPopover';
import {
  createTaskEffectiveSubjectAccessor,
  filterGlobalTasks,
  sortGlobalTasks,
  type TaskSortMode,
} from './taskViewPolicy';

import type { TaskFiltersState } from './taskFiltersState';
import type { GlobalTask } from '@shared/types';

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

const TASK_SORT_STORAGE_KEY = 'sidebarTasksSort';

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

export interface GlobalTaskListProps {
  contextId: string;
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

interface TaskLocalPresentationState {
  key: string;
  pinned: boolean;
  archived: boolean;
  renamedSubject: string | undefined;
}

type TaskLocalPresentationResolver = (task: GlobalTask) => TaskLocalPresentationState;
interface GlobalTaskRowProps {
  contextId: string;
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
  onRestore: TaskRowAction;
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
    contextId,
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
    onRestore,
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

    const handleRestore = useCallback(() => {
      onRestore(task.teamName, task.id);
    }, [onRestore, task.id, task.teamName]);

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
        onRestore={handleRestore}
      >
        <AnimatedHeightReveal animate={isNew}>
          <SidebarTaskItem
            task={task}
            contextId={contextId}
            hideTeamName={hideTeamName}
            hideProjectName={hideProjectName}
            showTeamName={showTeamName}
            revealTeamNameOnTaskHover={revealTeamNameOnTaskHover}
            isLight={isLight}
            teamOffline={teamOffline}
            isArchived={isArchived}
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
    prev.contextId === next.contextId &&
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
    prev.onRestore === next.onRestore &&
    prev.onRenameComplete === next.onRenameComplete &&
    prev.onRenameCancel === next.onRenameCancel &&
    prev.displaySubjectOverride === next.displaySubjectOverride &&
    prev.ownerColorName === next.ownerColorName
);

interface TaskRowsProps {
  contextId: string;
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
  onRestore: TaskRowAction;
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
  contextId,
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
  onRestore,
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
            contextId={contextId}
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
            onRestore={onRestore}
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
  if (prev.contextId !== next.contextId) return false;
  return (
    prev.visibleCount === next.visibleCount &&
    prev.keyPrefix === next.keyPrefix &&
    prev.contextId === next.contextId &&
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
    prev.onRestore === next.onRestore &&
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

export const GlobalTaskList = memo<GlobalTaskListProps>(function GlobalTaskList({
  contextId,
  hideHeader = false,
  filters: externalFilters,
  onFiltersChange: externalOnFiltersChange,
  filtersPopoverOpen: externalFiltersPopoverOpen,
  onFiltersPopoverOpenChange: externalOnFiltersPopoverOpenChange,
}: GlobalTaskListProps): React.JSX.Element {
  const { t } = useAppTranslation('common');
  const { isLight } = useTheme();
  const {
    globalTasks,
    globalDeletedTasks,
    globalTasksLoading,
    globalTasksInitialized,
    fetchAllTasks,
    fetchAllDeletedTasks,
    restoreTask,
    softDeleteTask,
  } = useStore(
    useShallow((s) => ({
      globalTasks: s.globalTasks,
      globalDeletedTasks: s.globalDeletedTasks,
      globalTasksLoading: s.globalTasksLoading,
      globalTasksInitialized: s.globalTasksInitialized,
      fetchAllTasks: s.fetchAllTasks,
      fetchAllDeletedTasks: s.fetchAllDeletedTasks,
      restoreTask: s.restoreTask,
      softDeleteTask: s.softDeleteTask,
    }))
  );
  const isTeamOffline = useTaskTeamStatus();
  const sidebarTeams = useStore((s) => selectSidebarTeamsDerived(s.teams));
  const teamCatalogKey = useStore((s) => s.teams.map((team) => team.teamName).join('|'));
  // Membership only: task add/remove invalidates the deleted feed, status churn must not.
  const globalTaskIdsKey = useMemo(
    () => globalTasks.map((task) => task.id).join('|'),
    [globalTasks]
  );

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
  const [renamingTaskKey, setRenamingTaskKey] = useState<string | null>(null);
  const [projectRequestedVisibleCountByKey, setProjectRequestedVisibleCountByKey] = useState<
    Record<string, number>
  >({});
  const searchInputRef = useRef<HTMLInputElement>(null);
  const readState = useReadStateSnapshot();
  const taskLocalState = useTaskLocalState();

  useEffect(() => {
    if (searchVisible) {
      searchInputRef.current?.focus();
    }
  }, [searchVisible]);

  useEffect(() => {
    if (!filters.showDeleted) return;
    void fetchAllDeletedTasks();
  }, [contextId, fetchAllDeletedTasks, filters.showDeleted, globalTaskIdsKey, teamCatalogKey]);

  const viewTasks = useMemo(
    () => (globalDeletedTasks.length > 0 ? [...globalTasks, ...globalDeletedTasks] : globalTasks),
    [globalDeletedTasks, globalTasks]
  );

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

  const getEffectiveSubject = useMemo(
    () =>
      createTaskEffectiveSubjectAccessor((task) => getTaskLocalPresentation(task).renamedSubject),
    [getTaskLocalPresentation]
  );

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

  const getOwnerColorName = useCallback(
    (task: GlobalTask): string | null | undefined => {
      if (!task.owner) return null;
      const teamColorMap = sidebarTeams.memberColorByTeam.get(task.teamName);
      return teamColorMap ? (teamColorMap.get(task.owner) ?? null) : undefined;
    },
    [sidebarTeams.memberColorByTeam]
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

  const handleMarkTaskUnread = useCallback(
    (teamName: string, taskId: string): void => {
      markTaskUnread({ contextId, teamName, taskId });
    },
    [contextId]
  );

  const handleToggleTaskPin = useCallback(
    (teamName: string, taskId: string): void => {
      taskLocalState.togglePin(teamName, taskId);
    },
    [taskLocalState]
  );

  const handleToggleProjectPin = useCallback(
    (projectKey: string): void => {
      taskLocalState.toggleProjectPin(projectKey);
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

  const handleRestoreTask = useCallback(
    async (teamName: string, taskId: string): Promise<void> => {
      try {
        await restoreTask(teamName, taskId);
        await fetchAllTasks();
      } catch (err) {
        void confirm({
          title: t('tasksPanel.restoreFailed.title'),
          message:
            err instanceof Error ? err.message : t('tasksPanel.restoreFailed.fallbackMessage'),
          confirmLabel: t('tasksPanel.restoreFailed.confirmLabel'),
          variant: 'danger',
        });
      }
    },
    [fetchAllTasks, restoreTask, t]
  );

  const projectFilterOptions = useTaskProjectFilterOptions(filtersPopoverOpen);

  // Resolve project filter from filters state
  const selectedProjectPath = filters.projectPath;

  const filtered = useMemo(() => {
    return filterGlobalTasks(
      viewTasks,
      {
        contextId,
        filters,
        searchQuery,
        archiveMode: filters.showArchived ? 'all' : 'active',
        getEffectiveSubject,
      },
      readState,
      (task) => getTaskLocalPresentation(task).archived
    );
  }, [
    contextId,
    viewTasks,
    filters,
    searchQuery,
    readState,
    getEffectiveSubject,
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
    () =>
      groupingMode === 'none'
        ? sortGlobalTasks(normalTasks, sortMode, contextId, readState)
        : EMPTY_TASKS,
    [contextId, groupingMode, normalTasks, sortMode, readState]
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
    () =>
      groupingMode === 'project'
        ? sortProjectGroupsByPin(groupTasksByProject(normalTasks), taskLocalState.pinnedProjectKeys)
        : EMPTY_PROJECT_GROUPS,
    [groupingMode, normalTasks, taskLocalState.pinnedProjectKeys]
  );
  // Same source as projectGroups, so a header never counts a team whose row the filters hid.
  const projectTeamCountByKey = useMemo(
    () =>
      new Map(
        groupTasksByProject(normalTasks).map((group) => [
          group.projectKey,
          new Set(group.tasks.map((task) => task.teamName)).size,
        ])
      ),
    [normalTasks]
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

          <TaskSortPopover
            open={sortPopoverOpen}
            onOpenChange={setSortPopoverOpen}
            mode={sortMode}
            testId="sidebar-task-view-sort"
            onModeChange={(mode) => {
              if (mode !== 'manual') setSortMode(mode);
            }}
          />

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
            <TaskFiltersPopover
              open={filtersPopoverOpen}
              onOpenChange={setFiltersPopoverOpen}
              testId="sidebar-task-view-filters"
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
      {pinnedTasks.length > 0 && (
        <div className="shrink-0 border-b" style={{ borderColor: 'var(--color-border)' }}>
          <div className="flex items-center gap-1 px-2 py-1">
            <Pin className="size-3 text-text-muted" />
            <span className="text-[11px] text-text-muted">{t('tasksPanel.pinned')}</span>
          </div>
          <TaskRows
            contextId={contextId}
            tasks={sortedPinnedTasks}
            keyPrefix="pinned-"
            getTaskLocalPresentation={getTaskLocalPresentation}
            isNewTask={isNewTask}
            isTeamOffline={isTeamOffline}
            isLight={isLight}
            pinnedOverride={true}
            showTeamName={groupingMode !== 'none'}
            renamingKey={renamingTaskKey}
            onTogglePin={handleToggleTaskPin}
            onToggleArchive={handleToggleTaskArchive}
            onMarkUnread={handleMarkTaskUnread}
            onRename={handleStartTaskRename}
            onDelete={handleDeleteTask}
            onRestore={handleRestoreTask}
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
            contextId={contextId}
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
            onRestore={handleRestoreTask}
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
                projectKey={group.projectKey}
                projectLabel={group.projectLabel}
                taskCount={group.tasks.length}
                isCollapsed={isProjectGroupCollapsed(group.projectKey)}
                visibleCount={visibleCount}
                noProjectGroupColor={noProjectGroupColor}
                showMoreLabel={t('tasksPanel.showMore')}
                showLessLabel={t('tasksPanel.showLess')}
                isLight={isLight}
                isPinned={taskLocalState.isProjectPinned(group.projectKey)}
                onToggleGroup={handleToggleProjectGroup}
                onVisibleCountChange={handleProjectGroupVisibleCountChange}
                onToggleProjectPin={handleToggleProjectPin}
              >
                <TaskRows
                  contextId={contextId}
                  tasks={group.tasks}
                  visibleCount={visibleCount}
                  getTaskLocalPresentation={getTaskLocalPresentation}
                  isNewTask={isNewTask}
                  isTeamOffline={isTeamOffline}
                  isLight={isLight}
                  hideTeamName
                  hideProjectName
                  showTeamHeader={(projectTeamCountByKey.get(group.projectKey) ?? 0) > 1}
                  formatTeamHeader={formatTeamHeader}
                  renamingKey={renamingTaskKey}
                  onTogglePin={handleToggleTaskPin}
                  onToggleArchive={handleToggleTaskArchive}
                  onMarkUnread={handleMarkTaskUnread}
                  onRename={handleStartTaskRename}
                  onDelete={handleDeleteTask}
                  onRestore={handleRestoreTask}
                  onRenameComplete={handleRenameComplete}
                  onRenameCancel={handleRenameCancel}
                  getOwnerColorName={getOwnerColorName}
                />
              </ProjectTaskGroup>
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
                    contextId={contextId}
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
                    onRestore={handleRestoreTask}
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
