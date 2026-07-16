import * as ids from './identifiers';
declare const scopeBrand: unique symbol;
export type AuthorizedScope = string & { readonly [scopeBrand]: 'AuthorizedScope' };
const CONTEXT_KEYS = new Set(
  'actorId,sessionId,deploymentId,bootId,requestId,authorizedScope,deadlineAtMs,signal'.split(',')
);
export function parseAuthorizedScope(value: unknown): AuthorizedScope {
  if (typeof value !== 'string' || !/^scope_[A-Za-z0-9][A-Za-z0-9._-]{0,121}$/.test(value)) {
    throw new TypeError('hosted-contract-authorized-scope-invalid');
  }
  return value as AuthorizedScope;
}
// In-process execution context. The host assembles it from the authenticated principal and
// runtime (deadline, cancellation); it is never parsed from a wire payload, so client-supplied
// identity cannot reach the application layer.
export function createQueryContext(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('hosted-contract-query-context-invalid');
  }
  const input = value as Record<string, unknown>;
  if (Reflect.ownKeys(input).some((key) => typeof key !== 'string' || !CONTEXT_KEYS.has(key))) {
    throw new TypeError('hosted-contract-query-context-invalid');
  }
  // Snapshot once so getters cannot swap values between validation and the frozen result.
  const deadlineAtMs = input.deadlineAtMs;
  const signal = input.signal;
  if (!Number.isSafeInteger(deadlineAtMs) || (deadlineAtMs as number) < 0) {
    throw new TypeError('hosted-contract-query-context-invalid');
  }
  if (!(signal instanceof AbortSignal)) {
    throw new TypeError('hosted-contract-query-context-invalid');
  }
  return Object.freeze({
    actorId: ids.parseActorId(input.actorId),
    sessionId: ids.parseSessionId(input.sessionId),
    deploymentId: ids.parseDeploymentId(input.deploymentId),
    bootId: ids.parseBootId(input.bootId),
    requestId: ids.parseRequestId(input.requestId),
    authorizedScope: parseAuthorizedScope(input.authorizedScope),
    deadlineAtMs: deadlineAtMs as number,
    signal,
  });
}
export type QueryContext = ReturnType<typeof createQueryContext>;
