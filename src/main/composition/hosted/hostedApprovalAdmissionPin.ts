import type { OrchestratorLifecycleOwnerBinding } from './hostedLifecycleOrchestratorReadiness';

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
export type HostedApprovalAdmissionPin = Readonly<
  | { readonly state: 'provisioning' }
  | { readonly state: 'restart_required'; readonly approvalGeneration: number }
  | {
      readonly state: 'active';
      readonly approvalGeneration: number;
      readonly approvalDigest: `sha256:${string}`;
      readonly ownerGeneration: number;
    }
>;

export function parseHostedApprovalAdmissionPin(
  value: unknown,
  owner: OrchestratorLifecycleOwnerBinding
): HostedApprovalAdmissionPin {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('hosted-lifecycle-approval-admission-invalid');
  const record = value as Record<string, unknown>;
  const expected =
    record.state === 'provisioning'
      ? ['state']
      : record.state === 'restart_required'
        ? ['approvalGeneration', 'state']
        : ['approvalDigest', 'approvalGeneration', 'ownerGeneration', 'state'];
  if (Object.keys(record).sort().join('\0') !== expected.join('\0'))
    throw new TypeError('hosted-lifecycle-approval-admission-invalid');
  if (record.state === 'provisioning') return Object.freeze({ state: 'provisioning' });
  if (!Number.isSafeInteger(record.approvalGeneration) || (record.approvalGeneration as number) < 1)
    throw new TypeError('hosted-lifecycle-approval-admission-generation-invalid');
  if (record.state === 'restart_required')
    return Object.freeze({
      state: 'restart_required',
      approvalGeneration: record.approvalGeneration as number,
    });
  if (
    record.state !== 'active' ||
    typeof record.approvalDigest !== 'string' ||
    !DIGEST.test(record.approvalDigest) ||
    record.ownerGeneration !== owner.ownerGeneration
  )
    throw new TypeError('hosted-lifecycle-approval-admission-invalid');
  return Object.freeze({
    state: 'active',
    approvalGeneration: record.approvalGeneration as number,
    approvalDigest: record.approvalDigest as `sha256:${string}`,
    ownerGeneration: record.ownerGeneration as number,
  });
}
