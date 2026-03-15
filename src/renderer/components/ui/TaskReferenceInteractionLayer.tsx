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

export const TaskReferenceInteractionLayer = ({
  taskSuggestions,
  value,
  textareaRef,
  scrollTop,
}: TaskReferenceInteractionLayerProps): React.JSX.Element | null => {
  const [positions, setPositions] = React.useState<PositionedTaskReference[]>([]);
  const openGlobalTaskDetail = useStore((s) => s.openGlobalTaskDetail);

  React.useLayoutEffect(() => {
    if (taskSuggestions.length === 0 || !value.includes('#')) {
      setPositions([]);
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

    setPositions(calculateInlineMatchPositions(textarea, value, matches));
  }, [taskSuggestions, textareaRef, value]);

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
