import { memo, useCallback } from 'react';

import { projectColor, type ProjectColorSet } from '@renderer/utils/projectColor';
import { NO_PROJECT_KEY } from '@renderer/utils/taskGrouping';
import { ChevronDown, ChevronRight, Folder, Pin } from 'lucide-react';

import { ProjectContextMenu } from './ProjectContextMenu';
import {
  canProjectGroupShowLess,
  canProjectGroupShowMore,
  getNextProjectGroupVisibleCount,
  getPreviousProjectGroupVisibleCount,
} from './projectGroupPagination';

interface ProjectTaskGroupProps {
  projectKey: string;
  projectLabel: string;
  taskCount: number;
  isCollapsed: boolean;
  visibleCount: number;
  noProjectGroupColor: ProjectColorSet;
  showMoreLabel: string;
  showLessLabel: string;
  isLight: boolean;
  isPinned: boolean;
  onToggleGroup: (projectKey: string) => void;
  onVisibleCountChange: (projectKey: string, visibleCount: number) => void;
  onToggleProjectPin: (projectKey: string) => void;
  children: React.ReactNode;
}

export const ProjectTaskGroup = memo(function ProjectTaskGroup({
  projectKey,
  projectLabel,
  taskCount,
  isCollapsed,
  visibleCount,
  noProjectGroupColor,
  showMoreLabel,
  showLessLabel,
  isLight,
  isPinned,
  onToggleGroup,
  onVisibleCountChange,
  onToggleProjectPin,
  children,
}: ProjectTaskGroupProps): React.JSX.Element | null {
  const handleTogglePin = useCallback(() => {
    onToggleProjectPin(projectKey);
  }, [onToggleProjectPin, projectKey]);

  if (taskCount === 0) return null;

  const isNoProjectGroup = projectKey === NO_PROJECT_KEY;
  const groupColor = isNoProjectGroup
    ? noProjectGroupColor
    : projectColor(projectLabel, isLight);
  const showMoreVisible = canProjectGroupShowMore(visibleCount, taskCount);
  const showLessVisible = canProjectGroupShowLess(visibleCount, taskCount);

  return (
    <div>
      <ProjectContextMenu isPinned={isPinned} onTogglePin={handleTogglePin}>
        <button
          type="button"
          onClick={() => onToggleGroup(projectKey)}
          className="hover:bg-surface-raised/40 sticky top-0 z-10 flex w-full cursor-pointer items-center gap-1.5 p-2 transition-colors"
          style={{
            backgroundColor: 'var(--color-surface-sidebar)',
            // Temporarily disabled: unique folder color stays on icon/text/left border
            // backgroundImage: isNoProjectGroup
            //   ? undefined
            //   : `linear-gradient(90deg, ${groupColor.glow} 0%, transparent 80%)`,
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
          {isPinned && <Pin className="size-2.5 shrink-0 text-blue-400" />}
          <span
            className="truncate text-[11px] font-bold leading-none"
            style={{ color: groupColor.icon }}
          >
            {projectLabel}
          </span>
          <span className="ml-auto shrink-0 text-[10px] font-normal text-text-muted">
            {taskCount}
          </span>
        </button>
      </ProjectContextMenu>
      {!isCollapsed && children}
      {!isCollapsed && (showMoreVisible || showLessVisible) && (
        <div className="flex items-center gap-2 px-3 pb-2 pt-1">
          {showMoreVisible && (
            <button
              type="button"
              className="text-[11px] font-medium text-text-muted transition-colors hover:text-text"
              onClick={() =>
                onVisibleCountChange(
                  projectKey,
                  getNextProjectGroupVisibleCount(visibleCount, taskCount)
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
                  projectKey,
                  getPreviousProjectGroupVisibleCount(visibleCount, taskCount)
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
});
