import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { atomicWriteSync } from '../adapters/lifecycle/atomicWriteSync.js';
import { TeamOwnerError } from '../team/contracts.js';
import { digest } from '../team/identity.js';
import { ATTACHMENT_CHUNK_BYTES, attachmentMetadataSchema } from './contracts.js';
import type { AttachmentMetadata, AttachmentReadResult } from './contracts.js';
import {
  attachmentReferenceSchema,
  attachmentReferencesSchema,
  attachmentUploadSchema,
} from './uploadContracts.js';
import type {
  AttachmentReference,
  AttachmentUpload,
  AttachmentUploadResult,
} from './uploadContracts.js';
import {
  MAX_AGENT_IPC_ATTACHMENTS,
  MAX_TOTAL_ATTACHMENT_SIZE,
  MAX_TASK_ATTACHMENT_BYTES_TOTAL,
  validateAgentAttachmentIpcPayload,
} from './portable.js';
import { resolveAgentAttachmentArtifactPath } from './storage.js';
import type { TeamBinding } from '../team/contracts.js';
import type { TeamStore } from '../team/ports.js';

interface Manifest {
  schemaVersion: 1;
  binding: TeamBinding;
  uploadId: string;
  purpose: AttachmentUpload['purpose'];
  reference: AttachmentReference;
  attachment: AttachmentMetadata;
  nextOffset: number;
  completed: boolean;
}
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const fail = (): never => {
  throw new TeamOwnerError('hold');
};
/** Existing agent-attachments storage, selected by a Team root; no ambient appData or native paths on wire. */
export class AttachmentArtifactStore {
  constructor(
    readonly root: string,
    readonly binding: TeamBinding,
    private readonly store: TeamStore
  ) {}
  private manifest(reference: AttachmentReference): Manifest {
    attachmentReferenceSchema.parse(reference);
    const manifest = this.store.read<Manifest>(`attachments/${reference.artifactId}.json`);
    if (
      !manifest ||
      manifest.schemaVersion !== 1 ||
      digest(manifest.binding) !== digest(this.binding) ||
      digest(manifest.reference) !== digest(reference)
    )
      return fail();
    attachmentMetadataSchema.parse(manifest.attachment);
    attachmentUploadSchema.shape.purpose.parse(manifest.purpose);
    if (
      digest([manifest.uploadId, manifest.attachment.id]) !== reference.artifactId ||
      manifest.attachment.size !== reference.byteLength ||
      manifest.attachment.mimeType !== reference.mimeType ||
      !Number.isSafeInteger(manifest.nextOffset) ||
      manifest.nextOffset < 0 ||
      manifest.nextOffset > reference.byteLength ||
      typeof manifest.completed !== 'boolean'
    )
      return fail();
    return manifest;
  }
  private path(manifest: Manifest, create = false): string {
    const target = resolveAgentAttachmentArtifactPath({
      appDataPath: join(this.root, 'appData'),
      teamName: this.binding.teamName,
      messageId: manifest.uploadId,
      attachmentId: manifest.reference.artifactId,
      fileName: 'payload',
    });
    // Every ancestor belongs to the explicit owner namespace; never follow a substituted symlink.
    let part = parse(target).root;
    for (const segment of dirname(target).slice(part.length).split('/')) {
      part = join(part, segment);
      try {
        const stat = lstatSync(part);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return fail();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (!create) return fail();
        mkdirSync(part);
      }
    }
    if (resolve(target) !== target || realpathSync(dirname(target)) !== dirname(target))
      return fail();
    return target;
  }
  private bytes(manifest: Manifest): { bytes: Buffer; path: string } {
    if (!manifest.completed) return fail();
    const path = this.path(manifest);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== manifest.reference.byteLength)
        return fail();
      const bytes = readFileSync(fd);
      if (bytes.length !== stat.size || sha(bytes) !== manifest.reference.digest) return fail();
      return { bytes, path };
    } finally {
      closeSync(fd);
    }
  }
  upload(raw: unknown): AttachmentUploadResult {
    const input = attachmentUploadSchema.parse(raw);
    if (
      input.attachment.filename !== input.attachment.filename.trim() ||
      input.attachment.mimeType !== input.attachment.mimeType.trim()
    )
      throw new TeamOwnerError('invalid');
    const bytes = Buffer.from(input.base64, 'base64');
    if (
      bytes.toString('base64') !== input.base64 ||
      bytes.length !== Math.min(ATTACHMENT_CHUNK_BYTES, input.attachment.size - input.offset) ||
      !bytes.length ||
      input.offset % ATTACHMENT_CHUNK_BYTES
    )
      throw new TeamOwnerError('invalid');
    const artifactId = digest([input.uploadId, input.attachment.id]);
    const reference = {
      artifactId,
      mimeType: input.attachment.mimeType,
      byteLength: input.attachment.size,
      digest: input.digest,
    };
    const key = `attachments/${artifactId}.json`,
      prior = this.store.read<Manifest>(key);
    if (
      prior &&
      (digest(prior.binding) !== digest(this.binding) ||
        digest(prior.reference) !== digest(reference) ||
        digest(prior.purpose) !== digest(input.purpose) ||
        digest({ ...prior.attachment, addedAt: undefined }) !== digest(input.attachment))
    )
      throw new TeamOwnerError('conflict');
    if (prior) this.manifest(reference);
    const manifest: Manifest = prior ?? {
      schemaVersion: 1,
      binding: this.binding,
      uploadId: input.uploadId,
      purpose: input.purpose,
      reference,
      attachment: { ...input.attachment, addedAt: new Date().toISOString() },
      nextOffset: 0,
      completed: false,
    };
    if (!prior) {
      const batch = this.store
        .list<Manifest>('attachments')
        .filter((row) => row.uploadId === input.uploadId);
      if (
        batch.length >= MAX_AGENT_IPC_ATTACHMENTS ||
        batch.some((row) => digest(row.purpose) !== digest(input.purpose)) ||
        batch.reduce((sum, row) => sum + row.reference.byteLength, input.attachment.size) >
          (input.purpose.kind === 'task'
            ? MAX_TASK_ATTACHMENT_BYTES_TOTAL
            : MAX_TOTAL_ATTACHMENT_SIZE)
      )
        throw new TeamOwnerError('invalid');
      this.store.write(key, manifest);
    }
    const chunkKey = `attachment-chunks/${artifactId}/${input.offset}.json`;
    const chunk = this.store.read<{ base64: string }>(chunkKey);
    if (chunk && chunk.base64 !== input.base64) throw new TeamOwnerError('conflict');
    if (input.offset > manifest.nextOffset || (input.offset < manifest.nextOffset && !chunk))
      throw new TeamOwnerError('conflict');
    if (!chunk) this.store.write(chunkKey, { base64: input.base64 });
    if (input.offset === manifest.nextOffset) {
      manifest.nextOffset += bytes.length;
      this.store.write(key, manifest);
    }
    if (manifest.nextOffset === reference.byteLength && !manifest.completed) {
      const parts: Buffer[] = [];
      for (let offset = 0; offset < reference.byteLength; offset += ATTACHMENT_CHUNK_BYTES) {
        const saved = this.store.read<{ base64: string }>(
          `attachment-chunks/${artifactId}/${offset}.json`
        );
        if (!saved) return fail();
        parts.push(Buffer.from(saved.base64, 'base64'));
      }
      const complete = Buffer.concat(parts);
      if (complete.length !== reference.byteLength || sha(complete) !== reference.digest)
        throw new TeamOwnerError('invalid');
      // Run the same UI normalizer at the owner boundary, with actual decoded size.
      const normalized = validateAgentAttachmentIpcPayload(
        [{ ...input.attachment, data: complete.toString('base64') }],
        input.purpose.kind
      );
      // Comment storage supports arbitrary existing file MIME types; native delivery remains capability gated.
      if (!normalized.valid) throw new TeamOwnerError('invalid');
      const path = this.path(manifest, true);
      try {
        const before = lstatSync(path);
        if (
          before.isSymbolicLink() ||
          !before.isFile() ||
          sha(readFileSync(path)) !== reference.digest
        )
          return fail();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        atomicWriteSync(path, complete, { mode: 0o600 });
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        const dir = openSync(dirname(path), constants.O_RDONLY);
        try {
          fsyncSync(dir);
        } finally {
          closeSync(dir);
        }
      }
      manifest.completed = true;
      this.store.write(key, manifest);
    }
    if (manifest.completed) {
      this.bytes(manifest);
      return { nextOffset: null, reference };
    }
    return { nextOffset: manifest.nextOffset };
  }
  metadata(
    refs: readonly AttachmentReference[],
    purpose?: AttachmentUpload['purpose']
  ): AttachmentMetadata[] {
    attachmentReferencesSchema.parse(refs);
    const result = refs.map((ref) => {
      const manifest = this.manifest(ref);
      if (purpose && digest(manifest.purpose) !== digest(purpose))
        throw new TeamOwnerError('forbidden');
      this.bytes(manifest);
      return { ...manifest.attachment, artifactId: ref.artifactId, filePath: this.path(manifest) };
    });
    if (purpose) {
      const batch = validateAgentAttachmentIpcPayload(
        refs.map((ref, index) => ({
          ...result[index],
          data: this.bytes(this.manifest(ref)).bytes.toString('base64'),
        })),
        purpose.kind
      );
      if (!batch.valid) throw new TeamOwnerError('invalid');
    }
    return result;
  }
  read(metadata: unknown, id: string, offset: number, expected?: string): AttachmentReadResult {
    if (!Array.isArray(metadata)) return null;
    const matches = metadata.filter(
      (row: unknown) => !!row && typeof row === 'object' && (row as AttachmentMetadata).id === id
    ) as (AttachmentMetadata & { artifactId?: string })[];
    if (matches.length > 1) return fail();
    const selected = matches[0];
    if (!selected?.artifactId) return null;
    const manifest = this.store.read<Manifest>(`attachments/${selected.artifactId}.json`);
    if (!manifest) return null;
    const owned = this.manifest(manifest.reference);
    if (
      digest(selected) !==
        digest({
          ...owned.attachment,
          artifactId: owned.reference.artifactId,
          filePath: this.path(owned),
        }) ||
      (expected && expected !== owned.reference.digest)
    )
      return fail();
    const { bytes } = this.bytes(owned);
    if (offset > bytes.length) throw new TeamOwnerError('invalid');
    const end = Math.min(bytes.length, offset + ATTACHMENT_CHUNK_BYTES);
    return {
      attachment: owned.attachment,
      sha256: owned.reference.digest,
      offset,
      base64: bytes.subarray(offset, end).toString('base64'),
      nextOffset: end < bytes.length ? end : null,
    };
  }
  resolve(reference: AttachmentReference): { bytes: Uint8Array; nativePath: string } {
    const value = this.bytes(this.manifest(reference));
    return { bytes: value.bytes, nativePath: value.path };
  }
}
