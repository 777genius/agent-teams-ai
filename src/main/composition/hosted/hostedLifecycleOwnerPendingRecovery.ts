import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// eslint-disable-next-line no-restricted-imports -- Public strict lifecycle wire parser.
import { parseStrictOrchestratorJsonFrame } from '@features/team-lifecycle/main/hosted';

import { recoverAtomicNoReplaceMarker } from './atomicNoReplaceMarker';
import {
  assertBinding,
  assertMarkerPayload,
  type HostedLifecycleOwnerHighWaterBinding,
  markerPayload,
} from './hostedLifecycleOwnerHighWaterBinding';

const PENDING_PATTERN = /^\.pending-([0-9a-f]{64})$/u;
const GENERATION_PATTERN = /^[1-9][0-9]{0,15}$/u;
const SESSION_PATTERN = /^session-([0-9a-f]{64})$/u;
const MAXIMUM_BINDING_MARKER_BYTES = 512;

interface PendingPlan {
  readonly binding: HostedLifecycleOwnerHighWaterBinding;
  readonly finalName: string;
  readonly kind: 'generation' | 'session';
  readonly pendingName: string;
}

function pendingName(finalName: string, payload: string): string {
  return `.pending-${createHash('sha256')
    .update(`${finalName}\u0000${payload}`, 'utf8')
    .digest('hex')}`;
}

function sessionName(ownerSessionId: string): string {
  return `session-${createHash('sha256').update(ownerSessionId, 'utf8').digest('hex')}`;
}

function sameBinding(
  left: HostedLifecycleOwnerHighWaterBinding,
  right: HostedLifecycleOwnerHighWaterBinding
): boolean {
  return (
    left.ownerAuthority === right.ownerAuthority &&
    left.ownerGeneration === right.ownerGeneration &&
    left.ownerSessionId === right.ownerSessionId
  );
}

async function readStableMarker(input: {
  readonly path: string;
  readonly expectedUid: number;
  readonly expectedGid: number;
  readonly allowTwoLinks: boolean;
}): Promise<Readonly<{ body: string; device: bigint; inode: bigint; links: bigint }>> {
  const handle = await open(
    input.path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const before = await handle.stat({ bigint: true });
    const validLinks = before.nlink === 1n || (input.allowTwoLinks && before.nlink === 2n);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.uid !== BigInt(input.expectedUid) ||
      before.gid !== BigInt(input.expectedGid) ||
      Number(before.mode & 0o777n) !== 0o600 ||
      before.size < 1n ||
      before.size > BigInt(MAXIMUM_BINDING_MARKER_BYTES) ||
      !validLinks
    ) {
      throw new Error('hosted-lifecycle-orchestrator-high-water-invalid');
    }
    const buffer = Buffer.alloc(MAXIMUM_BINDING_MARKER_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    const [after, pathStat] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(input.path, { bigint: true }),
    ]);
    if (
      bytesRead !== Number(before.size) ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      after.nlink !== before.nlink ||
      pathStat.isSymbolicLink() ||
      pathStat.dev !== before.dev ||
      pathStat.ino !== before.ino
    ) {
      throw new Error('hosted-lifecycle-orchestrator-high-water-invalid');
    }
    return Object.freeze({
      body: buffer.toString('utf8', 0, bytesRead),
      device: before.dev,
      inode: before.ino,
      links: before.nlink,
    });
  } finally {
    await handle.close();
  }
}

async function classifyPending(input: {
  readonly stableAuthority: string;
  readonly ownerAuthority: string;
  readonly pendingName: string;
  readonly expectedUid: number;
  readonly expectedGid: number;
}): Promise<PendingPlan> {
  const pendingPath = join(input.stableAuthority, input.pendingName);
  const pending = await readStableMarker({
    path: pendingPath,
    expectedUid: input.expectedUid,
    expectedGid: input.expectedGid,
    allowTwoLinks: true,
  });
  const parsed = assertMarkerPayload(parseStrictOrchestratorJsonFrame(pending.body), null);
  const binding = Object.freeze({
    ownerAuthority: input.ownerAuthority,
    ownerGeneration: parsed.generation,
    ownerSessionId: parsed.ownerSessionId,
  });
  assertBinding(binding);
  const payload = markerPayload(binding);
  if (payload !== pending.body) {
    throw new Error('hosted-lifecycle-orchestrator-high-water-invalid');
  }
  const candidates = [
    { kind: 'generation' as const, finalName: String(binding.ownerGeneration) },
    { kind: 'session' as const, finalName: sessionName(binding.ownerSessionId) },
  ].filter(({ finalName }) => pendingName(finalName, payload) === input.pendingName);
  if (candidates.length !== 1 || PENDING_PATTERN.exec(input.pendingName) === null) {
    throw new Error('hosted-lifecycle-orchestrator-high-water-invalid');
  }
  const candidate = candidates[0];
  const finalPath = join(input.stableAuthority, candidate.finalName);
  const final = await readStableMarker({
    path: finalPath,
    expectedUid: input.expectedUid,
    expectedGid: input.expectedGid,
    allowTwoLinks: true,
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (final === null) {
    if (pending.links !== 1n) {
      throw new Error('hosted-lifecycle-orchestrator-high-water-invalid');
    }
  } else if (
    pending.links !== 2n ||
    final.links !== 2n ||
    pending.device !== final.device ||
    pending.inode !== final.inode ||
    final.body !== payload
  ) {
    throw new Error('hosted-lifecycle-orchestrator-high-water-invalid');
  }
  return Object.freeze({
    binding,
    finalName: candidate.finalName,
    kind: candidate.kind,
    pendingName: input.pendingName,
  });
}

/**
 * Recovers every safely attributable atomic marker in one authority namespace while its admission
 * lock is held. Classification of the complete pending set finishes before the first unlink, so a
 * foreign or malformed residue cannot be hidden by a partial cleanup pass.
 */
export async function recoverHostedLifecycleOwnerPendingMarkers(input: {
  readonly stableAuthority: string;
  readonly authorityHandle: FileHandle;
  readonly expectedUid: number;
  readonly expectedGid: number;
  readonly ownerAuthority: string;
  readonly currentBinding: HostedLifecycleOwnerHighWaterBinding;
}): Promise<Readonly<{ session: 'absent' | 'published'; generation: 'absent' | 'published' }>> {
  const entries = await readdir(input.stableAuthority, { withFileTypes: true });
  const plans: PendingPlan[] = [];
  for (const entry of entries) {
    if (!entry.name.startsWith('.pending-')) continue;
    if (!entry.isFile() || !PENDING_PATTERN.test(entry.name)) {
      throw new Error('hosted-lifecycle-orchestrator-high-water-invalid');
    }
    plans.push(
      await classifyPending({
        stableAuthority: input.stableAuthority,
        ownerAuthority: input.ownerAuthority,
        pendingName: entry.name,
        expectedUid: input.expectedUid,
        expectedGid: input.expectedGid,
      })
    );
  }
  plans.sort((left, right) => left.pendingName.localeCompare(right.pendingName));

  // Reject foreign layout entries before recovery removes any valid pending link.
  for (const entry of entries) {
    if (
      (entry.name === '.admission-lock' && entry.isDirectory()) ||
      (entry.isFile() &&
        (PENDING_PATTERN.test(entry.name) ||
          GENERATION_PATTERN.test(entry.name) ||
          SESSION_PATTERN.test(entry.name)))
    ) {
      continue;
    }
    throw new Error('hosted-lifecycle-orchestrator-high-water-invalid');
  }

  let session: 'absent' | 'published' = 'absent';
  let generation: 'absent' | 'published' = 'absent';
  for (const plan of plans) {
    const recovered = await recoverAtomicNoReplaceMarker({
      parentPath: input.stableAuthority,
      parentHandle: input.authorityHandle,
      finalName: plan.finalName,
      payload: markerPayload(plan.binding),
      expectedUid: input.expectedUid,
      expectedGid: input.expectedGid,
      existing: 'reject',
    });
    if (sameBinding(plan.binding, input.currentBinding)) {
      if (plan.kind === 'session') session = recovered;
      else generation = recovered;
    }
  }

  return Object.freeze({ session, generation });
}
