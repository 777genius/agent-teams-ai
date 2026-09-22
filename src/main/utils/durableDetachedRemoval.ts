import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type DurablePathIdentity, getDurablePathIdentity } from './durablePathIdentity';
import {
  durablePathComponent,
  durablePathComponentWithBudget,
  legacyTruncatedDurablePathComponent,
  truncateDurablePathComponent,
} from './durablePathComponent';
import { withDurableReservationRecordLock } from './durableReservationRecordLock';
import { removeDurablePathExactAsync } from './durableExactRemoval';
import { removeExactDurableRecord } from './durableReservationRecordRemoval';
import { readBoundedFileHandleUtf8Async, unlinkDurablePathIfIdentityMatchesAsync, withIdentityStableDirectoryPathAsync } from './durablePathOperationSupport';
import type {
  AtomicPathRemovalResult,
  DurablePathRemovalProofHooks,
} from './durablePathOperations';
interface DeterministicDetachedRemovalOptions {
  readonly detachedPath: string;
  readonly removalOptions: {
    recursive?: boolean;
    force?: boolean;
    maxRetries?: number;
    retryDelay?: number;
  };
  readonly validateDetached?: DurableDetachedPathValidator;
  readonly proofHooks: DurablePathRemovalProofHooks;
  readonly syncParentDirectory: () => Promise<void>;
}
type DurableDetachedPathValidator = (
  detachedPath: string,
  identity: DurablePathIdentity
) => Promise<boolean>;

const RESERVATION_RECORD_VERSION = 1;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// The adjacent record is also a lock namespace. Reserve its longest durable
// lock/takeover/recovery suffix, rather than merely fitting the record itself.
const RECORD_LOCK_FAMILY_RESERVE_BYTES = 128;
const MAX_RESERVATION_RECEIPT_BYTES = 64 * 1024;
function durableRecordComponent(stem: string): string {
  return durablePathComponentWithBudget(
    stem,
    '.reservation.json',
    255 - RECORD_LOCK_FAMILY_RESERVE_BYTES
  );
}
function legacyDurableRecordComponent(stem: string): string {
  return truncateDurablePathComponent(
    legacyTruncatedDurablePathComponent(stem, '.reservation.json'),
    255 - RECORD_LOCK_FAMILY_RESERVE_BYTES
  );
}
type DetachedRemovalPublicReservationPhase =
  | 'open'
  | 'cleaning'
  | 'republishing'
  | 'republished';
export interface DetachedRemovalPublicReservationPublication {
  readonly stagingPath?: string;
  readonly completionPath?: string;
  /** Set before copying.  Its absence only describes the mkdir crash window. */
  readonly stagingIdentity?: DurablePathIdentity;
  /**
   * v1.1 publication fence.  The final public name is reserved with mkdir
   * (never rename) and this private marker proves that the empty directory is
   * ours when a process resumes a partially copied publication.
   */
  readonly finalPath?: string;
  readonly markerPath?: string;
  readonly markerNonce?: string;
  readonly finalIdentity?: DurablePathIdentity;
}
export interface DetachedRemovalPublicReservationRecord {
  readonly version: typeof RESERVATION_RECORD_VERSION;
  /** The deterministic detached path identifies the owning deletion transaction. */
  readonly detachedPath: string;
  readonly targetPath: string;
  readonly reservationPath: string;
  readonly reservationNonce: string;
  /**
   * The reservation directory is prepared privately before this record is
   * published.  It is never inferred from a matching marker beside an
   * already-existing directory.
   */
  readonly reservationIdentity?: DurablePathIdentity;
  readonly reservationMarkerPath?: string;
  readonly reservationState?: 'intent' | 'owned';
  /** Planned before the public junction is moved; never a random recovery guess. */
  readonly tombstonePath?: string;
  /** Random private tombstone generation, persisted only after it is prepared. */
  readonly tombstoneNonce?: string;
  readonly tombstoneState?: 'planned' | 'prepared' | 'moved';
  readonly tombstoneIdentity?: DurablePathIdentity;
  readonly tombstoneMarkerPath?: string;
  readonly tombstoneCapturePath?: string;
  readonly tombstoneCaptureIdentity?: DurablePathIdentity;
  readonly tombstoneCaptureLinkReferent?: string;
  /**
   * Windows symlink type captured while the link was still at its public
   * parent.  A relative referent cannot be classified after it is moved into
   * the tombstone: resolving it there would inspect a different pathname.
   */
  readonly tombstoneCaptureLinkType?: 'file' | 'dir' | 'junction';
  readonly tombstoneCaptureLinkIdentity?: DurablePathIdentity;
  readonly tombstoneCapturedEntryIdentity?: DurablePathIdentity;
  readonly tombstoneCapturedEntryLinkReferent?: string;
  readonly tombstoneCapturedEntryLinkType?: 'file' | 'dir' | 'junction';
  /**
   * A deterministic, record-authenticated residue used while deleting the
   * captured reservation link.  It is persisted before the capture is moved
   * there, so a power loss after that rename has an exact recovery target.
   */
  readonly tombstoneCleanupPath?: string;
  readonly tombstoneCleanupIdentity?: DurablePathIdentity;
  /**
   * The second, descriptor-parented deletion generation for cleanupPath.  It
   * is recorded before the cleanup entry is renamed there, so a stopped
   * remover has one exact generation to settle instead of guessing from a
   * random `.deleting.*` sibling.
   */
  readonly tombstoneCleanupDetachedPath?: string;
  readonly tombstoneCleanupDetachedIdentity?: DurablePathIdentity;
  /** Final private namespace; journaled before the last detach/cleanup move. */
  readonly tombstoneCleanupFinalizationPath?: string;
  readonly tombstoneCleanupFinalizationIdentity?: DurablePathIdentity;
  /** Bound after the public junction is exposed; absent during its crash window. */
  readonly publicLinkIdentity?: DurablePathIdentity;
  readonly publication?: DetachedRemovalPublicReservationPublication;
  /** Missing is accepted as the v1 on-disk spelling of `open`. */
  readonly phase?: DetachedRemovalPublicReservationPhase;
}
export interface DetachedRemovalPublicReservationPublicationManifest {
  readonly version: typeof RESERVATION_RECORD_VERSION;
  readonly detachedPath: string;
  readonly targetPath: string;
  readonly reservationPath: string;
  readonly stagingPath: string;
  readonly stagingIdentity: DurablePathIdentity;
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function isTrustworthyIdentity(identity: unknown): identity is DurablePathIdentity {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return false;
  const candidate = identity as Partial<DurablePathIdentity>;
  return (
    Number.isSafeInteger(candidate.dev) && candidate.dev > 0 &&
    Number.isSafeInteger(candidate.ino) && candidate.ino > 0 &&
    Number.isFinite(candidate.birthtimeMs) && candidate.birthtimeMs >= 0
  );
}

function isSameIdentity(left: DurablePathIdentity, right: DurablePathIdentity): boolean {
  return (
    isTrustworthyIdentity(left) &&
    isTrustworthyIdentity(right) &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeMs === right.birthtimeMs
  );
}

function isValidPublication(
  value: unknown,
  record: Pick<
    DetachedRemovalPublicReservationRecord,
    'targetPath' | 'reservationPath' | 'reservationNonce'
  >
): value is DetachedRemovalPublicReservationPublication {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const publication = value as Partial<DetachedRemovalPublicReservationPublication>;
  const expectedStagingPath = `${record.reservationPath}.publication`;
  return (
    ((publication.stagingPath === expectedStagingPath &&
      publication.completionPath === `${expectedStagingPath}.complete.json`) ||
      (publication.finalPath === record.targetPath &&
        publication.markerPath ===
          path.join(record.targetPath, `.review-republish.${record.reservationNonce}.owner`) &&
        publication.markerNonce === record.reservationNonce)) &&
    (publication.stagingIdentity === undefined || isTrustworthyIdentity(publication.stagingIdentity)) &&
    (publication.finalIdentity === undefined || isTrustworthyIdentity(publication.finalIdentity))
  );
}

export function getDetachedRemovalPublicReservationPhase(
  record: DetachedRemovalPublicReservationRecord
): DetachedRemovalPublicReservationPhase {
  return record.phase ?? 'open';
}

export function getDetachedRemovalPublicReservationRecordPath(detachedPath: string): string {
  return path.join(
    path.dirname(detachedPath),
    durableRecordComponent(`.${path.basename(detachedPath)}`)
  );
}

function getLegacyDetachedRemovalPublicReservationRecordPath(detachedPath: string): string {
  return path.join(
    path.dirname(detachedPath),
    legacyDurableRecordComponent(`.${path.basename(detachedPath)}`)
  );
}

function getDetachedRemovalPublicReservationRecordPaths(detachedPath: string): readonly string[] {
  const current = getDetachedRemovalPublicReservationRecordPath(detachedPath);
  const legacy = getLegacyDetachedRemovalPublicReservationRecordPath(detachedPath);
  return current === legacy ? [current] : [current, legacy];
}

function getDetachedRemovalPublicReservationRecordTempPrefix(detachedPath: string): string {
  // Reserve the UUID which is appended by the writer.  This prefix is also
  // the authenticated family selector used by restart cleanup.
  return `${truncateDurablePathComponent(
    path.basename(getDetachedRemovalPublicReservationRecordPath(detachedPath)),
    255 - Buffer.byteLength('.tmp.') - 36
  )}.tmp.`;
}

/**
 * A stopped writer can leave a partial record only under this private, random
 * sibling name. It was never published, so it must not prevent a later writer
 * from publishing the complete record.
 */
function cleanupInterruptedPublicReservationRecordTemps(_detachedPath: string): Promise<void> {
  // A prefix is not ownership.  These uncommitted paths intentionally remain
  // inert until a receipt-bearing cleanup generation can authenticate them.
  return Promise.resolve();
}
function isCurrentOrLegacyTransactionPath(
  candidate: unknown,
  parentDirectory: string,
  stem: string,
  suffix: string
): candidate is string {
  return (
    candidate === path.join(parentDirectory, durablePathComponent(stem, suffix)) ||
    candidate === path.join(parentDirectory, legacyTruncatedDurablePathComponent(stem, suffix))
  );
}

function isValidRecord(
  value: unknown,
  input: { targetPath: string; detachedPath: string; parentDirectory: string }
): value is DetachedRemovalPublicReservationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<DetachedRemovalPublicReservationRecord>;
  const targetPath = path.resolve(input.targetPath);
  const detachedPath = path.resolve(input.detachedPath);
  const parentDirectory = path.resolve(input.parentDirectory);
  return (
    record.version === RESERVATION_RECORD_VERSION &&
    record.targetPath === targetPath &&
    record.detachedPath === detachedPath &&
    typeof record.reservationNonce === 'string' &&
    UUID_PATTERN.test(record.reservationNonce) &&
    isCurrentOrLegacyTransactionPath(
      record.reservationPath,
      parentDirectory,
      `.${path.basename(targetPath)}`,
      `.replacement.${record.reservationNonce}`
    ) &&
    (record.reservationIdentity === undefined || isTrustworthyIdentity(record.reservationIdentity)) &&
    (record.reservationMarkerPath === undefined ||
      record.reservationMarkerPath ===
      path.join(record.reservationPath!, `.review-reservation.${record.reservationNonce}.owner`)) &&
    (record.reservationState === undefined ||
      record.reservationState === 'intent' ||
      record.reservationState === 'owned') &&
    (record.tombstoneNonce === undefined ||
      (typeof record.tombstoneNonce === 'string' && UUID_PATTERN.test(record.tombstoneNonce))) &&
    (record.tombstonePath === undefined ||
      isCurrentOrLegacyTransactionPath(
        record.tombstonePath,
        parentDirectory,
        `.${path.basename(targetPath)}`,
        record.tombstoneNonce
          ? `.reservation-link.${record.reservationNonce}.${record.tombstoneNonce}.tombstone`
          : `.reservation-link.${record.reservationNonce}.tombstone`
      )) &&
    (record.tombstoneState === undefined ||
      record.tombstoneState === 'planned' ||
      record.tombstoneState === 'prepared' ||
      record.tombstoneState === 'moved') &&
    (record.tombstoneIdentity === undefined || isTrustworthyIdentity(record.tombstoneIdentity)) &&
    (record.tombstoneMarkerPath === undefined ||
      record.tombstonePath !== undefined &&
        record.tombstoneMarkerPath ===
          path.join(record.tombstonePath, `.review-tombstone.${record.reservationNonce}.owner`)) &&
    (record.tombstoneCapturePath === undefined ||
      record.tombstonePath !== undefined && record.tombstoneCapturePath === path.join(record.tombstonePath, 'captured')) &&
    (record.tombstoneCaptureIdentity === undefined || isTrustworthyIdentity(record.tombstoneCaptureIdentity)) &&
    (record.tombstoneCaptureLinkReferent === undefined ||
      typeof record.tombstoneCaptureLinkReferent === 'string') &&
    (record.tombstoneCaptureLinkType === undefined ||
      record.tombstoneCaptureLinkType === 'file' ||
      record.tombstoneCaptureLinkType === 'dir' ||
      record.tombstoneCaptureLinkType === 'junction') &&
    (record.tombstoneCaptureLinkIdentity === undefined ||
      isTrustworthyIdentity(record.tombstoneCaptureLinkIdentity)) &&
    (record.tombstoneCapturedEntryIdentity === undefined ||
      isTrustworthyIdentity(record.tombstoneCapturedEntryIdentity)) &&
    (record.tombstoneCapturedEntryLinkReferent === undefined ||
      typeof record.tombstoneCapturedEntryLinkReferent === 'string') &&
    (record.tombstoneCapturedEntryLinkType === undefined ||
      record.tombstoneCapturedEntryLinkType === 'file' ||
      record.tombstoneCapturedEntryLinkType === 'dir' ||
      record.tombstoneCapturedEntryLinkType === 'junction') &&
    (record.tombstoneCleanupPath === undefined ||
      ((record.tombstoneCapturePath !== undefined &&
        record.tombstoneCleanupPath ===
          path.join(record.tombstoneCapturePath, `entry.cleanup.${record.reservationNonce}`)) ||
        (record.tombstoneCleanupFinalizationPath !== undefined &&
          record.tombstoneCleanupPath ===
            path.join(record.tombstoneCleanupFinalizationPath, `entry.cleanup.${record.reservationNonce}`)))) &&
    (record.tombstoneCleanupIdentity === undefined ||
      isTrustworthyIdentity(record.tombstoneCleanupIdentity)) &&
    (record.tombstoneCleanupDetachedPath === undefined ||
      ((record.tombstoneCapturePath !== undefined &&
        record.tombstoneCleanupDetachedPath ===
          path.join(
            record.tombstoneCapturePath,
            `entry.cleanup.${record.reservationNonce}.deleting.${record.reservationNonce}`
          )) ||
        (record.tombstoneCleanupFinalizationPath !== undefined &&
          record.tombstoneCleanupDetachedPath ===
            path.join(
              record.tombstoneCleanupFinalizationPath,
              `entry.cleanup.${record.reservationNonce}.deleting.${record.reservationNonce}`
            )))) &&
    (record.tombstoneCleanupDetachedIdentity === undefined ||
      isTrustworthyIdentity(record.tombstoneCleanupDetachedIdentity)) &&
    (record.tombstoneCleanupFinalizationPath === undefined ||
      (record.tombstoneCapturePath !== undefined && record.tombstonePath !== undefined &&
        (record.tombstoneCleanupFinalizationPath === path.join(
          record.tombstonePath,
          `captured.finalizing.${record.reservationNonce}`
        ) ||
          // Read the first directory-local finalization spelling so a restart
          // can drain an artifact written before whole-parent detachment.
          record.tombstoneCleanupFinalizationPath === path.join(
            record.tombstoneCapturePath,
            `entry.cleanup.${record.reservationNonce}.finalizing.${record.reservationNonce}`
          )))) &&
    (record.tombstoneCleanupFinalizationIdentity === undefined ||
      isTrustworthyIdentity(record.tombstoneCleanupFinalizationIdentity)) &&
    (record.publicLinkIdentity === undefined || isTrustworthyIdentity(record.publicLinkIdentity)) &&
    (record.publication === undefined || isValidPublication(record.publication, record)) &&
    (record.phase === undefined ||
      record.phase === 'open' ||
      record.phase === 'cleaning' ||
      record.phase === 'republishing' ||
      record.phase === 'republished')
  );
}

function canAdvanceRecord(
  current: DetachedRemovalPublicReservationRecord,
  next: DetachedRemovalPublicReservationRecord
): boolean {
  const legacyFinalizationPath = current.tombstoneCapturePath ? path.join(current.tombstoneCapturePath, `entry.cleanup.${current.reservationNonce}.finalizing.${current.reservationNonce}`) : undefined;
  const detachedFinalizationPath = current.tombstonePath ? path.join(current.tombstonePath, `captured.finalizing.${current.reservationNonce}`) : undefined;
  // The legacy parent and its children can migrate in separate durable writes.
  const usesDetachedFinalization = !!detachedFinalizationPath && next.tombstoneCleanupFinalizationPath === detachedFinalizationPath &&
    (current.tombstoneCleanupFinalizationPath === undefined || current.tombstoneCleanupFinalizationPath === legacyFinalizationPath || current.tombstoneCleanupFinalizationPath === detachedFinalizationPath);
  const migratesLegacyFinalization = usesDetachedFinalization;
  const migratesLegacyFinalizationIdentity =
    migratesLegacyFinalization &&
    current.tombstoneCleanupFinalizationIdentity !== undefined &&
    next.tombstoneCleanupFinalizationIdentity !== undefined;
  const migratesLegacyCleanupPath = !!current.tombstoneCapturePath && !!detachedFinalizationPath && usesDetachedFinalization && current.tombstoneCleanupPath === path.join(current.tombstoneCapturePath, `entry.cleanup.${current.reservationNonce}`) && next.tombstoneCleanupPath === path.join(detachedFinalizationPath, `entry.cleanup.${current.reservationNonce}`);
  const migratesLegacyDetachedPath = !!current.tombstoneCapturePath && !!detachedFinalizationPath && usesDetachedFinalization && current.tombstoneCleanupDetachedPath === path.join(current.tombstoneCapturePath, `entry.cleanup.${current.reservationNonce}.deleting.${current.reservationNonce}`) && next.tombstoneCleanupDetachedPath === path.join(detachedFinalizationPath, `entry.cleanup.${current.reservationNonce}.deleting.${current.reservationNonce}`);
  const phases: Record<DetachedRemovalPublicReservationPhase, number> = {
    open: 0,
    cleaning: 1,
    republishing: 2,
    republished: 3,
  };
  const tombstoneStates: Record<NonNullable<DetachedRemovalPublicReservationRecord['tombstoneState']>, number> = {
    planned: 0,
    prepared: 1,
    moved: 2,
  };
  return (
    current.version === next.version &&
    current.detachedPath === next.detachedPath &&
    current.targetPath === next.targetPath &&
    current.reservationPath === next.reservationPath &&
    current.reservationNonce === next.reservationNonce &&
    (current.tombstoneNonce === undefined || current.tombstoneNonce === next.tombstoneNonce) &&
    (current.tombstonePath === undefined || current.tombstonePath === next.tombstonePath) &&
    (current.tombstoneMarkerPath === undefined || current.tombstoneMarkerPath === next.tombstoneMarkerPath) &&
    (current.tombstoneCapturePath === undefined || current.tombstoneCapturePath === next.tombstoneCapturePath) &&
    (current.tombstoneCaptureIdentity === undefined ||
      (next.tombstoneCaptureIdentity !== undefined &&
        isSameIdentity(current.tombstoneCaptureIdentity, next.tombstoneCaptureIdentity))) &&
    (current.tombstoneCaptureLinkReferent === undefined ||
      current.tombstoneCaptureLinkReferent === next.tombstoneCaptureLinkReferent) &&
    (current.tombstoneCaptureLinkType === undefined ||
      current.tombstoneCaptureLinkType === next.tombstoneCaptureLinkType) &&
    (current.tombstoneCaptureLinkIdentity === undefined ||
      (next.tombstoneCaptureLinkIdentity !== undefined &&
        isSameIdentity(current.tombstoneCaptureLinkIdentity, next.tombstoneCaptureLinkIdentity))) &&
    (current.tombstoneCapturedEntryIdentity === undefined ||
      (next.tombstoneCapturedEntryIdentity !== undefined &&
        isSameIdentity(current.tombstoneCapturedEntryIdentity, next.tombstoneCapturedEntryIdentity))) &&
    (current.tombstoneCapturedEntryLinkReferent === undefined ||
      current.tombstoneCapturedEntryLinkReferent === next.tombstoneCapturedEntryLinkReferent) &&
    (current.tombstoneCapturedEntryLinkType === undefined ||
      current.tombstoneCapturedEntryLinkType === next.tombstoneCapturedEntryLinkType) &&
    (current.tombstoneCleanupPath === undefined ||
      current.tombstoneCleanupPath === next.tombstoneCleanupPath ||
      migratesLegacyCleanupPath) &&
    (current.tombstoneCleanupIdentity === undefined ||
      (next.tombstoneCleanupIdentity !== undefined &&
        isSameIdentity(current.tombstoneCleanupIdentity, next.tombstoneCleanupIdentity))) &&
    (current.tombstoneCleanupDetachedPath === undefined ||
      current.tombstoneCleanupDetachedPath === next.tombstoneCleanupDetachedPath ||
      migratesLegacyDetachedPath) &&
    (current.tombstoneCleanupDetachedIdentity === undefined ||
      (next.tombstoneCleanupDetachedIdentity !== undefined &&
        isSameIdentity(
          current.tombstoneCleanupDetachedIdentity,
          next.tombstoneCleanupDetachedIdentity
        ))) &&
    (current.tombstoneCleanupFinalizationPath === undefined ||
      current.tombstoneCleanupFinalizationPath === next.tombstoneCleanupFinalizationPath ||
      migratesLegacyFinalization) &&
    (current.tombstoneCleanupFinalizationIdentity === undefined ||
      (next.tombstoneCleanupFinalizationIdentity !== undefined &&
        (isSameIdentity(current.tombstoneCleanupFinalizationIdentity, next.tombstoneCleanupFinalizationIdentity) ||
          migratesLegacyFinalizationIdentity))) &&
    (current.tombstoneIdentity === undefined ||
      (next.tombstoneIdentity !== undefined && isSameIdentity(current.tombstoneIdentity, next.tombstoneIdentity))) &&
    (current.tombstoneState === undefined ||
      (next.tombstoneState !== undefined &&
        tombstoneStates[next.tombstoneState] >= tombstoneStates[current.tombstoneState])) &&
    (current.reservationIdentity === undefined ||
      (next.reservationIdentity !== undefined &&
        isSameIdentity(current.reservationIdentity, next.reservationIdentity))) &&
    (current.publicLinkIdentity === undefined ||
      (next.publicLinkIdentity !== undefined &&
        isSameIdentity(current.publicLinkIdentity, next.publicLinkIdentity))) &&
    (current.publication === undefined
      ? true
      : next.publication !== undefined &&
        current.publication.stagingPath === next.publication.stagingPath &&
        current.publication.completionPath === next.publication.completionPath &&
        (current.publication.stagingIdentity === undefined ||
          (next.publication.stagingIdentity !== undefined &&
            (isSameIdentity(current.publication.stagingIdentity, next.publication.stagingIdentity) ||
              (getDetachedRemovalPublicReservationPhase(current) === 'republishing' &&
                getDetachedRemovalPublicReservationPhase(next) === 'republishing')))) &&
        (current.publication.finalIdentity === undefined ||
          (next.publication.finalIdentity !== undefined &&
            isSameIdentity(current.publication.finalIdentity, next.publication.finalIdentity)))) &&
    phases[getDetachedRemovalPublicReservationPhase(next)] >=
      phases[getDetachedRemovalPublicReservationPhase(current)]
  );
}

function isValidPublicationManifest(
  value: unknown,
  record: DetachedRemovalPublicReservationRecord
): value is DetachedRemovalPublicReservationPublicationManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !record.publication) return false;
  const manifest = value as Partial<DetachedRemovalPublicReservationPublicationManifest>;
  return (
    manifest.version === RESERVATION_RECORD_VERSION &&
    manifest.detachedPath === record.detachedPath &&
    manifest.targetPath === record.targetPath &&
    manifest.reservationPath === record.reservationPath &&
    manifest.stagingPath === record.publication.stagingPath &&
    isTrustworthyIdentity(manifest.stagingIdentity) &&
    record.publication.stagingIdentity !== undefined &&
    isSameIdentity(manifest.stagingIdentity, record.publication.stagingIdentity)
  );
}

/**
 * This record is adjacent to the deterministic detached path, not the public
 * name. It remains discoverable after the public symlink is unlinked and its
 * exact detached path binds it to one deletion transaction.
 */
export async function persistDetachedRemovalPublicReservationRecord(input: {
  readonly record: DetachedRemovalPublicReservationRecord;
  readonly parentDirectory: string;
  readonly syncParentDirectory: () => Promise<void>;
  /** Only monotonic transaction-state advancement may replace an existing record. */
  readonly allowPhaseAdvance?: boolean;
}): Promise<void> {
  const recordPath = getDetachedRemovalPublicReservationRecordPath(input.record.detachedPath);
  const expected = {
    targetPath: input.record.targetPath,
    detachedPath: input.record.detachedPath,
    parentDirectory: input.parentDirectory,
  };
  if (!isValidRecord(input.record, expected)) {
    throw new Error('Invalid detached removal public reservation record');
  }
  await withDurableReservationRecordLock(recordPath, async () => {
    const payload = `${JSON.stringify(input.record)}\n`;
    await cleanupInterruptedPublicReservationRecordTemps(input.record.detachedPath);

    // Validation and publication share one per-record critical section. A
    // writer paused after this read therefore cannot later replace a newer,
    // monotonic phase with its stale payload.
    const existing = await readDetachedRemovalPublicReservationRecord(expected);
    if (existing) {
      if (
        JSON.stringify(existing) !== JSON.stringify(input.record) &&
        (!input.allowPhaseAdvance || !canAdvanceRecord(existing, input.record))
      ) {
        throw new Error('Detached removal public reservation record changed');
      }
      if (JSON.stringify(existing) === JSON.stringify(input.record)) return;
    }

    const tempPath = path.join(
      path.dirname(recordPath),
      `${getDetachedRemovalPublicReservationRecordTempPrefix(input.record.detachedPath)}${randomUUID()}`
    );
    let handle: fs.promises.FileHandle | null = null;
    let published = false;
    let tempIdentity: DurablePathIdentity | null = null;
    try {
      handle = await fs.promises.open(tempPath, 'wx', 0o600);
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
      tempIdentity = getDurablePathIdentity(await handle.stat());
      await handle.close();
      handle = null;
      // The complete record becomes visible in one namespace transition. A
      // stopped writer can leave only the ignored temp sibling above, never a
      // syntactically partial final record.
      await fs.promises.rename(tempPath, recordPath);
      published = true;
      await input.syncParentDirectory();
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (!published && tempIdentity) {
        await unlinkDurablePathIfIdentityMatchesAsync(tempPath, tempIdentity).catch(() => undefined);
      }
      throw error;
    }
  });
}

export async function readDetachedRemovalPublicReservationRecord(input: {
  readonly targetPath: string;
  readonly detachedPath: string;
  readonly parentDirectory: string;
}): Promise<DetachedRemovalPublicReservationRecord | null> {
  for (const recordPath of getDetachedRemovalPublicReservationRecordPaths(input.detachedPath)) {
    let handle: fs.promises.FileHandle | null = null;
    try {
      handle = await fs.promises.open(
        recordPath,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
      );
      const stats = await handle.stat();
      if (!stats.isFile() || !isTrustworthyIdentity(getDurablePathIdentity(stats))) {
        throw new Error('Detached removal public reservation record is not a trusted regular file');
      }
      if (stats.size > MAX_RESERVATION_RECEIPT_BYTES) {
        throw new Error('Detached removal public reservation record exceeds the receipt limit');
      }
      const parsed = JSON.parse(
        await readBoundedFileHandleUtf8Async(handle, MAX_RESERVATION_RECEIPT_BYTES)
      ) as unknown;
      if (!isValidRecord(parsed, input)) {
        throw new Error('Detached removal public reservation record is invalid');
      }
      return parsed;
    } catch (error) {
      if (!isMissing(error)) throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  return null;
}

/**
 * The manifest is a no-clobber completion receipt for the private staging
 * directory.  A partial temp is never considered a completion proof.
 */
export async function persistDetachedRemovalPublicReservationPublicationManifest(input: {
  readonly record: DetachedRemovalPublicReservationRecord;
  readonly syncParentDirectory: () => Promise<void>;
}): Promise<void> {
  const publication = input.record.publication;
  if (!publication?.stagingIdentity || !publication.stagingPath || !publication.completionPath) {
    throw new Error('Publication staging identity must be durable before completion');
  }
  const manifest: DetachedRemovalPublicReservationPublicationManifest = {
    version: RESERVATION_RECORD_VERSION,
    detachedPath: input.record.detachedPath,
    targetPath: input.record.targetPath,
    reservationPath: input.record.reservationPath,
    stagingPath: publication.stagingPath,
    stagingIdentity: publication.stagingIdentity,
  };
  const existing = await readDetachedRemovalPublicReservationPublicationManifest(input.record);
  if (existing) return;
  const tempPath = `${publication.completionPath}.tmp.${randomUUID()}`;
  let handle: fs.promises.FileHandle | null = null;
  let tempIdentity: DurablePathIdentity | null = null;
  try {
    handle = await fs.promises.open(tempPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(manifest)}\n`, 'utf8');
    await handle.sync();
    tempIdentity = getDurablePathIdentity(await handle.stat());
    await handle.close();
    handle = null;
    try {
      // link is an atomic create: unlike rename it cannot replace a valid
      // receipt written by a concurrent/restarted owner.
      await fs.promises.link(tempPath, publication.completionPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const raced = await readDetachedRemovalPublicReservationPublicationManifest(input.record);
      if (!raced) throw new Error('Publication completion manifest was replaced');
    }
    await input.syncParentDirectory();
  } finally {
    await handle?.close().catch(() => undefined);
    if (tempIdentity) {
      await unlinkDurablePathIfIdentityMatchesAsync(tempPath, tempIdentity).catch(() => undefined);
    }
  }
}

export async function readDetachedRemovalPublicReservationPublicationManifest(
  record: DetachedRemovalPublicReservationRecord
): Promise<DetachedRemovalPublicReservationPublicationManifest | null> {
  const completionPath = record.publication?.completionPath;
  if (!completionPath) return null;
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(
      completionPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
    );
    const stats = await handle.stat();
    if (!stats.isFile() || !isTrustworthyIdentity(getDurablePathIdentity(stats))) {
      throw new Error('Publication completion manifest is not a trusted regular file');
    }
    if (stats.size > MAX_RESERVATION_RECEIPT_BYTES) {
      throw new Error('Publication completion manifest exceeds the receipt limit');
    }
    const parsed = JSON.parse(
      await readBoundedFileHandleUtf8Async(handle, MAX_RESERVATION_RECEIPT_BYTES)
    ) as unknown;
    if (!isValidPublicationManifest(parsed, record)) {
      throw new Error('Publication completion manifest is invalid');
    }
    return parsed;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
export async function removeDetachedRemovalPublicReservationRecord(input: {
  readonly detachedPath: string;
  readonly record: DetachedRemovalPublicReservationRecord;
  readonly parentDirectory: string;
  readonly syncParentDirectory: () => Promise<void>;
}): Promise<void> {
  await removeExactDurableRecord({
    recordPaths: getDetachedRemovalPublicReservationRecordPaths(input.detachedPath),
    expected: input.record,
    valid: (value) => isValidRecord(value, {
      targetPath: input.record.targetPath,
      detachedPath: input.detachedPath,
      parentDirectory: input.parentDirectory,
    }),
    syncParentDirectory: input.syncParentDirectory,
  });
}
/** Reconciles only the reservation recorded by this exact deletion transaction. */
export async function reconcileDetachedRemovalPublicReservation(input: {
  readonly targetPath: string;
  readonly record: DetachedRemovalPublicReservationRecord;
  readonly removeReservationLink: (
    reservationPath: string,
    reservationIdentity: DurablePathIdentity,
    publicLinkIdentity: DurablePathIdentity | undefined
  ) => Promise<boolean>;
  readonly settleReservation: (
    reservationPath: string,
    reservationIdentity: DurablePathIdentity
  ) => Promise<boolean>;
}): Promise<boolean> {
  let reservationStats: fs.Stats;
  try {
    reservationStats = await fs.promises.lstat(input.record.reservationPath);
  } catch (error) {
    if (!isMissing(error)) throw error;
    return true;
  }
  if (
    !reservationStats.isDirectory() ||
    reservationStats.isSymbolicLink() ||
    !isSameIdentity(getDurablePathIdentity(reservationStats), input.record.reservationIdentity)
  ) {
    return false;
  }
  let publicStats: fs.Stats;
  try {
    publicStats = await fs.promises.lstat(input.targetPath);
  } catch (error) {
    if (!isMissing(error)) throw error;
    return input.settleReservation(input.record.reservationPath, input.record.reservationIdentity);
  }
  if (
    !publicStats.isSymbolicLink() ||
    (input.record.publicLinkIdentity !== undefined &&
      !isSameIdentity(getDurablePathIdentity(publicStats), input.record.publicLinkIdentity))
  ) {
    return false;
  }
  const linkTarget = path.resolve(path.dirname(input.targetPath), await fs.promises.readlink(input.targetPath));
  if (linkTarget !== input.record.reservationPath) return false;
  if (
    !(await input.removeReservationLink(
      input.record.reservationPath,
      input.record.reservationIdentity,
      input.record.publicLinkIdentity
    ))
  ) {
    return false;
  }
  return input.settleReservation(input.record.reservationPath, input.record.reservationIdentity);
}

/**
 * Resumes a deterministic proof-backed removal. A target rename can report
 * ENOENT because another finalizer already published this detached artifact;
 * only durable absence after exact validation counts as deleted.
 */
export async function resumeDeterministicDetachedRemoval(
  options: DeterministicDetachedRemovalOptions
): Promise<AtomicPathRemovalResult> {
  let stats: fs.Stats;
  try {
    stats = await fs.promises.lstat(options.detachedPath);
  } catch (error) {
    if (isMissing(error)) return 'missing';
    throw error;
  }
  const identity = getDurablePathIdentity(stats);
  if (
    options.validateDetached &&
    !(await options.validateDetached(options.detachedPath, identity))
  ) {
    return 'changed';
  }
  await options.proofHooks.onDetachedValidated(options.detachedPath, identity);
  const removalAccess = await withIdentityStableDirectoryPathAsync(
    path.dirname(options.detachedPath),
    async (stableParentPath) => {
      const descriptorBoundPath = path.join(stableParentPath, path.basename(options.detachedPath));
      const current = await fs.promises.lstat(descriptorBoundPath).catch((error: unknown) => {
        if (isMissing(error)) return null;
        throw error;
      });
      if (!current || !isSameIdentity(getDurablePathIdentity(current), identity) || current.birthtimeMs !== identity.birthtimeMs) return false;
      return removeDurablePathExactAsync(
        descriptorBoundPath,
        identity,
        options.removalOptions.recursive === true,
        { onBeforeDestructiveMutation: options.proofHooks.onBeforeDestructiveMutation }
      );
    },
    { errorPath: options.detachedPath }
  );
  if (removalAccess.state !== 'opened' || !removalAccess.value) return 'changed';
  try {
    await fs.promises.lstat(options.detachedPath);
    return 'changed';
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await options.syncParentDirectory();
  await options.proofHooks.onRemovalDurable(options.detachedPath, identity);
  return 'deleted';
}
