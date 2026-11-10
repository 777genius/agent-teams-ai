import type { TeamCommand } from './contracts.js';

/** User-start provenance includes the original assigned immediate-create intent. */
export function isUserTaskStartIntent(command: TeamCommand): boolean {
  return (
    command.operation === 'task.start' ||
    (command.operation === 'task.create' &&
      command.payload.startImmediately === true &&
      typeof command.payload.owner === 'string' &&
      Boolean(command.payload.owner.trim()))
  );
}

/** Only these product intents require the captured human Task actor. */
export function requiresHumanTaskActor(command: TeamCommand): boolean {
  return isUserTaskStartIntent(command) ||
    (command.operation === 'task.review' && command.payload.action === 'disapprove');
}
