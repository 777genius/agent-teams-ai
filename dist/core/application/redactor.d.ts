import type { RedactorPort } from "../ports";
export declare class DefaultRedactor implements RedactorPort {
    private readonly secrets;
    registerSecret(value: string | Uint8Array, label?: string): void;
    redact(input: string): string;
    assertNoKnownSecret(input: string, context: string): void;
}
export declare class NullObservability {
    emit(): void;
    count(): void;
    timing(): void;
}
export declare class SystemClock {
    now(): Date;
    monotonicMs(): number;
}
export declare class DeterministicIdGenerator {
    private next;
    leaseId(): string;
    idempotencyKey(input: {
        readonly providerInstanceId: string;
        readonly runId: string;
        readonly attempt: number;
        readonly purpose: string;
    }): string;
    operationId(prefix: string): string;
}
//# sourceMappingURL=redactor.d.ts.map