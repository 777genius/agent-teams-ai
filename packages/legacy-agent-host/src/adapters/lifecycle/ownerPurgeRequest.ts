import { digest } from '../../team/identity.js';
import type { TeamBinding } from '../../team/contracts.js';

/** Correlation belongs to the original deletion intent, which outlives the removed Team namespace. */
export interface OwnerPurgeRequest {
  binding: TeamBinding;
  principalId: string;
  commandId: string;
  expectedRevision: string;
  fingerprint: string;
  scopeDigest: string;
}
export function createOwnerPurgeRequest(binding: TeamBinding, principalId: string, commandId: string, expectedRevision: string, capturedScope: unknown): OwnerPurgeRequest {
  const input = { binding: { ...binding }, principalId, commandId, expectedRevision, scopeDigest: digest(capturedScope) };
  const request = { ...input, fingerprint: digest(input) };
  if (!isOwnerPurgeRequest(request)) throw new Error('Invalid owner deletion request');
  return request;
}
export function isOwnerPurgeRequest(raw: unknown): raw is OwnerPurgeRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const value = raw as Partial<OwnerPurgeRequest>;
  const text = (input: unknown): input is string => typeof input === 'string' && input.length > 0 && input.length <= 256 && !input.includes('\0');
  const binding = value.binding;
  if (Object.keys(value).sort().join() !== 'binding,commandId,expectedRevision,fingerprint,principalId,scopeDigest' ||
    !binding || Object.keys(binding).sort().join() !== 'backendId,teamId,teamName' ||
    !text(binding.backendId) || !text(binding.teamId) || !text(binding.teamName) || !text(value.principalId) || !text(value.commandId) ||
    typeof value.scopeDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.scopeDigest) ||
    typeof value.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(value.expectedRevision)) return false;
  return value.fingerprint === digest({ binding, principalId: value.principalId, commandId: value.commandId, expectedRevision: value.expectedRevision, scopeDigest: value.scopeDigest });
}
export function sameOwnerPurgeRequest(left: OwnerPurgeRequest | undefined, right: OwnerPurgeRequest | undefined): boolean {
  return left === undefined ? right === undefined : right !== undefined && isOwnerPurgeRequest(left) && isOwnerPurgeRequest(right) && left.fingerprint === right.fingerprint;
}
