import type { HostedActualOwnerCandidateOpenCodeSha256 } from '../../services/team/provisioning/HostedApprovalRuntimeActivationTypes';

export const NATIVE_ACTIVATION_HANDLE_CONTRACT = 'agent-teams.hosted-native-activation-handle/v1';
export const NATIVE_ACTIVATION_ENTRY_ARGUMENT = '--hosted-native-activation-v1';
const HASH = /^[0-9a-f]{64}$/u;
const MAX_MESSAGE = 16 * 1024;

/** Auxiliary handle-transfer metadata, not authority to choose verification roots. */
export interface NativeActivationHandleSelection {
  readonly contract: typeof NATIVE_ACTIVATION_HANDLE_CONTRACT;
  readonly ownerProcessStartToken: string;
  readonly bootstrapV2HeaderSha256: string;
  readonly bootstrapDigest: string;
  readonly ownerGeneration: number;
  readonly ownerSessionId: string;
  readonly expectedOpenCodeExecutableSha256: HostedActualOwnerCandidateOpenCodeSha256;
}

export function decodeNativeActivationHandleSelection(value: unknown): NativeActivationHandleSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('native_activation_handle_message');
  const row = value as Record<string, unknown>;
  const keys = ['contract', 'ownerProcessStartToken', 'bootstrapV2HeaderSha256', 'bootstrapDigest',
    'ownerGeneration', 'ownerSessionId', 'expectedOpenCodeExecutableSha256'];
  if (Reflect.ownKeys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key)) ||
    Buffer.byteLength(JSON.stringify(row)) > MAX_MESSAGE || row.contract !== NATIVE_ACTIVATION_HANDLE_CONTRACT ||
    ![row.ownerProcessStartToken, row.bootstrapV2HeaderSha256, row.bootstrapDigest].every(
      item => typeof item === 'string' && HASH.test(item)) ||
    !Number.isSafeInteger(row.ownerGeneration) || (row.ownerGeneration as number) < 1 ||
    typeof row.ownerSessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(row.ownerSessionId) ||
    row.expectedOpenCodeExecutableSha256 !== 'cffecbe3ff685de84d7fa028e552c42d15a7c720a8f8d5d1cddd265110e5eb88') {
    throw new Error('native_activation_handle_selection');
  }
  return Object.freeze({ ...row }) as unknown as NativeActivationHandleSelection;
}
