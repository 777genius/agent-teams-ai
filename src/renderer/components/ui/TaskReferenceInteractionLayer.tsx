import * as React from 'react';

import { TaskTooltip } from '@renderer/components/team/TaskTooltip';
import { useStore } from '@renderer/store';
import { calculateInlineMatchPositions } from '@renderer/utils/chipUtils';
import { findTaskReferenceMatches } from '@renderer/utils/taskReferenceUtils';

import type { MentionSuggestion } from '@renderer/types/mention';
import type { InlineMatchPosition } from '@renderer/utils/chipUtils';

interface TaskReferenceInteractionLayerProps {
  taskSuggestions: MentionSuggestion[];
  value: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  scrollTop: number;
}

type PositionedTaskReference = InlineMatchPosition<MentionSuggestion>;

function areTaskSuggestionsEquivalent(a: MentionSuggestion, b: MentionSuggestion): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.taskId === b.taskId &&
    a.teamName === b.teamName &&
    a.teamDisplayName === b.teamDisplayName &&
    a.ownerName === b.ownerName &&
    a.ownerColor === b.ownerColor
  );
}

function areTaskReferencePositionsEquivalent(
  current: PositionedTaskReference[],
  next: PositionedTaskReference[]
): boolean {
  if (current.length !== next.length) return false;

  return current.every((position, index) => {
    const nextPosition = next[index];
    return (
      position.start === nextPosition.start &&
      position.end === nextPosition.end &&
      position.token === nextPosition.token &&
      position.top === nextPosition.top &&
      position.left === nextPosition.left &&
      position.width === nextPosition.width &&
      position.height === nextPosition.height &&
      areTaskSuggestionsEquivalent(position.item, nextPosition.item)
    );
  });
}

export const TaskReferenceInteractionLayer = ({
  taskSuggestions,
  value,
  textareaRef,
  scrollTop,
}: TaskReferenceInteractionLayerProps): React.JSX.Element | null => {
  const [positions, setPositions] = React.useState<PositionedTaskReference[]>([]);
  const positionsRef = React.useRef<PositionedTaskReference[]>([]);
  const openGlobalTaskDetail = useStore((s) => s.openGlobalTaskDetail);

  const commitPositions = React.useCallback((nextPositions: PositionedTaskReference[]) => {
    if (areTaskReferencePositionsEquivalent(positionsRef.current, nextPositions)) return;
    positionsRef.current = nextPositions;
    setPositions(nextPositions);
  }, []);

  React.useLayoutEffect(() => {
    if (taskSuggestions.length === 0 || !value.includes('#')) {
      commitPositions([]);
      return;
    }

    const textarea = textareaRef.current;
    if (!textarea) return;

    const matches = findTaskReferenceMatches(value, taskSuggestions).map((match) => ({
      item: match.suggestion,
      start: match.start,
      end: match.end,
      token: match.raw,
    }));

    commitPositions(calculateInlineMatchPositions(textarea, value, matches));
  }, [commitPositions, taskSuggestions, textareaRef, value]);

  if (positions.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      <div style={{ transform: `translateY(-${scrollTop}px)` }}>
        {positions.map((position, index) => {
          const suggestion = position.item;
          const taskId = suggestion.taskId;
          const teamName = suggestion.teamName;
          if (!taskId) return null;

          return (
            <TaskTooltip
              key={`${suggestion.id}:${position.start}:${index}`}
              taskId={taskId}
              teamName={teamName}
            >
              <button
                type="button"
                className="pointer-events-auto absolute cursor-pointer rounded-sm bg-transparent p-0"
                style={{
                  top: position.top,
                  left: position.left,
                  width: position.width,
                  height: position.height,
                }}
                onMouseDown={(e) => {
                  if (e.metaKey || e.ctrlKey) return;
                  e.preventDefault();
                  const textarea = textareaRef.current;
                  if (!textarea) return;

                  textarea.focus();
                  const clickOffsetX = e.clientX - e.currentTarget.getBoundingClientRect().left;
                  const snapTo = clickOffsetX < position.width / 2 ? position.start : position.end;
                  textarea.setSelectionRange(snapTo, snapTo);
                }}
                onClick={(e) => {
                  if (!e.metaKey && !e.ctrlKey) return;
                  e.preventDefault();
                  e.stopPropagation();
                  if (teamName) {
                    openGlobalTaskDetail(teamName, taskId);
                  }
                }}
                aria-label={`Open task ${position.token}`}
              />
            </TaskTooltip>
          );
        })}
      </div>
    </div>
  );
};
