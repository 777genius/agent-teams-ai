import { BoundaryViolationError } from "../domain/errors.js";
const textDecoder = new TextDecoder();
export class DefaultRedactor {
    secrets = new Map();
    registerSecret(value, label = "secret") {
        const normalized = typeof value === "string" ? value : textDecoder.decode(value);
        if (normalized.length === 0) {
            return;
        }
        this.secrets.set(normalized, label);
    }
    redact(input) {
        let output = input;
        for (const [secret, label] of this.secrets.entries()) {
            output = output.split(secret).join(`[redacted:${label}]`);
        }
        output = output.replace(/["']?\b(?:access_token|refresh_token|id_token|api_key|token)\b["']?\s*[:=]\s*["']?[^"',}\s]+["']?/gi, (match) => {
            const key = match.match(/["']?([A-Za-z_]+)["']?\s*[:=]/)?.[1];
            return `${key ?? "token"}=[redacted:token-field]`;
        });
        output = output.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]");
        return output;
    }
    assertNoKnownSecret(input, context) {
        for (const secret of this.secrets.keys()) {
            if (input.includes(secret)) {
                throw new BoundaryViolationError(`Known secret leaked through ${context}`);
            }
        }
    }
}
export class NullObservability {
    emit() { }
    count() { }
    timing() { }
}
export class SystemClock {
    now() {
        return new Date();
    }
    monotonicMs() {
        return performance.now();
    }
}
export class DeterministicIdGenerator {
    next = 1;
    leaseId() {
        return `lease-${this.next++}`;
    }
    idempotencyKey(input) {
        return [
            input.providerInstanceId,
            input.runId,
            String(input.attempt),
            input.purpose,
        ].join(":");
    }
    operationId(prefix) {
        return `${prefix}-${this.next++}`;
    }
}
//# sourceMappingURL=redactor.js.map