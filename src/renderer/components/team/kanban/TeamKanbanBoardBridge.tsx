import { type ComponentProps, memo } from 'react';

import { useStore } from '@renderer/store';

import { KanbanBoard } from './KanbanBoard';

type TeamKanbanBoardBridgeProps = Omit<
  ComponentProps<typeof KanbanBoard>,
  'activeTaskLogActivity' | 'contextId'
>;

export const TeamKanbanBoardBridge = memo(function TeamKanbanBoardBridge({
  teamName,
  ...props
}: TeamKanbanBoardBridgeProps): React.JSX.Element {
  const contextId = useStore((s) => s.activeContextId);
  const activeTaskLogActivity = useStore((s) => s.activeTaskLogActivityByTeam[teamName]);

  return (
    <KanbanBoard
      {...props}
      contextId={contextId}
      teamName={teamName}
      activeTaskLogActivity={activeTaskLogActivity}
    />
  );
});
