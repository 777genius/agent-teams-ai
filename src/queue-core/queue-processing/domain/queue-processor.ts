export enum QueueProcessorStateKind {
  Created = "created",
  Running = "running",
  Stopping = "stopping",
  Stopped = "stopped",
}

export type QueueProcessorState = `${QueueProcessorStateKind}`;

export type QueueProcessorStats = {
  readonly state: QueueProcessorState;
  readonly claimed: number;
  readonly completed: number;
  readonly retried: number;
  readonly deadLettered: number;
  readonly failed: number;
};
