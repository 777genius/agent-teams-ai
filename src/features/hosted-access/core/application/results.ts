import type { HostedAccessRejectionCode, HostedAccessResult } from '../../contracts';

export function accepted<Value, Code extends string>(
  code: Code,
  value: Value
): HostedAccessResult<Value, Code> {
  return { ok: true, code, value };
}

export function rejected(code: HostedAccessRejectionCode): HostedAccessResult<never, never> {
  return { ok: false, code };
}
