import type { AuthoritativeHostedApprovalRuntimeBinding } from './HostedApprovalRuntimeAdmissionPublisher';

export function immutableHostedApprovalRuntimeBinding(
  binding: AuthoritativeHostedApprovalRuntimeBinding
): AuthoritativeHostedApprovalRuntimeBinding {
  return deepFreeze(structuredClone(binding));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
