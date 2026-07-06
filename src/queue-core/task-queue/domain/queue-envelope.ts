import type { SubscriptionQueueTask } from "./queue-task";

export enum SubscriptionQueueEnvelopeKind {
  Task = "subscription_queue_task",
}

export const subscriptionQueueTaskEnvelopeVersion = 1 as const;

export type SubscriptionQueueTaskEnvelope<Job> = {
  readonly kind: `${SubscriptionQueueEnvelopeKind.Task}`;
  readonly version: typeof subscriptionQueueTaskEnvelopeVersion;
  readonly queueId: string;
  readonly task: SubscriptionQueueTask<Job>;
};

export function buildSubscriptionQueueTaskEnvelope<Job>(input: {
  readonly queueId: string;
  readonly task: SubscriptionQueueTask<Job>;
}): SubscriptionQueueTaskEnvelope<Job> {
  return {
    kind: SubscriptionQueueEnvelopeKind.Task,
    version: subscriptionQueueTaskEnvelopeVersion,
    queueId: input.queueId,
    task: input.task,
  };
}
