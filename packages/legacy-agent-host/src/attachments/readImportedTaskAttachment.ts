import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { TeamOwnerError } from '../team/contracts.js';
import { digest, safeSegment } from '../team/identity.js';
import { readImportBytes, safeImportPath } from '../stopped-team-import/snapshot.js';
import {
  ATTACHMENT_CHUNK_BYTES,
  ATTACHMENT_MAX_BYTES,
  attachmentMetadataSchema,
  taskAttachmentReadSchema,
  messageAttachmentReadSchema,
  messageAttachmentsReadSchema,
} from './contracts.js';
import { importedMessageReference } from './importedMessageReference.js';
import type {
  AttachmentMetadata,
  AttachmentReadResult,
  ImportedAttachmentResult,
} from './contracts.js';

export interface ImportedAttachmentFile {
  path: string;
  sha256: string;
  base64: string;
}
export interface ImportedTaskAttachmentAuthority {
  root: string;
  teamName: string;
  /** Current Task read under the same current principal's Team authority fence. */
  task: unknown;
  /** Immutable original publication plan, selected privately by exact imported Team binding. */
  files: readonly ImportedAttachmentFile[];
  gaps: readonly { resourceId: string; reason: string }[];
  /** Must include original lease/current actor authority; called before and after IO. */
  assertCurrent(): void;
}
const hold = (): never => {
  throw new TeamOwnerError('hold');
};
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return hold();
  return value as Record<string, unknown>;
}
function entries(value: unknown): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4096) return hold();
  return value.map(row);
}
function attachments(task: Record<string, unknown>, attachmentId: string) {
  const found = [
    ...entries(task.attachments),
    ...entries(task.comments).flatMap((comment) => entries(comment.attachments)),
  ].filter((item) => item.id === attachmentId);
  if (found.length > 1) return hold();
  return found[0];
}
function metadata(value: Record<string, unknown>): AttachmentMetadata {
  try {
    return attachmentMetadataSchema.parse(
      Object.fromEntries(
        ['id', 'filename', 'mimeType', 'size', 'addedAt']
          .filter((key) => value[key] !== undefined)
          .map((key) => [key, value[key]])
      )
    );
  } catch {
    return hold();
  }
}
function originalFile(
  files: readonly ImportedAttachmentFile[],
  path: string
): ImportedAttachmentFile {
  const found = files.filter((file) => file.path === path);
  if (found.length !== 1) return hold();
  const file = found[0]!;
  if (
    !/^[a-f0-9]{64}$/.test(file.sha256) ||
    typeof file.base64 !== 'string' ||
    file.base64.length > Math.ceil(ATTACHMENT_MAX_BYTES / 3) * 4
  )
    return hold();
  const bytes = Buffer.from(file.base64, 'base64');
  if (bytes.toString('base64') !== file.base64 || sha(bytes) !== file.sha256) return hold();
  return file;
}

/** Read-only. Caller must keep the exact Team's read authority fence for this synchronous call.
 * Renderer IDs never select a path; current metadata must match the immutable original Task map. */
export function readImportedTaskAttachment(
  authority: ImportedTaskAttachmentAuthority,
  raw: unknown
): AttachmentReadResult {
  const input = taskAttachmentReadSchema.parse(raw);
  authority.assertCurrent();
  if (authority.files.length > 8192 || authority.gaps.length > 4096) return hold();
  const team = safeSegment(authority.teamName);
  if (!isAbsolute(authority.root) || resolve(authority.root) !== authority.root) return hold();
  const current = row(authority.task);
  if (current.id !== input.taskId) return hold();
  const selected = attachments(current, input.attachmentId);
  if (!selected) return null;
  const taskFile = originalFile(authority.files, `tasks/${team}/${input.taskId}.json`);
  let original: Record<string, unknown>;
  try {
    original = row(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(taskFile.base64, 'base64'))
      )
    );
  } catch {
    return hold();
  }
  if (original.id !== input.taskId) return hold();
  const retained = attachments(original, input.attachmentId);
  if (!retained) return hold();
  return readImportedAttachmentBytes(authority, input, selected, retained);
}

function readImportedAttachmentBytes(
  authority: ImportedTaskAttachmentAuthority,
  input: { attachmentId: string; offset: number; expectedSha256?: string | undefined },
  selected: Record<string, unknown>,
  retained: Record<string, unknown>
): AttachmentReadResult {
  const team = safeSegment(authority.teamName);
  if (!isAbsolute(authority.root) || resolve(authority.root) !== authority.root) return hold();
  const publicMetadata = metadata(selected);
  if (
    digest(publicMetadata) !== digest(metadata(retained)) ||
    selected.filePath !== retained.filePath
  )
    return hold();
  if (retained.filePath === undefined || retained.filePath === null) {
    if (input.expectedSha256 !== undefined) return hold();
    if (
      !authority.gaps.some(
        (gap) =>
          gap.resourceId === `attachment:${input.attachmentId}` && gap.reason === 'metadata-only'
      )
    )
      return hold();
    authority.assertCurrent();
    return null;
  }
  if (
    typeof retained.filePath !== 'string' ||
    !isAbsolute(retained.filePath) ||
    resolve(retained.filePath) !== retained.filePath
  )
    return hold();
  const path = safeImportPath(relative(authority.root, retained.filePath));
  const prefix = `teams/${team}/.host-owner/import/blobs/`;
  if (
    !path.startsWith(prefix) ||
    !/^(attachments|task-attachments)\//.test(path.slice(prefix.length))
  )
    return hold();
  const file = originalFile(authority.files, path);
  const bytes = readImportBytes(join(authority.root, path), ATTACHMENT_MAX_BYTES);
  if (
    bytes.length !== publicMetadata.size ||
    sha(bytes) !== file.sha256 ||
    (input.expectedSha256 !== undefined && input.expectedSha256 !== file.sha256) ||
    input.offset > bytes.length ||
    (input.offset !== 0 && input.offset % ATTACHMENT_CHUNK_BYTES !== 0)
  )
    return hold();
  authority.assertCurrent();
  const end = Math.min(bytes.length, input.offset + ATTACHMENT_CHUNK_BYTES);
  return {
    attachment: publicMetadata,
    sha256: file.sha256,
    offset: input.offset,
    base64: bytes.subarray(input.offset, end).toString('base64'),
    nextOffset: end < bytes.length ? end : null,
  };
}

/** No message search: the opaque reference contains the exact Task selection. */
export function readImportedMessageAttachment(
  authority: ImportedTaskAttachmentAuthority,
  raw: unknown,
  list: boolean
): ImportedAttachmentResult {
  const input = list
    ? messageAttachmentsReadSchema.parse(raw)
    : messageAttachmentReadSchema.parse(raw);
  authority.assertCurrent();
  if (authority.files.length > 8192 || authority.gaps.length > 4096) return hold();
  const current = row(authority.task);
  if (
    typeof current.id !== 'string' ||
    typeof current.sourceMessageId !== 'string' ||
    importedMessageReference(authority.teamName, current.id, current.sourceMessageId) !==
      input.reference
  )
    return hold();
  const file = originalFile(
    authority.files,
    `tasks/${safeSegment(authority.teamName)}/${safeSegment(current.id)}.json`
  );
  let original: Record<string, unknown>;
  try {
    original = row(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(file.base64, 'base64'))
      )
    );
  } catch {
    return hold();
  }
  if (
    original.id !== current.id ||
    original.sourceMessageId !== current.sourceMessageId ||
    digest(original.sourceMessage) !== digest(current.sourceMessage)
  )
    return hold();
  const retained = entries(row(original.sourceMessage).attachments);
  if (retained.length > 64 || new Set(retained.map((item) => item.id)).size !== retained.length)
    return hold();
  const result = retained.map(metadata);
  if (result.reduce((size, item) => size + item.size, 0) > ATTACHMENT_MAX_BYTES) return hold();
  authority.assertCurrent();
  if (list) return result;
  const chunk = messageAttachmentReadSchema.parse(raw);
  const selected = retained.find((item) => item.id === chunk.attachmentId);
  if (!selected) return null;
  return readImportedAttachmentBytes(authority, chunk, selected, selected);
}
