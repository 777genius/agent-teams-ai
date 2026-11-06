import type { RuntimeMemberBinding } from './contracts.js';

/** Private persisted Task decision provenance. No prompt or mutable task-status heuristic. */
export interface TaskStartCause {
  readonly taskId: string;
  readonly taskStartCommandId: string;
  readonly messageId: string;
  readonly deliveryId: string;
  readonly inputId: string;
  readonly binding: Readonly<RuntimeMemberBinding>;
}
