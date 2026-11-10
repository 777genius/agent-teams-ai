// @vitest-environment node
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ATTACHMENT_CHUNK_BYTES,
  ATTACHMENT_MAX_BYTES,
} from '../../../packages/legacy-agent-host/dist/attachments/contracts.js';
import { readImportedTaskAttachment } from '../../../packages/legacy-agent-host/dist/attachments/readImportedTaskAttachment.js';

import type {
  ImportedAttachmentFile,
  ImportedTaskAttachmentAuthority,
} from '../../../packages/legacy-agent-host/dist/attachments/readImportedTaskAttachment.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fixture(bytes = Buffer.from('TEST-imported-attachment')) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-import-attachment-')));
  roots.push(root);
  const blob =
    'teams/TEST-team/.host-owner/import/blobs/task-attachments/TEST-task/TEST-image--image.png';
  mkdirSync(dirname(join(root, blob)), { recursive: true });
  writeFileSync(join(root, blob), bytes);
  const attachment = {
    id: 'TEST-image',
    filename: 'image.png',
    mimeType: 'image/png',
    size: bytes.length,
    filePath: join(root, blob),
  };
  const task = {
    id: 'TEST-task',
    subject: 'TEST attachment task',
    status: 'pending',
    attachments: [attachment],
    comments: [] as { id: string; attachments: (typeof attachment)[] }[],
  };
  const file = (path: string, bytes: Buffer): ImportedAttachmentFile => ({
    path,
    base64: bytes.toString('base64'),
    sha256: sha(bytes),
  });
  const files = [
    file('tasks/TEST-team/TEST-task.json', Buffer.from(JSON.stringify(task))),
    file(blob, bytes),
  ];
  const authority: ImportedTaskAttachmentAuthority = {
    root,
    teamName: 'TEST-team',
    task,
    files,
    gaps: [],
    assertCurrent: () => {},
  };
  return {
    root,
    blob,
    attachment,
    task,
    files,
    authority,
    bytes,
    file,
    input: { taskId: 'TEST-task', attachmentId: 'TEST-image', offset: 0 },
  };
}
describe('owner-qualified immutable imported task/comment blob reads', () => {
  it('returns exact bounded chunks with public metadata only and a digest bound to every continuation', () => {
    const f = fixture(Buffer.alloc(ATTACHMENT_CHUNK_BYTES + 17, 42));
    const before = readFileSync(join(f.root, f.blob));
    const first = readImportedTaskAttachment(f.authority, f.input)!;
    expect(Buffer.from(first.base64, 'base64')).toEqual(
      f.bytes.subarray(0, ATTACHMENT_CHUNK_BYTES)
    );
    expect(first.nextOffset).toBe(ATTACHMENT_CHUNK_BYTES);
    expect(first.attachment).not.toHaveProperty('filePath');
    const last = readImportedTaskAttachment(f.authority, {
      ...f.input,
      offset: first.nextOffset,
      expectedSha256: first.sha256,
    })!;
    expect(last.nextOffset).toBeNull();
    expect(Buffer.from(first.base64 + last.base64, 'base64')).toEqual(f.bytes);
    expect(JSON.stringify(first).length).toBeLessThan(1024 * 1024);
    expect(readFileSync(join(f.root, f.blob))).toEqual(before);
  });
  it('finds comments through their immutable task map and rejects conflicting duplicate attachment IDs', () => {
    const f = fixture();
    f.task.attachments = [];
    f.task.comments = [{ id: 'TEST-comment', attachments: [f.attachment] }];
    f.files[0] = f.file(f.files[0]!.path, Buffer.from(JSON.stringify(f.task)));
    expect(readImportedTaskAttachment(f.authority, f.input)?.base64).toBe(
      f.bytes.toString('base64')
    );
    f.task.attachments = [f.attachment];
    expect(() => readImportedTaskAttachment(f.authority, f.input)).toThrow('hold');
  });
  it('never follows renderer paths/traversal or an attachment pointer into another Team/ambient root', () => {
    const f = fixture();
    for (const input of [
      { ...f.input, path: join(f.root, f.blob) },
      { ...f.input, taskId: '../TEST-task' },
      { ...f.input, attachmentId: '../TEST-image' },
      { ...f.input, offset: 1, expectedSha256: sha(f.bytes) },
      { ...f.input, offset: ATTACHMENT_CHUNK_BYTES },
      { ...f.input, offset: ATTACHMENT_MAX_BYTES + 1 },
    ])
      expect(() => readImportedTaskAttachment(f.authority, input)).toThrow();
    f.attachment.filePath = join(
      f.root,
      'teams/TEST-other/.host-owner/import/blobs/task-attachments/TEST-task/TEST-image--image.png'
    );
    f.files[0] = f.file(f.files[0]!.path, Buffer.from(JSON.stringify(f.task)));
    expect(() => readImportedTaskAttachment(f.authority, f.input)).toThrow('hold');
    expect(() =>
      readImportedTaskAttachment({ ...f.authority, teamName: 'TEST-other' }, f.input)
    ).toThrow('hold');
  });
  it('changed current metadata, missing backing, hash tampering and stale continuation remain held', () => {
    const f = fixture();
    f.attachment.mimeType = 'application/pdf';
    expect(() => readImportedTaskAttachment(f.authority, f.input)).toThrow('hold');
    f.attachment.mimeType = 'image/png';
    expect(() =>
      readImportedTaskAttachment(f.authority, { ...f.input, expectedSha256: 'a'.repeat(64) })
    ).toThrow('hold');
    writeFileSync(join(f.root, f.blob), Buffer.alloc(f.bytes.length, 43));
    expect(() => readImportedTaskAttachment(f.authority, f.input)).toThrow('hold');
    rmSync(join(f.root, f.blob));
    expect(() => readImportedTaskAttachment(f.authority, f.input)).toThrow();
  });
  it('refuses symlink backing/ancestors and original plan corruption before exposing bytes', () => {
    const f = fixture(),
      original = join(f.root, 'TEST-outside.png');
    writeFileSync(original, f.bytes);
    rmSync(join(f.root, f.blob));
    symlinkSync(original, join(f.root, f.blob));
    expect(() => readImportedTaskAttachment(f.authority, f.input)).toThrow('hold');
    rmSync(dirname(join(f.root, f.blob)), { recursive: true });
    symlinkSync(dirname(original), dirname(join(f.root, f.blob)));
    expect(() => readImportedTaskAttachment(f.authority, f.input)).toThrow('hold');
    f.files[0] = { ...f.files[0]!, sha256: 'b'.repeat(64) };
    expect(() => readImportedTaskAttachment(f.authority, f.input)).toThrow('hold');
  });
  it('checks current actor/lease authority again after file IO; explicit original metadata-only gap returns null', () => {
    const f = fixture();
    let calls = 0;
    expect(() =>
      readImportedTaskAttachment(
        {
          ...f.authority,
          assertCurrent: () => {
            if (++calls === 2) throw new Error('TEST-revoked');
          },
        },
        f.input
      )
    ).toThrow('TEST-revoked');
    delete (f.attachment as { filePath?: string }).filePath;
    f.files[0] = f.file(f.files[0]!.path, Buffer.from(JSON.stringify(f.task)));
    expect(() => readImportedTaskAttachment(f.authority, f.input)).toThrow('hold');
    f.authority.gaps = [{ resourceId: 'attachment:TEST-image', reason: 'metadata-only' }];
    expect(readImportedTaskAttachment(f.authority, f.input)).toBeNull();
  });
});
