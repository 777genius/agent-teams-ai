import type {
  BoardTaskActivityAction,
  BoardTaskActivityLinkKind,
  BoardTaskActivityTaskRef,
} from '../types/team';

interface BoardTaskActivityLabelInput {
  action?: BoardTaskActivityAction;
  linkKind: BoardTaskActivityLinkKind;
}

export function formatBoardTaskActivityTaskLabel(
  task: BoardTaskActivityTaskRef | undefined
): string | null {
  if (!task) return null;
  if (task.taskRef) {
    return `#${task.taskRef.displayId}`;
  }
  if (task.locator.ref) {
    return `#${task.locator.ref}`;
  }
  return null;
}

function describeRelationshipAction(
  action: BoardTaskActivityAction | undefined,
  verb: 'link' | 'unlink'
): string {
  const peerTaskLabel = formatBoardTaskActivityTaskLabel(action?.peerTask);
  const relationship = action?.details?.relationship;

  if (relationship === 'related' && peerTaskLabel) {
    return verb === 'link'
      ? `Linked related task ${peerTaskLabel}`
      : `Removed related link with ${peerTaskLabel}`;
  }

  if (action?.relationshipPerspective === 'incoming' && peerTaskLabel) {
    return verb === 'link'
      ? `Linked blocked by ${peerTaskLabel}`
      : `Removed blocked-by link from ${peerTaskLabel}`;
  }

  if (action?.relationshipPerspective === 'outgoing' && peerTaskLabel) {
    return verb === 'link'
      ? `Linked blocks ${peerTaskLabel}`
      : `Removed blocks link to ${peerTaskLabel}`;
  }

  if (relationship) {
    return verb === 'link' ? `Linked task as ${relationship}` : `Removed ${relationship} link`;
  }

  return verb === 'link' ? 'Linked task' : 'Removed task link';
}

export function describeBoardTaskActivityLabel(input: BoardTaskActivityLabelInput): string {
  const toolName = input.action?.canonicalToolName;
  switch (toolName) {
    case 'task_start':
      return 'Started work';
    case 'task_complete':
      return 'Completed task';
    case 'task_set_status':
      return input.action?.details?.status
        ? `Set status to ${input.action.details.status}`
        : 'Updated task status';
    case 'review_start':
      return 'Started review';
    case 'review_approve':
      return 'Approved review';
    case 'review_request_changes':
      return 'Requested changes';
    case 'review_request':
      return input.action?.details?.reviewer
        ? `Requested review from ${input.action.details.reviewer}`
        : 'Requested review';
    case 'task_add_comment':
      return 'Added a comment';
    case 'task_attach_file':
      return input.action?.details?.filename
        ? `Attached ${input.action.details.filename}`
        : 'Attached a file';
    case 'task_attach_comment_file':
      return input.action?.details?.filename
        ? `Attached ${input.action.details.filename} to a comment`
        : 'Attached a file to a comment';
    case 'task_get':
      return 'Viewed task';
    case 'task_get_comment':
      return input.action?.details?.commentId
        ? `Viewed comment ${input.action.details.commentId}`
        : 'Viewed comment';
    case 'task_link':
      return describeRelationshipAction(input.action, 'link');
    case 'task_unlink':
      return describeRelationshipAction(input.action, 'unlink');
    case 'task_set_clarification':
      if (
        input.action?.details?.clarification === 'lead' ||
        input.action?.details?.clarification === 'user'
      ) {
        return `Set clarification to ${input.action.details.clarification}`;
      }
      if (input.action?.details && 'clarification' in input.action.details) {
        return 'Cleared clarification';
      }
      return 'Updated clarification';
    case 'task_set_owner':
      if (typeof input.action?.details?.owner === 'string' && input.action.details.owner.trim()) {
        return `Assigned owner to ${input.action.details.owner}`;
      }
      if (input.action?.details && 'owner' in input.action.details) {
        return 'Cleared owner';
      }
      return 'Updated owner';
    case 'kanban_set_column':
      return 'Updated column';
    default:
      if (input.linkKind === 'execution') {
        return 'Worked on task';
      }
      if (input.linkKind === 'lifecycle') {
        return 'Updated task lifecycle';
      }
      return 'Performed a related board action';
  }
}
