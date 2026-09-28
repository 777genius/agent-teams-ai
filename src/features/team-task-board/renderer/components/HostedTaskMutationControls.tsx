import { useState } from 'react';

import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { Textarea } from '@renderer/components/ui/textarea';
import { parseMemberId } from '@shared/contracts/hosted';

import {
  HOSTED_TASK_BOARD_COLUMNS,
  type HostedTaskBoardCoreV1MutationCommand,
  type HostedTaskBoardItem,
} from '../../contracts/hosted';
import { nextOrder, nextStatus } from '../utils/hostedTaskBoardControls';

import { hostedTaskMoveButtonProps } from './hostedTaskMoveButton';

export type HostedTaskMutationBase = Pick<
  HostedTaskBoardCoreV1MutationCommand,
  | 'schemaVersion'
  | 'commandId'
  | 'idempotencyKey'
  | 'teamId'
  | 'expectedSourceGeneration'
  | 'expectedRevision'
>;
interface TaskMutationControlsProps {
  readonly item: HostedTaskBoardItem;
  readonly allItems: readonly HostedTaskBoardItem[];
  readonly columnItems: readonly HostedTaskBoardItem[];
  readonly disabled: boolean;
  readonly orderingDisabled: boolean;
  readonly dispatch: (
    build: (base: HostedTaskMutationBase) => HostedTaskBoardCoreV1MutationCommand
  ) => void;
}
export const HostedTaskMutationControls = ({
  item,
  allItems,
  columnItems,
  disabled,
  orderingDisabled,
  dispatch,
}: TaskMutationControlsProps): React.JSX.Element => {
  const [subject, setSubject] = useState(item.subject);
  const [description, setDescription] = useState(item.description ?? '');
  const [ownerId, setOwnerId] = useState(item.ownerId ?? '');
  const columnIndex = HOSTED_TASK_BOARD_COLUMNS.indexOf(item.column);
  const itemIndex = columnItems.findIndex(({ taskId }) => taskId === item.taskId);
  const mutationButtonProps = {
    type: 'button' as const,
    variant: 'outline' as const,
    size: 'sm' as const,
    disabled,
  };
  const reorder = (offset: -1 | 1): void => {
    if (orderingDisabled) return;
    const targetIndex = itemIndex + offset;
    if (itemIndex < 0 || targetIndex < 0 || targetIndex >= columnItems.length) return;
    const orderedTaskIds = columnItems.map(({ taskId }) => taskId);
    [orderedTaskIds[itemIndex], orderedTaskIds[targetIndex]] = [
      orderedTaskIds[targetIndex],
      orderedTaskIds[itemIndex],
    ];
    dispatch((base) =>
      Object.freeze({
        ...base,
        kind: 'reorder_column',
        column: item.column,
        orderedTaskIds: Object.freeze(orderedTaskIds),
      })
    );
  };
  const moveTask = (offset: -1 | 1): void => {
    if (orderingDisabled) return;
    const column = HOSTED_TASK_BOARD_COLUMNS[columnIndex + offset];
    if (column === undefined) return;
    dispatch((base) =>
      Object.freeze({
        ...base,
        kind: 'move_task',
        taskId: item.taskId,
        column,
        order: nextOrder(allItems, column),
      })
    );
  };
  return (
    <div className="mt-3 space-y-3">
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          const nextSubject = subject.trim();
          if (nextSubject.length === 0) return;
          dispatch((base) =>
            Object.freeze({
              ...base,
              kind: 'update_details',
              taskId: item.taskId,
              subject: nextSubject,
              description: description.trim().length === 0 ? null : description,
            })
          );
        }}
      >
        <Input
          aria-label={`Title for ${item.subject}`}
          disabled={disabled}
          maxLength={200}
          required
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
        />
        <Textarea
          aria-label={`Description for ${item.subject}`}
          disabled={disabled}
          maxLength={20_000}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        <Button type="submit" variant="outline" size="sm" disabled={disabled || !subject.trim()}>
          Save details
        </Button>
      </form>
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          let parsedOwnerId: HostedTaskBoardItem['ownerId'];
          try {
            parsedOwnerId = ownerId.trim().length === 0 ? null : parseMemberId(ownerId.trim());
          } catch {
            return;
          }
          dispatch((base) =>
            Object.freeze({
              ...base,
              kind: 'update_owner',
              taskId: item.taskId,
              ownerId: parsedOwnerId,
            })
          );
        }}
      >
        <Input
          aria-label={`Owner for ${item.subject}`}
          disabled={disabled}
          pattern="member_[0-9a-f]{32}"
          placeholder="Member ID (blank for unassigned)"
          value={ownerId}
          onChange={(event) => setOwnerId(event.target.value)}
        />
        <Button type="submit" variant="outline" size="sm" disabled={disabled}>
          Save owner
        </Button>
      </form>
      <div className="flex flex-wrap gap-1.5">
        <Button
          {...mutationButtonProps}
          aria-label={`Next status for ${item.subject}`}
          onClick={() =>
            dispatch((base) =>
              Object.freeze({
                ...base,
                kind: 'update_status',
                taskId: item.taskId,
                status: nextStatus(item.status),
              })
            )
          }
        >
          Next status
        </Button>
        <Button
          {...mutationButtonProps}
          aria-label={`Move ${item.subject} left`}
          {...hostedTaskMoveButtonProps(columnIndex - 1, item.status, disabled || orderingDisabled)}
          onClick={() => moveTask(-1)}
        >
          Move left
        </Button>
        <Button
          {...mutationButtonProps}
          aria-label={`Move ${item.subject} right`}
          {...hostedTaskMoveButtonProps(columnIndex + 1, item.status, disabled || orderingDisabled)}
          onClick={() => moveTask(1)}
        >
          Move right
        </Button>
        <Button
          {...mutationButtonProps}
          aria-label={`Move ${item.subject} up`}
          disabled={disabled || orderingDisabled || itemIndex <= 0}
          onClick={() => reorder(-1)}
        >
          Move up
        </Button>
        <Button
          {...mutationButtonProps}
          aria-label={`Move ${item.subject} down`}
          disabled={
            disabled || orderingDisabled || itemIndex < 0 || itemIndex >= columnItems.length - 1
          }
          onClick={() => reorder(1)}
        >
          Move down
        </Button>
      </div>
    </div>
  );
};
