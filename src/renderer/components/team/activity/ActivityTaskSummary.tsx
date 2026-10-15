import { Fragment } from 'react';

import { TaskTooltip } from '@renderer/components/team/TaskTooltip';

import type { TaskIdClickHandler } from '@renderer/utils/taskReferenceUtils';

/** Render `#<task-display-id>` in plain text as clickable inline elements with TaskTooltip. */
function linkifyTaskIds(
  text: string,
  onClick: TaskIdClickHandler,
  originTeamName: string
): React.ReactNode[] {
  return text.split(/(#[A-Za-z0-9-]+\b)/g).map((part, i) => {
    const match = /^#([A-Za-z0-9-]+)$/.exec(part);
    if (!match) return <Fragment key={i}>{part}</Fragment>;
    const taskId = match[1];
    return (
      <TaskTooltip key={i} taskId={taskId} teamName={originTeamName}>
        <button
          type="button"
          className="inline cursor-pointer font-medium text-blue-600 hover:underline dark:text-blue-400"
          onClick={(e) => {
            e.stopPropagation();
            onClick(taskId, originTeamName, 'display');
          }}
        >
          {part}
        </button>
      </TaskTooltip>
    );
  });
}

/**
 * Render summary text with inline bold markdown and optional task-id linkification.
 * Splits on bold markers first, then linkifies task IDs within each segment.
 */
export function renderInlineBoldSummary(
  text: string,
  onTaskIdClick?: TaskIdClickHandler,
  originTeamName?: string
): React.ReactNode {
  // Split by **bold** segments, keeping delimiters
  const boldPattern = /(\*\*[^*]+\*\*)/g;
  const parts = text.split(boldPattern);
  return parts.map((part, i) => {
    const boldContent = /^\*\*(.+)\*\*$/.exec(part);
    if (boldContent) {
      const inner = boldContent[1];
      return (
        <strong key={i} className="font-semibold">
          {onTaskIdClick && originTeamName
            ? linkifyTaskIds(inner, onTaskIdClick, originTeamName)
            : inner}
        </strong>
      );
    }
    return onTaskIdClick && originTeamName ? (
      <Fragment key={i}>{linkifyTaskIds(part, onTaskIdClick, originTeamName)}</Fragment>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    );
  });
}
