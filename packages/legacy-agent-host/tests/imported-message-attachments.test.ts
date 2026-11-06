import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';

import {
  readImportedTaskAttachment,
  readImportedMessageAttachment,
} from '../dist/attachments/readImportedTaskAttachment.js';
import { importedMessageReference } from '../dist/attachments/importedMessageReference.js';
import { ATTACHMENT_CHUNK_BYTES } from '../dist/attachments/contracts.js';
import { TeamOwnerError } from '../dist/team/contracts.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
function fixture(initialize?: (root: string) => void) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-message-attachment-')));
  roots.push(root);
  initialize?.(root);
  const teamName = 'TEST-team',
    taskId = 'TEST-task',
    messageId = 'TEST-original-message';
  const path = `teams/${teamName}/.host-owner/import/blobs/attachments/TEST-message/image.png`;
  const bytes = Buffer.alloc(ATTACHMENT_CHUNK_BYTES + 12, 0x61);
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), bytes);
  const attachment = {
    id: 'TEST-image',
    filename: 'image.png',
    mimeType: 'image/png',
    size: bytes.length,
    filePath: join(root, path),
  };
  const task = {
    id: taskId,
    subject: 'TEST source task',
    status: 'pending',
    sourceMessageId: messageId,
    sourceMessage: {
      text: 'TEST source',
      from: 'user',
      timestamp: '2026-10-23',
      attachments: [attachment],
    },
  };
  const taskPath = join(root, 'tasks', teamName, taskId + '.json');
  mkdirSync(dirname(taskPath), { recursive: true });
  writeFileSync(taskPath, JSON.stringify(task));
  const file = (path: string, bytes: Buffer) => ({
    path,
    sha256: sha(bytes),
    base64: bytes.toString('base64'),
  });
  let current = true;
  const authority = {
    root,
    teamName,
    task,
    files: [
      file(`tasks/${teamName}/${taskId}.json`, Buffer.from(JSON.stringify(task))),
      file(path, bytes),
    ],
    gaps: [],
    assertCurrent() {
      if (!current) throw new TeamOwnerError('forbidden');
    },
  };
  return {
    authority,
    bytes,
    path,
    attachment,
    reference: importedMessageReference(teamName, taskId, messageId),
    revoke() {
      current = false;
    },
  };
}
const held = (error: unknown) =>
  error instanceof TeamOwnerError && (error.code === 'hold' || error.code === 'forbidden');
test('source message exact original metadata and chunked bytes are read without public paths', () => {
  const f = fixture();
  const metadata = readImportedMessageAttachment(f.authority, { reference: f.reference }, true);
  assert.deepEqual(metadata, [
    { id: 'TEST-image', filename: 'image.png', mimeType: 'image/png', size: f.bytes.length },
  ]);
  const first = readImportedMessageAttachment(
    f.authority,
    { reference: f.reference, attachmentId: 'TEST-image', offset: 0 },
    false
  );
  assert.ok(first && !Array.isArray(first));
  assert.equal(first.nextOffset, ATTACHMENT_CHUNK_BYTES);
  const second = readImportedMessageAttachment(
    f.authority,
    {
      reference: f.reference,
      attachmentId: 'TEST-image',
      offset: first.nextOffset,
      expectedSha256: first.sha256,
    },
    false
  );
  assert.ok(second && !Array.isArray(second));
  assert.equal(second.nextOffset, null);
  assert.deepEqual(Buffer.from(first.base64 + second.base64, 'base64'), f.bytes);
  assert.equal(JSON.stringify(first).includes(f.authority.root), false);
});
test('reference cannot select another Team, Task, source message, or changed current snapshot', () => {
  const f = fixture();
  for (const reference of [
    importedMessageReference('TEST-other', f.authority.task.id, f.authority.task.sourceMessageId),
    importedMessageReference(f.authority.teamName, 'TEST-other', f.authority.task.sourceMessageId),
    importedMessageReference(f.authority.teamName, f.authority.task.id, 'TEST-other'),
  ]) {
    assert.throws(() => readImportedMessageAttachment(f.authority, { reference }, true), held);
  }
  f.authority.task.sourceMessage.text = 'changed';
  assert.throws(
    () => readImportedMessageAttachment(f.authority, { reference: f.reference }, true),
    held
  );
});
test('original plan hash, current custody and physical blob integrity are mandatory', () => {
  const f = fixture();
  f.authority.files[0]!.sha256 = '0'.repeat(64);
  assert.throws(
    () => readImportedMessageAttachment(f.authority, { reference: f.reference }, true),
    held
  );
  const g = fixture();
  writeFileSync(join(g.authority.root, g.path), Buffer.alloc(g.bytes.length, 0x62));
  assert.throws(
    () =>
      readImportedMessageAttachment(
        g.authority,
        { reference: g.reference, attachmentId: 'TEST-image', offset: 0 },
        false
      ),
    held
  );
  const h = fixture();
  h.revoke();
  assert.throws(
    () => readImportedMessageAttachment(h.authority, { reference: h.reference }, true),
    held
  );
});
test('traversal, symlink and unretained blob paths cannot escape the import map', () => {
  for (const mode of ['traversal', 'symlink', 'missing'] as const) {
    const f = fixture();
    if (mode === 'symlink') {
      const outside = join(f.authority.root, 'TEST-outside');
      writeFileSync(outside, f.bytes);
      rmSync(join(f.authority.root, f.path));
      symlinkSync(outside, join(f.authority.root, f.path));
    } else if (mode === 'traversal') {
      f.attachment.filePath = join(f.authority.root, '../TEST-outside');
      const original = Buffer.from(JSON.stringify(f.authority.task));
      f.authority.files[0]!.base64 = original.toString('base64');
      f.authority.files[0]!.sha256 = sha(original);
    } else {
      f.authority.files.pop();
    }
    assert.throws(() =>
      readImportedMessageAttachment(
        f.authority,
        { reference: f.reference, attachmentId: 'TEST-image', offset: 0 },
        false
      )
    );
  }
});
test('strict finite payload rejects arbitrary paths, original IDs, bad offsets and missing continuation digest', () => {
  const f = fixture(),
    input = { reference: f.reference, attachmentId: 'TEST-image', offset: 0 };
  for (const payload of [
    { ...input, path: f.path },
    { ...input, reference: f.authority.task.sourceMessageId },
    { ...input, attachmentId: '../x' },
    { ...input, offset: 1 },
    { ...input, offset: ATTACHMENT_CHUNK_BYTES },
    { ...input, offset: 0, expectedSha256: '0'.repeat(64) },
  ]) {
    assert.throws(() => readImportedMessageAttachment(f.authority, payload, false));
  }
});
test('duplicate or over-cap retained attachment census refuses instead of truncating', () => {
  const f = fixture();
  f.authority.task.sourceMessage.attachments.push({ ...f.attachment });
  const bytes = Buffer.from(JSON.stringify(f.authority.task));
  f.authority.files[0]!.base64 = bytes.toString('base64');
  f.authority.files[0]!.sha256 = sha(bytes);
  assert.throws(
    () => readImportedMessageAttachment(f.authority, { reference: f.reference }, true),
    held
  );
});

test('actual Team attachment control route accepts full Main stored binding and enforces owner/scope/principal/current lease', async () => {
  const { createFilesystemTeamOwner } =
    await import('../dist/adapters/team/createFilesystemTeamOwner.js');
  const { createTeamAttachmentComposition } =
    await import('../dist/composition/createTeamAttachmentComposition.js');
  const binding = { backendId: 'TEST-owner', teamId: 'TEST-team-id', teamName: 'TEST-team' };
  const members = [{ memberId: 'TEST-lead', name: 'captain', role: 'lead' as const }];
  const grants = [
    { principalId: 'TEST-reader', memberName: 'user', permissions: ['read' as const] },
  ];
  let owner!: ReturnType<typeof createFilesystemTeamOwner>;
  const f = fixture((root) => {
    owner = createFilesystemTeamOwner({ root, binding, members, grants });
  });
  const scope = {
    projectId: 'TEST-context',
    workspaceId: 'TEST-context',
    teamId: binding.teamId,
    runId: 'TEST-run',
    memberId: 'user',
    generation: '1',
  };
  const profile = {
    principalId: 'TEST-reader',
    owner: {
      ownerId: 'TEST-owner',
      revision: 'TEST-revision',
      storageRoot: f.authority.root,
      profileId: 'TEST-profile',
      protocolVersion: 1 as const,
      buildId: 'TEST-build',
      nodeSha256: 'a'.repeat(64),
      hostEntrySha256: 'b'.repeat(64),
    },
  };
  const hosted = {
    definition: { binding, scope, members, grants },
    owner,
    connection: owner.connect('TEST-reader'),
  };
  let calls = 0;
  const make = (principalId: string) =>
    createTeamAttachmentComposition({
      profile: { ...profile, principalId },
      teams: new Map([[binding.teamId, hosted]]),
      assertCurrent: f.authority.assertCurrent,
      read(_teamId, task, payload) {
        calls++;
        const { messageMode, ...input } = payload as Record<string, unknown>;
        return readImportedMessageAttachment(
          { ...f.authority, task },
          input,
          messageMode === 'list'
        );
      },
    });
  const envelope = {
    // BackendOwnerRouter.request sends the complete retained StoredBackendBinding unchanged.
    binding: { schemaVersion: 1, handleId: 'TEST-original-handle', owner: profile.owner, scope },
    commandId: 'TEST-read',
    payload: { reference: f.reference },
  };
  const invoke = (
    composition: ReturnType<typeof make>,
    raw: unknown,
    method = 'team.message.attachments.read'
  ) =>
    composition.methods[method]!.handle(raw as never, {
      requestId: 'TEST-read',
      signal: new AbortController().signal,
    });
  assert.equal(((await invoke(make('TEST-reader'), envelope)) as { ok: boolean }).ok, true);
  const chunks: Buffer[] = [];
  let offset = 0;
  let expectedSha256: string | undefined;
  for (let count = 0; count < 2; count++) {
    const result = (await invoke(
      make('TEST-reader'),
      {
        ...envelope,
        commandId: `TEST-chunk-${count}`,
        payload: {
          reference: f.reference,
          attachmentId: f.attachment.id,
          offset,
          ...(expectedSha256 ? { expectedSha256 } : {}),
        },
      },
      'team.message.attachment.read'
    )) as {
      ok: boolean;
      value: { base64: string; sha256: string; offset: number; nextOffset: number | null };
    };
    assert.equal(result.ok, true);
    assert.equal(result.value.offset, offset);
    assert.equal(result.value.sha256, sha(f.bytes));
    chunks.push(Buffer.from(result.value.base64, 'base64'));
    expectedSha256 = result.value.sha256;
    if (result.value.nextOffset === null) break;
    offset = result.value.nextOffset;
  }
  assert.deepEqual(Buffer.concat(chunks), f.bytes);
  for (const binding of [
    { owner: profile.owner, scope },
    { ...envelope.binding, schemaVersion: 2 },
    { ...envelope.binding, handleId: '' },
    { ...envelope.binding, handleId: 'TEST\0invalid' },
    { ...envelope.binding, privatePath: '/TEST-not-a-selector' },
  ]) {
    assert.deepEqual(await invoke(make('TEST-reader'), { ...envelope, binding }), {
      ok: false,
      code: 'invalid',
      outcome: 'not-dispatched',
    });
  }
  for (const raw of [
    {
      ...envelope,
      binding: { ...envelope.binding, owner: { ...profile.owner, ownerId: 'other' } },
    },
    { ...envelope, binding: { ...envelope.binding, scope: { ...scope, generation: '2' } } },
  ]) {
    assert.deepEqual(await invoke(make('TEST-reader'), raw), {
      ok: false,
      code: 'forbidden',
      outcome: 'not-dispatched',
    });
  }
  assert.deepEqual(await invoke(make('TEST-foreign'), envelope), {
    ok: false,
    code: 'forbidden',
    outcome: 'not-dispatched',
  });
  assert.equal(calls, 3);
  f.revoke();
  assert.deepEqual(await invoke(make('TEST-reader'), envelope), {
    ok: false,
    code: 'forbidden',
    outcome: 'not-dispatched',
  });
  assert.equal(calls, 3);
});

test('shared current source reader preserves exact task and comment attachment reads', () => {
  const f = fixture();
  const task = {
    ...f.authority.task,
    attachments: [{ ...f.attachment, id: 'TEST-task-image' }],
    comments: [
      { id: 'TEST-comment', attachments: [{ ...f.attachment, id: 'TEST-comment-image' }] },
    ],
  };
  const bytes = Buffer.from(JSON.stringify(task));
  f.authority.files[0]!.base64 = bytes.toString('base64');
  f.authority.files[0]!.sha256 = sha(bytes);
  for (const attachmentId of ['TEST-task-image', 'TEST-comment-image']) {
    const chunk = readImportedTaskAttachment(
      { ...f.authority, task },
      { taskId: task.id, attachmentId, offset: 0 }
    );
    assert.ok(chunk);
    assert.equal(chunk.sha256, sha(f.bytes));
    assert.equal(chunk.attachment.id, attachmentId);
  }
});
