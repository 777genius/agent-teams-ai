import type { SubscriptionQueueEnqueueInput } from "@777genius/subscription-runtime/queue-core";

const envelopeMarker = "__subscriptionRuntime";
const envelopeVersion = 1;

type BullSubscriptionRuntimeEnvelope<Job> = {
  readonly [envelopeMarker]: {
    readonly version: typeof envelopeVersion;
    readonly job: Job;
    readonly idempotencyKey: string;
  };
};

export type DecodedBullSubscriptionRuntimeJob<Job> = {
  readonly job: Job;
  readonly idempotencyKey?: string;
  readonly isEnvelope: boolean;
};

export function encodeBullSubscriptionRuntimeJob<Job>(
  input: SubscriptionQueueEnqueueInput<Job>,
): Job | BullSubscriptionRuntimeEnvelope<Job> {
  if (!input.idempotencyKey) {
    return input.job;
  }
  return {
    [envelopeMarker]: {
      version: envelopeVersion,
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
    job: data[envelopeMarker].job,
    idempotencyKey: data[envelopeMarker].idempotencyKey,
    isEnvelope: true,
  };
}

function isBullSubscriptionRuntimeEnvelope<Job>(
  value: unknown,
): value is BullSubscriptionRuntimeEnvelope<Job> {
  if (!value || typeof value !== "object") {
    return false;
  }
  const maybeEnvelope = value as Partial<
    Record<typeof envelopeMarker, unknown>
  >;
  const metadata = maybeEnvelope[envelopeMarker];
  if (!metadata || typeof metadata !== "object") {
    return false;
  }
  const maybeMetadata = metadata as {
    readonly version?: unknown;
    readonly job?: unknown;
    readonly idempotencyKey?: unknown;
  };
  return (
    maybeMetadata.version === envelopeVersion &&
    Object.prototype.hasOwnProperty.call(maybeMetadata, "job") &&
    typeof maybeMetadata.idempotencyKey === "string" &&
    maybeMetadata.idempotencyKey.length > 0
  );
}
