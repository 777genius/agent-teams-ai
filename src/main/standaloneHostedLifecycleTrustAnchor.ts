import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import {
  type OrchestratorLifecycleOwnerProofKey,
  parseOrchestratorLifecycleOwnerProofKey,
} from './composition/hosted/hostedLifecycleOrchestratorReadiness';

import type { RuntimeInstanceContext } from '@features/runtime-instance-context/contracts';

export function readHostedLifecycleOrchestratorTrustAnchor(
  runtimeInstance: null,
  environment: Readonly<Record<string, string | undefined>>
): null;
export function readHostedLifecycleOrchestratorTrustAnchor(
  runtimeInstance: RuntimeInstanceContext,
  environment: Readonly<Record<string, string | undefined>>
): OrchestratorLifecycleOwnerProofKey;
export function readHostedLifecycleOrchestratorTrustAnchor(
  runtimeInstance: RuntimeInstanceContext | null,
  environment: Readonly<Record<string, string | undefined>>
): OrchestratorLifecycleOwnerProofKey | null {
  if (runtimeInstance === null) return null;
  const inline = environment.HOSTED_LIFECYCLE_ORCHESTRATOR_TRUST_ANCHOR;
  const filePath = environment.HOSTED_LIFECYCLE_ORCHESTRATOR_TRUST_ANCHOR_FILE;
  if (inline !== undefined && filePath !== undefined) {
    throw new TypeError('orchestrator-lifecycle-owner-proof-key-source-ambiguous');
  }
  if (
    inline !== undefined &&
    environment.HOSTED_LIFECYCLE_ORCHESTRATOR_TEST_ONLY_INLINE_TRUST_ANCHOR !== '1'
  ) {
    throw new TypeError('orchestrator-lifecycle-owner-proof-key-inline-production-forbidden');
  }
  if (filePath === undefined) return parseOrchestratorLifecycleOwnerProofKey(inline);
  if (!isAbsolute(filePath) || resolve(filePath) !== filePath || filePath.includes('\0')) {
    throw new TypeError('orchestrator-lifecycle-owner-proof-key-file-invalid');
  }
  const before = lstatSync(filePath, { bigint: true });
  let descriptor: number;
  try {
    descriptor = openSync(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch {
    throw new TypeError('orchestrator-lifecycle-owner-proof-key-file-invalid');
  }
  try {
    const stat = fstatSync(descriptor, { bigint: true });
    const mode = Number(stat.mode & 0o777n);
    const runtimeUid = process.getuid?.() ?? 0;
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      !stat.isFile() ||
      before.dev !== stat.dev ||
      before.ino !== stat.ino ||
      (stat.uid !== 0n && stat.uid !== BigInt(runtimeUid)) ||
      mode !== 0o400 ||
      stat.size < 64n ||
      stat.size > 65n
    ) {
      throw new TypeError('orchestrator-lifecycle-owner-proof-key-file-invalid');
    }
    const bytes = Buffer.alloc(Number(stat.size));
    const bytesRead = readSync(descriptor, bytes, 0, bytes.byteLength, 0);
    if (bytesRead !== bytes.byteLength) {
      throw new TypeError('orchestrator-lifecycle-owner-proof-key-file-substituted');
    }
    const text = bytes.toString('utf8');
    const descriptorAfter = fstatSync(descriptor, { bigint: true });
    const after = lstatSync(filePath, { bigint: true });
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      descriptorAfter.dev !== stat.dev ||
      descriptorAfter.ino !== stat.ino ||
      descriptorAfter.size !== stat.size ||
      descriptorAfter.mtimeNs !== stat.mtimeNs ||
      descriptorAfter.ctimeNs !== stat.ctimeNs ||
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.size !== stat.size ||
      after.mtimeNs !== stat.mtimeNs ||
      after.ctimeNs !== stat.ctimeNs
    ) {
      throw new TypeError('orchestrator-lifecycle-owner-proof-key-file-substituted');
    }
    return parseOrchestratorLifecycleOwnerProofKey(text.endsWith('\n') ? text.slice(0, -1) : text);
  } finally {
    closeSync(descriptor);
  }
}
