export class SubscriptionQueueError extends Error {
    code;
    constructor(code, message, options = {}) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.code = code;
        this.name = "SubscriptionQueueError";
    }
}
//# sourceMappingURL=errors.js.map