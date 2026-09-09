import { lstat } from 'node:fs/promises';

import { parseHostedOwnerWalNative } from '../../../src/main/composition/hosted/hostedOwnerWalNativeValidator';

import { assertRootCurrent, procFdPath } from './anchors';
import { canonicalJson, exactRecord, sha256 } from './contracts';
import { openOwnerWalDiskFile } from './owner-wal-disk-files';

import type { RootAnchor } from './anchors';
import type { FilePin } from './contracts';
import type { NativeCaptureRecord, NativeCaptureShard } from './native-captures';
import type { OwnerWalImage, PreviousOwnerWalImage } from './owner-wal-images';

const MAX_IMAGE = 32 * 1024 * 1024;
const MAX_METADATA = 16 * 1024;
const HASH = /^[0-9a-f]{64}$/u;

/** Exact storage projection of Owner 224229b's BoundOwnerEmission. */
export type DiskOwnerEmission = Pick<NativeCaptureRecord,
  'stream' | 'producer' | 'activation' | 'operationNonce' | 'emissionNonce' | 'sequence' | 'lineSha256'
> & Readonly<{ descriptor: Readonly<{ fd: 9; device: string; inode: string }> }>;
export interface DiskOwnerWalReceipt {
  readonly stage: number;
  readonly bindingSha256: string;
  readonly emission: DiskOwnerEmission;
}
export interface DiskOwnerWalImages {
  readonly previous: PreviousOwnerWalImage;
  readonly next: OwnerWalImage;
  readonly emission: DiskOwnerEmission;
}
function check(value: unknown, code: string): asserts value {
  if (!value) throw new Error(`p3c_owner_wal_disk_${code}`);
}
const json = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value)}\n`);

/** Format/capture correlation only. Pins and receipt must be retained independently by the
 * supervisor, never discovered from .binding. Mode 0400 is checked, but is NOT proof that
 * writers were revoked, sync succeeded, or predecessor absence was authentically observed.
 * This deliberately cannot mint VerifiedOwnerPublication or invoke semantic verification. */
export async function readDiskOwnerWalImages(input: {
  readonly directory: RootAnchor;
  readonly files: readonly FilePin[];
  readonly receipt: DiskOwnerWalReceipt;
  readonly capture: NativeCaptureShard;
}): Promise<DiskOwnerWalImages> {
  check(input.files.length >= 4 && input.files.length <= 5 &&
    input.capture.parsed.records.length <= 4098, 'input-budget');
  // Snapshot selections before the first await. No metadata-selected filesystem paths.
  const directory = input.directory;
  const receipt = structuredClone(input.receipt);
  const pins = structuredClone(input.files);
  const capture = structuredClone(input.capture);
  exactRecord(receipt, ['stage', 'bindingSha256', 'emission'], 'owner_wal_receipt');
  check(Number.isSafeInteger(receipt.stage) && receipt.stage >= 1 && receipt.stage <= 4096 &&
    HASH.test(receipt.bindingSha256), 'receipt');
  const prefix = `stage-${receipt.stage}`;
  const allowed = ['owner-wal-images.reservation', `${prefix}.stage`, `${prefix}.binding`,
    `${prefix}.next`, `${prefix}.previous`];
  check(pins.length >= 4 && pins.length <= 5 &&
    new Set(pins.map(p => p.relativePath)).size === pins.length &&
    pins.every(p => allowed.includes(p.relativePath) && p.mode === 0o400 &&
      Number.isSafeInteger(p.size) && p.size >= 0 && p.size <= MAX_IMAGE), 'file-selection');
  const e = receipt.emission;
  exactRecord(e, ['stream', 'producer', 'activation', 'descriptor', 'operationNonce',
    'emissionNonce', 'sequence', 'lineSha256'], 'owner_wal_emission');
  const records = capture.parsed.records.filter(r => r.sequence === e.sequence);
  const record = records[0];
  const descriptor = capture.parsed.records[0]?.native.descriptor;
  check(capture.name === 'ownerWalTimelinePath' && records.length === 1 && record &&
    record.recordType === 'owner-wal-published' && e.stream === 'ownerWalTimeline' &&
    e.operationNonce !== null && e.descriptor.fd === 9 &&
    canonicalJson(e.descriptor) === canonicalJson(descriptor) &&
    canonicalJson(e.producer) === canonicalJson(record.producer) &&
    canonicalJson(e.activation) === canonicalJson(record.activation) &&
    e.operationNonce === record.operationNonce && e.emissionNonce === record.emissionNonce &&
    e.lineSha256 === record.lineSha256, 'capture-binding');
  const handles: Awaited<ReturnType<typeof openOwnerWalDiskFile>>[] = [];
  const read = async (name: string, maximum: number): Promise<Buffer> => {
    const pin = pins.find(p => p.relativePath === name);
    check(pin && pin.size <= maximum, 'missing-or-oversized-file');
    const file = await openOwnerWalDiskFile(directory, pin);
    handles.push(file);
    if (maximum === 0) {
      check(pin.size === 0 && pin.sha256 === sha256(Buffer.alloc(0)), 'reservation');
      await file.current();
      return Buffer.alloc(0);
    }
    return file.read(maximum);
  };
  try {
    await assertRootCurrent(directory);
    const directoryBefore = await directory.handle.stat({ bigint: true });
    await read('owner-wal-images.reservation', 0);
    const bytes = await read(`${prefix}.binding`, MAX_METADATA);
    check(sha256(bytes) === receipt.bindingSha256, 'binding-digest');
    const binding = exactRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      ['previous', 'next', 'emission'], 'owner_wal_binding');
    check(canonicalJson(binding.emission) === canonicalJson(e), 'binding-emission');
    const image = async (value: unknown, suffix: string): Promise<OwnerWalImage> => {
      const metadata = exactRecord(value, ['byteSize', 'sha256'], 'owner_wal_image');
      check(Number.isSafeInteger(metadata.byteSize) && (metadata.byteSize as number) >= 2 &&
        (metadata.byteSize as number) <= MAX_IMAGE && typeof metadata.sha256 === 'string' &&
        HASH.test(metadata.sha256), 'image-metadata');
      const data = await read(`${prefix}.${suffix}`, MAX_IMAGE);
      check(data.length === metadata.byteSize && sha256(data) === metadata.sha256, 'image-digest');
      return { byteSize: data.length, sha256: metadata.sha256, bytes: data };
    };
    const next = await image(binding.next, 'next');
    const p = exactRecord(binding.previous,
      (binding.previous as { kind?: unknown })?.kind === 'retained' ? ['kind', 'image'] : ['kind'],
      'owner_wal_previous');
    check(p.kind === 'absent' || p.kind === 'retained', 'predecessor-kind');
    const previous: PreviousOwnerWalImage = p.kind === 'retained'
      ? { kind: 'retained', image: await image(p.image, 'previous') } : { kind: 'absent' };
    if (previous.kind === 'absent') {
      check(pins.length === 4, 'absence-selection');
      try {
        await lstat(`${procFdPath(directory.handle)}/${prefix}.previous`);
        throw new Error('p3c_owner_wal_disk_absence-substitution');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const native = parseHostedOwnerWalNative(record.native);
    check(native.wal.byteSize === next.byteSize && native.wal.sha256 === next.sha256 &&
      native.stateDelta.nextStateSha256 === next.sha256 &&
      native.stateDelta.previousStateSha256 ===
        (previous.kind === 'retained' ? previous.image.sha256 : null), 'native-images');
    const metadata = {
      previous: previous.kind === 'retained'
        ? { kind: 'retained', image: { byteSize: previous.image.byteSize, sha256: previous.image.sha256 } }
        : { kind: 'absent' },
      next: { byteSize: next.byteSize, sha256: next.sha256 },
    };
    check(bytes.equals(json({ ...metadata, emission: binding.emission })), 'binding-shape');
    check((await read(`${prefix}.stage`, MAX_METADATA)).equals(json(metadata)), 'stage-substitution');
    // Recheck every path and descriptor after all reads, including the zero-byte reservation.
    for (const handle of handles) await handle.current();
    await assertRootCurrent(directory);
    const directoryAfter = await directory.handle.stat({ bigint: true });
    check(directoryBefore.mtimeNs === directoryAfter.mtimeNs &&
      directoryBefore.ctimeNs === directoryAfter.ctimeNs, 'directory-changed');
    return { previous, next, emission: e };
  } finally {
    await Promise.allSettled(handles.map(file => file.close()));
  }
}

/** One bounded generation, complete native publication coverage. This is still correlation,
 * not a replacement-process lineage or receipt-provenance admission. */
export async function readDiskOwnerWalGeneration(input: {
  readonly directory: RootAnchor;
  readonly files: readonly FilePin[];
  readonly receipts: readonly DiskOwnerWalReceipt[];
  readonly capture: NativeCaptureShard;
}): Promise<readonly DiskOwnerWalImages[]> {
  check(input.receipts.length > 0 && input.receipts.length <= 4096 &&
    input.files.length <= 1 + 4096 * 4, 'generation-budget');
  check(input.capture.parsed.records.length <= 4098, 'input-budget');
  const directory = input.directory;
  const receipts = structuredClone(input.receipts);
  const files = structuredClone(input.files);
  const capture = structuredClone(input.capture);
  check(new Set(files.map(p => p.relativePath)).size === files.length, 'duplicate-file');
  let total = 0;
  for (const pin of files) {
    check(Number.isSafeInteger(pin.size) && pin.size >= 0 && pin.size <= MAX_IMAGE, 'file-size');
    total += pin.size;
    check(total <= 256 * 1024 * 1024, 'generation-budget');
  }
  const records = capture.parsed.records.slice(1, -1);
  check(records.length === receipts.length, 'publication-coverage');
  const stages = new Set<number>();
  const nonces = new Set<string>();
  let sequence = 0;
  let stage = 0;
  const used = new Set(['owner-wal-images.reservation']);
  const images: DiskOwnerWalImages[] = [];
  for (const [index, receipt] of receipts.entries()) {
    check(receipt.stage > stage && !stages.has(receipt.stage) && !nonces.has(receipt.emission.emissionNonce) &&
      receipt.emission.sequence > sequence &&
      receipt.emission.sequence === records[index]?.sequence, 'publication-replay');
    stages.add(receipt.stage);
    stage = receipt.stage;
    nonces.add(receipt.emission.emissionNonce);
    sequence = receipt.emission.sequence;
    const selected = files.filter(p => p.relativePath === 'owner-wal-images.reservation' ||
      p.relativePath.startsWith(`stage-${receipt.stage}.`));
    selected.forEach(p => used.add(p.relativePath));
    images.push(await readDiskOwnerWalImages({ directory, files: selected, receipt, capture }));
  }
  check(used.size === files.length, 'unselected-file');
  return images;
}
