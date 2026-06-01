export class SubscriptionWorkerError extends Error {
    code;
    constructor(code, message, options = {}) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.code = code;
        this.name = "SubscriptionWorkerError";
        this.details = options.details ?? {};
    }
    details;
}
export function isSubscriptionWorkerError(error) {
    return error instanceof SubscriptionWorkerError;
}
//# sourceMappingURL=errors.js.map