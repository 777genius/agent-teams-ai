import type { SubscriptionQueueEnqueueInput } from "@vioxen/subscription-runtime/queue-core";

export const bullSubscriptionRuntimeEnvelopeMarker = "__subscriptionRuntime";
export const bullSubscriptionRuntimeEnvelopeVersion = 1 as const;

export type BullSubscriptionRuntimeEnvelope<Job> = {
  readonly [bullSubscriptionRuntimeEnvelopeMarker]: {
    readonly version: typeof bullSubscriptionRuntimeEnvelopeVersion;
    readonly job: Job;
    readonly idempotencyKey: string;
  };
};

export type BullSubscriptionRuntimeJobData<Job> =
  | Job
  | BullSubscriptionRuntimeEnvelope<Job>;

export type DecodedBullSubscriptionRuntimeJob<Job> = {
  readonly job: Job;
  readonly idempotencyKey?: string;
  readonly isEnvelope: boolean;
};

export function encodeBullSubscriptionRuntimeJob<Job>(
  input: SubscriptionQueueEnqueueInput<Job>,
): BullSubscriptionRuntimeJobData<Job> {
  if (!input.idempotencyKey) {
    return input.job;
  }
  return {
    [bullSubscriptionRuntimeEnvelopeMarker]: {
      version: bullSubscriptionRuntimeEnvelopeVersion,
      job: input.job,
      idempotencyKey: input.idempotencyKey,
    },
  };
}

export function decodeBullSubscriptionRuntimeJob<Job>(
  data: Job,
): DecodedBullSubscriptionRuntimeJob<Job> {
  if (!isBullSubscriptionRuntimeEnvelope<Job>(data)) {
    return {
      job: data,
      isEnvelope: false,
    };
  }
  return {
    job: data[bullSubscriptionRuntimeEnvelopeMarker].job,
    idempotencyKey:
      data[bullSubscriptionRuntimeEnvelopeMarker].idempotencyKey,
    isEnvelope: true,
  };
}

export function isBullSubscriptionRuntimeEnvelope<Job>(
  value: unknown,
): value is BullSubscriptionRuntimeEnvelope<Job> {
  if (!value || typeof value !== "object") {
    return false;
  }
  const maybeEnvelope = value as Partial<
    Record<typeof bullSubscriptionRuntimeEnvelopeMarker, unknown>
  >;
  const metadata = maybeEnvelope[bullSubscriptionRuntimeEnvelopeMarker];
  if (!metadata || typeof metadata !== "object") {
    return false;
  }
  const maybeMetadata = metadata as {
    readonly version?: unknown;
    readonly job?: unknown;
    readonly idempotencyKey?: unknown;
  };
  return (
    maybeMetadata.version === bullSubscriptionRuntimeEnvelopeVersion &&
    Object.prototype.hasOwnProperty.call(maybeMetadata, "job") &&
    typeof maybeMetadata.idempotencyKey === "string" &&
    maybeMetadata.idempotencyKey.length > 0
  );
}
