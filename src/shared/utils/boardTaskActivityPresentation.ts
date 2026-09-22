import { formatBoardTaskActivityTaskLabel } from './boardTaskActivityLabels';

import type {
  BoardTaskActivityAction,
  BoardTaskActivityActor,
  BoardTaskActivityActorContext,
  BoardTaskActivityLinkKind,
  BoardTaskActivityTaskRef,
} from '../types/team';

interface BoardTaskActivityPresentationInput {
  action?: BoardTaskActivityAction;
  actor: BoardTaskActivityActor;
  actorContext: BoardTaskActivityActorContext;
  task: BoardTaskActivityTaskRef;
  linkKind: BoardTaskActivityLinkKind;
}

export function describeBoardTaskActivityActorLabel(actor: BoardTaskActivityActor): string {
  if (actor.memberName) {
    return actor.memberName;
  }
  if (actor.role === 'lead' || actor.isSidechain === false) {
    return 'lead session';
  }
  return 'unknown actor';
}

function relationshipContextLabel(action: BoardTaskActivityAction | undefined): string | null {
  const peerTaskLabel = formatBoardTaskActivityTaskLabel(action?.peerTask);
  if (!peerTaskLabel) return null;

  switch (action?.relationshipPerspective) {
    case 'incoming':
      return `from ${peerTaskLabel}`;
    case 'outgoing':
      return `to ${peerTaskLabel}`;
    default:
      return `with ${peerTaskLabel}`;
  }
}

export function describeBoardTaskActivityContextLines(
  input: BoardTaskActivityPresentationInput
): string[] {
  const parts: string[] = [];

  const relationshipContext = relationshipContextLabel(input.action);
  if (relationshipContext) {
    parts.push(relationshipContext);
  }

  if (input.actorContext.relation === 'other_active_task') {
    const activeTaskLabel = formatBoardTaskActivityTaskLabel(input.actorContext.activeTask);
    if (activeTaskLabel) {
      parts.push(`while working on ${activeTaskLabel}`);
    } else {
      parts.push('while another task was active');
    }
  } else if (input.actorContext.relation === 'ambiguous') {
    parts.push('while multiple task scopes were active');
  } else if (input.actorContext.relation === 'idle' && input.linkKind !== 'execution') {
    parts.push('without an active task scope');
  }

  if (input.task.resolution === 'deleted') {
    parts.push('task is deleted');
  } else if (input.task.resolution === 'ambiguous') {
    parts.push('task resolution is ambiguous');
  } else if (input.task.resolution === 'unresolved') {
    parts.push('task could not be resolved');
  }

  return parts;
}
