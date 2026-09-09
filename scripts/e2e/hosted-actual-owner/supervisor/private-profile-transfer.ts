import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson, exactRecord, sha256 } from './canonical';

export const SERVER_AUTH_V1 = 'agent-teams.hosted-control.opencode-server-auth/v1' as const;
export const SERVER_AUTH_V2 = 'agent-teams.hosted-control.opencode-server-auth/v2' as const;
export const PROFILE_BINDING = 'agent-teams.opencode-prepared-profile-binding/v1' as const;
export const PROFILE_MAXIMUM = 768 * 1024;
export const AUTH_DOCUMENT_MAXIMUM = 1024 * 1024;
export type ServerAuthFormat = typeof SERVER_AUTH_V1 | typeof SERVER_AUTH_V2;
export interface PreparedProfileBinding {
  readonly format: typeof PROFILE_BINDING;
  readonly publicationId: string;
  readonly byteLength: number;
  readonly hmacSha256: string;
}
export interface PreparedProfileTransfer {
  readonly preparedProfile: unknown;
  readonly preparedProfileSha256: string;
  readonly publicationId: string;
  readonly binding: PreparedProfileBinding;
}
export interface PreparedProfileContext {
  readonly expectedHostSha256: string;
  readonly ownerProcessStartToken: string;
  readonly bootstrapDigest: string;
}
/** Structural contract of Owner's actual retainPreparedProfile return. Never a
 * prepared-result factory: selected runtime retains the real preparer's return. */
export interface RetainedPreparedProfile {
  readonly publicationId: string;
  transfer(key: Uint8Array, context: PreparedProfileContext): PreparedProfileTransfer;
  close(): void;
}
function check(value: unknown): asserts value {
  if (!value) throw new Error('selected_private_profile_transfer_rejected');
}
/** Profile JSON permits finite noninteger configuration numbers and depth 64;
 * bootstrap's integer-only canonical helper must not encode this private body. */
export function privateProfileBytes(value: unknown, maximum: number): Buffer {
  function visit(item: unknown, depth: number): void {
    check(depth <= 64);
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number') { check(Number.isFinite(item) && !Object.is(item, -0)); return; }
    if (typeof item === 'string') { check(Buffer.from(item).toString('utf8') === item); return; }
    check(typeof item === 'object' && item !== null);
    if (Array.isArray(item)) { for (const entry of item) visit(entry, depth + 1); return; }
    check(Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null);
    for (const [key, entry] of Object.entries(item)) { visit(key, depth + 1); visit(entry, depth + 1); }
  }
  visit(value, 0);
  const canonical = (item: unknown): string => {
    if (item === null || typeof item !== 'object') return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
    return `{${Object.entries(item).sort(([a], [b]) => Buffer.from(a).compare(Buffer.from(b)))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  };
  const bytes = Buffer.from(canonical(value));
  if (bytes.length < 2 || bytes.length > maximum) { bytes.fill(0); check(false); }
  return bytes;
}
/** Independently bind the actual transfer to this generation before publishing
 * its small binding. No private digest or projection enters selectedStatic. */
export function validatePreparedProfileTransfer(
  transfer: PreparedProfileTransfer, key: Uint8Array, context: PreparedProfileContext,
): PreparedProfileBinding {
  exactRecord(context, ['expectedHostSha256', 'ownerProcessStartToken', 'bootstrapDigest'], 'selected_profile_context');
  exactRecord(transfer, ['preparedProfile', 'preparedProfileSha256', 'publicationId', 'binding'], 'selected_profile_transfer');
  const binding = exactRecord(transfer.binding, ['format', 'publicationId', 'byteLength', 'hmacSha256'], 'selected_profile_binding');
  check(key.length === 32 && Object.values(context).every(v => /^[0-9a-f]{64}$/u.test(v)));
  check(binding.format === PROFILE_BINDING && binding.publicationId === transfer.publicationId &&
    /^[0-9a-f]{64}$/u.test(transfer.publicationId) && typeof binding.hmacSha256 === 'string' &&
    /^[0-9a-f]{64}$/u.test(binding.hmacSha256));
  const bytes = privateProfileBytes(transfer.preparedProfile, PROFILE_MAXIMUM);
  try {
    check(transfer.preparedProfileSha256 === sha256(bytes) && binding.byteLength === bytes.length);
    const expected = createHmac('sha256', key).update(PROFILE_BINDING + '\0').update(canonicalJson({
      publicationId: transfer.publicationId, profileSha256: sha256(bytes), ...context,
    })).digest();
    check(timingSafeEqual(expected, Buffer.from(binding.hmacSha256, 'hex')));
    return Object.freeze({ ...transfer.binding });
  } finally { bytes.fill(0); }
}
export function maximumAuthFrame(format: ServerAuthFormat): number {
  if (format === SERVER_AUTH_V1) return 8196;
  if (format === SERVER_AUTH_V2) return AUTH_DOCUMENT_MAXIMUM + 4;
  throw new Error('selected_server_auth_version');
}
