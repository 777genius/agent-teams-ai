import { chmod, link, mkdtemp, open, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { descriptorMountId, openRootAnchor } from '../../../../scripts/e2e/hosted-actual-owner/anchors';
import { parseNativeRuntimeCapture } from '../../../../scripts/e2e/hosted-actual-owner/native-captures';
import { openOwnerWalDiskFile } from '../../../../scripts/e2e/hosted-actual-owner/owner-wal-disk-files';
import { readDiskOwnerWalGeneration, readDiskOwnerWalImages } from '../../../../scripts/e2e/hosted-actual-owner/owner-wal-disk-images';
import { admission, digest, emptyState, image, jsonImage, pair } from './owner-wal-images.fixtures';
import { controllerNonce, hex, nativeCapture, runId } from './raw-http.fixtures';

import type { FilePin } from '../../../../scripts/e2e/hosted-actual-owner/contracts';
import type { NativeCaptureShard } from '../../../../scripts/e2e/hosted-actual-owner/native-captures';
import type { DiskOwnerEmission } from '../../../../scripts/e2e/hosted-actual-owner/owner-wal-disk-images';

async function fixture(retained = false) {
  const path = await mkdtemp(join(tmpdir(), 'r1006-wal-'));
  await chmod(path, 0o700);
  const directory = await open(path);
  const s = await directory.stat({ bigint: true });
  const mountId = await descriptorMountId(directory);
  await directory.close();
  const root = await openRootAnchor('evidenceRoot', {
    path, device: String(s.dev), inode: String(s.ino), mountId, mode: 0o700,
  });
  const state = emptyState();
  const previous = Buffer.from(`${JSON.stringify(state, null, 2)}\r\n`);
  if (retained) state.revision++;
  const next = jsonImage(state);
  const semantic = pair(retained ? image(previous) : null, state, { kind: 'admission-reconciled', outcome: 'published' }, admission(state));
  const native = nativeCapture('ownerWalTimelinePath', [{
    recordType: 'owner-wal-published', operationNonce: hex(999), native: { ...semantic.native },
  }]);
  const parsed = parseNativeRuntimeCapture('ownerWalTimelinePath', native.bytes, controllerNonce, runId);
  const capture: NativeCaptureShard = { name: 'ownerWalTimelinePath', shardIndex: 0,
    captureSha256: digest(native.bytes), producerStartToken: native.shard.producerStartToken, parsed };
  const record = parsed.records[1]!;
  const emission: DiskOwnerEmission = {
    stream: record.stream, producer: record.producer, activation: record.activation,
    descriptor: parsed.records[0]!.native.descriptor as DiskOwnerEmission['descriptor'],
    operationNonce: record.operationNonce, emissionNonce: record.emissionNonce,
    sequence: record.sequence, lineSha256: record.lineSha256,
  };
  const metadata = {
    previous: retained ? { kind: 'retained', image: { byteSize: previous.length, sha256: digest(previous) } } : { kind: 'absent' },
    next: { byteSize: next.byteSize, sha256: next.sha256 },
  };
  const binding = Buffer.from(`${JSON.stringify({ ...metadata, emission })}\n`);
  const contents: Record<string, Buffer> = {
    'owner-wal-images.reservation': Buffer.alloc(0),
    'stage-1.stage': Buffer.from(`${JSON.stringify(metadata)}\n`),
    'stage-1.binding': binding,
    'stage-1.next': Buffer.from(next.bytes),
    ...(retained ? { 'stage-1.previous': previous } : {}),
  };
  const files: FilePin[] = [];
  for (const [name, bytes] of Object.entries(contents)) {
    await writeFile(join(path, name), bytes, { mode: 0o400 });
    const file = await stat(join(path, name), { bigint: true });
    files.push({ root: 'evidenceRoot', relativePath: name, size: bytes.length, sha256: digest(bytes),
      device: String(file.dev), inode: String(file.ino), mode: 0o400, nlink: 1 });
  }
  return { path, previous, next, input: { directory: root, files, capture,
    receipt: { stage: 1, bindingSha256: digest(binding), emission } },
  close: async () => { await root.handle.close(); await rm(path, { recursive: true, force: true }); } };
}

describe.skipIf(process.platform !== 'linux')('retained Owner disk format (not admission)', () => {
  it.each([false, true])('preserves exact bytes and explicit absence, retained=%s', async retained => {
    const f = await fixture(retained);
    try {
      const loaded = await readDiskOwnerWalImages(f.input);
      expect(loaded.next.bytes).toEqual(f.next.bytes);
      expect(loaded.previous).toEqual(retained
        ? { kind: 'retained', image: { byteSize: f.previous.length, sha256: digest(f.previous), bytes: f.previous } }
        : { kind: 'absent' });
      expect(loaded).not.toHaveProperty('custodyVerified');
    } finally { await f.close(); }
  });
  it.each(['truncate', 'symlink', 'missing', 'writable', 'corrupt', 'hardlink', 'replacement'])('rejects %s real files', async attack => {
    const f = await fixture(true);
    try {
      const path = join(f.path, 'stage-1.previous');
      if (attack === 'symlink' || attack === 'missing') await unlink(path);
      if (attack === 'symlink') await symlink('stage-1.next', path);
      if (attack === 'hardlink') await link(path, join(f.path, 'alias'));
      if (attack === 'replacement') {
        await rename(path, join(f.path, 'old'));
        await writeFile(path, f.previous, { mode: 0o400 });
      }
      if (attack === 'writable') await chmod(path, 0o600);
      if (attack === 'truncate' || attack === 'corrupt') {
        await chmod(path, 0o600);
        await writeFile(path, attack === 'truncate' ? Buffer.alloc(1) : Buffer.alloc(f.previous.length));
        await chmod(path, 0o400);
      }
      await expect(readDiskOwnerWalImages(f.input)).rejects.toThrow();
    } finally { await f.close(); }
  });
  it('does not turn a present predecessor into absence', async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.path, 'stage-1.previous'), '{}', { mode: 0o400 });
      await expect(readDiskOwnerWalImages(f.input)).rejects.toThrow('absence-substitution');
    } finally { await f.close(); }
  });
  it.each(['lineSha256', 'operationNonce', 'emissionNonce'] as const)('rejects substituted %s', async field => {
    const f = await fixture();
    try {
      f.input.receipt.emission = { ...f.input.receipt.emission, [field]: hex(12345) };
      await expect(readDiskOwnerWalImages(f.input)).rejects.toThrow('capture-binding');
    } finally { await f.close(); }
  });
  it.each(['producer', 'activation', 'descriptor'] as const)('rejects cross-generation %s', async field => {
    const f = await fixture();
    try {
      const e = f.input.receipt.emission;
      f.input.receipt.emission = { ...e,
        ...(field === 'producer' ? { producer: { ...e.producer, startTicks: '99999' } } : {}),
        ...(field === 'activation' ? { activation: { ...e.activation, runId: 'foreign-run' } } : {}),
        ...(field === 'descriptor' ? { descriptor: { ...e.descriptor, inode: '99999' } } : {}),
      };
      await expect(readDiskOwnerWalImages(f.input)).rejects.toThrow('capture-binding');
    } finally { await f.close(); }
  });
  it('detects replacement after acquiring a pinned descriptor', async () => {
    const f = await fixture();
    const pin = f.input.files.find(file => file.relativePath === 'stage-1.next')!;
    const file = await openOwnerWalDiskFile(f.input.directory, pin);
    try {
      await rename(join(f.path, pin.relativePath), join(f.path, 'old-next'));
      await writeFile(join(f.path, pin.relativePath), f.next.bytes, { mode: 0o400 });
      await expect(file.read(32 * 1024 * 1024)).rejects.toThrow('file-changed');
    } finally { await file.close(); await f.close(); }
  });
  it('owns the selected file pin across awaits and rejects invalid read bounds', async () => {
    const f = await fixture();
    const selected = { ...f.input.files.find(file => file.relativePath === 'stage-1.next')! };
    const file = await openOwnerWalDiskFile(f.input.directory, selected);
    try {
      selected.relativePath = 'stage-1.binding';
      selected.size = 1;
      selected.sha256 = hex(12345);
      expect(await file.read(32 * 1024 * 1024)).toEqual(f.next.bytes);
      for (const maximum of [NaN, Infinity, -1, 0, 32 * 1024 * 1024 + 1]) {
        await expect(file.read(maximum)).rejects.toThrow('file-size');
      }
    } finally { await file.close(); await f.close(); }
  });
  it('requires complete one-use publication coverage', async () => {
    const f = await fixture();
    try {
      const input = { ...f.input, receipts: [f.input.receipt] };
      expect(await readDiskOwnerWalGeneration(input)).toHaveLength(1);
      await expect(readDiskOwnerWalGeneration({ ...input, receipts: [f.input.receipt, f.input.receipt] })).rejects.toThrow();
      await expect(readDiskOwnerWalGeneration({ ...input, files: [...input.files, input.files[0]!] })).rejects.toThrow('duplicate-file');
    } finally { await f.close(); }
  });
});
