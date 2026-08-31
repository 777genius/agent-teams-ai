/// <reference types="node" />

export const OWNER_LOCK_FILENAME: 'hosted-lifecycle-owner.lock.json';
export const STACK_LOCK_FILENAME: 'hosted-stack.lock.json';
export const OWNER_LOCK_TYPE: 'hosted-lifecycle-owner';
export const STACK_LOCK_TYPE: 'hosted-stack';
export const LOCK_SCHEMA_VERSION: 1;
export const MAX_LOCK_BYTES: number;
export const LEGACY_HOSTED_OWNER_LOCK_FILENAME: 'hosted-lifecycle-owner-runtime.lock.json';

export interface HostedLock extends Record<string, unknown> {
  lockType: string;
}

export function canonicalJsonBytes(value: unknown): Buffer;
export function sha256Digest(bytes: Uint8Array): string;
export function parseOwnerLock(bytes: Uint8Array): HostedLock;
export function parseStackLock(bytes: Uint8Array): HostedLock;
export function verifyHostedLockPair(
  ownerBytes: Uint8Array,
  stackBytes: Uint8Array
): { owner: HostedLock; stack: HostedLock };
