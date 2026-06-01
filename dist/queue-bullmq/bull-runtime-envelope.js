const envelopeMarker = "__subscriptionRuntime";
const envelopeVersion = 1;
export function encodeBullSubscriptionRuntimeJob(input) {
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
export function decodeBullSubscriptionRuntimeJob(data) {
    if (!isBullSubscriptionRuntimeEnvelope(data)) {
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
function isBullSubscriptionRuntimeEnvelope(value) {
    if (!value || typeof value !== "object") {
        return false;
    }
    const maybeEnvelope = value;
    const metadata = maybeEnvelope[envelopeMarker];
    if (!metadata || typeof metadata !== "object") {
        return false;
    }
    const maybeMetadata = metadata;
    return (maybeMetadata.version === envelopeVersion &&
        Object.prototype.hasOwnProperty.call(maybeMetadata, "job") &&
        typeof maybeMetadata.idempotencyKey === "string" &&
        maybeMetadata.idempotencyKey.length > 0);
}
//# sourceMappingURL=bull-runtime-envelope.js.map