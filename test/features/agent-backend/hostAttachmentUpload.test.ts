// @vitest-environment node
import { BackendOperationsFacade } from '../../../src/features/agent-backend/main/adapters/input/BackendOperationsFacade';
import { createHostTeamMutations } from '../../../src/features/agent-backend/renderer/createHostTeamMutations';
import type { TeamCommand } from '../../../packages/legacy-agent-host/src/team/contracts';
import type { AgentBackendApi } from '../../../src/features/agent-backend/contracts/operations';
import type { JsonValue } from '../../../packages/legacy-agent-host/src/contracts';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, readFileSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AttachmentArtifactStore } from '../../../packages/legacy-agent-host/src/attachments/AttachmentArtifactStore';
import { TeamOwnerStore } from '../../../packages/legacy-agent-host/src/adapters/team/TeamOwnerStore';
import { createFilesystemTeamOwner } from '../../../packages/legacy-agent-host/src/adapters/team/createFilesystemTeamOwner';
import { createTeamAttachmentComposition } from '../../../packages/legacy-agent-host/src/composition/createTeamAttachmentComposition';
import { createMemberAttachmentPort } from '../../../packages/legacy-agent-host/src/composition/createMemberAttachmentPort';
import {
  attachmentUploadSchema,
  attachmentReferencesSchema,
  messageAttachmentReferencesSchema,
} from '../../../packages/legacy-agent-host/src/attachments/uploadContracts';
import { ATTACHMENT_CHUNK_BYTES } from '../../../packages/legacy-agent-host/src/attachments/contracts';
import { deliveryFingerprint } from '../../../packages/legacy-agent-host/src/runtime/identity';
import { deliveryIdentity } from '../../../packages/legacy-agent-host/src/team/DeliveryRecovery';
import type {
  AttachmentReference,
  AttachmentUpload,
} from '../../../packages/legacy-agent-host/src/attachments/uploadContracts';
import type {
  MemberEntry,
  HostedTeam,
} from '../../../packages/legacy-agent-host/src/composition/MemberEntry';
import type { RuntimeSessionRecord } from '../../../packages/legacy-agent-host/src/runtime/contracts';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-owner-attachment-')));
  roots.push(root);
  const binding = { backendId: 'TEST-owner', teamId: 'TEST-team', teamName: 'TEST-team' };
  const delivery = { ...binding, runId: 'TEST-run', memberId: 'TEST-member', generation: '1' };
  const members = [{ memberId: 'TEST-member', name: 'captain', role: 'lead' as const, delivery }];
  const grants = [
    {
      principalId: 'TEST-human',
      memberName: 'user',
      permissions: [
        'read' as const,
        'task.write' as const,
        'message.write' as const,
        'admin' as const,
      ],
    },
    {
      principalId: 'TEST-member-principal',
      memberName: 'captain',
      permissions: ['read' as const, 'task.write' as const, 'message.write' as const],
    },
  ];
  const options = { root, binding, members, grants };
  const owner = createFilesystemTeamOwner(options),
    connection = owner.connect('TEST-human');
  const store = new TeamOwnerStore(root, binding.teamName);
  const artifacts = () => new AttachmentArtifactStore(root, binding, store);
  const created = connection.execute({
    commandId: 'TEST-create',
    operation: 'task.create',
    payload: { subject: 'TEST attachment task' },
  });
  const taskId = created.effects.taskId;
  const input = (
    bytes: Buffer,
    uploadId: string,
    purpose: AttachmentUpload['purpose'] = { kind: 'task', taskId }
  ) => ({
    uploadId,
    purpose,
    attachment: {
      id: 'TEST-file',
      filename: 'test.png',
      mimeType: 'image/png',
      size: bytes.length,
    },
    digest: sha(bytes),
  });
  const upload = (bytes: Buffer, uploadId: string, purpose?: AttachmentUpload['purpose']) => {
    let reference: AttachmentReference | undefined;
    for (let offset = 0; offset < bytes.length; offset += ATTACHMENT_CHUNK_BYTES)
      reference = artifacts().upload({
        ...input(bytes, uploadId, purpose),
        offset,
        base64: bytes.subarray(offset, offset + ATTACHMENT_CHUNK_BYTES).toString('base64'),
      }).reference;
    expect(reference).toBeDefined();
    return reference!;
  };
  const scope = { teamId: binding.teamId, projectId: 'TEST-project', workspaceId: 'TEST-project' };
  const profileOwner = {
    revision: 'TEST-owner-revision',
    protocolVersion: 1 as const,
    nodeSha256: 'a'.repeat(64),
    hostEntrySha256: 'b'.repeat(64),
    ownerId: binding.backendId,
    profileId: 'TEST-profile',
    buildId: 'TEST-build',
    storageRoot: root,
  };
  const definition = { binding, scope, members, grants };
  const hosted = { definition, owner, connection, operatorPrincipalId: 'TEST-human' } as HostedTeam;
  const composition = createTeamAttachmentComposition({
    profile: { owner: profileOwner, principalId: 'TEST-human' },
    teams: new Map([[binding.teamId, hosted]]),
    assertCurrent() {},
  });
  const envelope = (payload: JsonValue) => ({
    binding: { schemaVersion: 1, handleId: 'TEST-handle', owner: profileOwner, scope },
    commandId: 'TEST-command',
    payload,
  });
  return {
    root,
    binding,
    delivery,
    options,
    owner,
    connection,
    artifacts,
    taskId,
    input,
    upload,
    hosted,
    composition,
    envelope,
  };
}

describe('selected Team attachment publication', () => {
  it('uses one captured renderer handle for chunked comment upload and canonical facade publication; a context switch prevents publication', async () => {
    const f = fixture();
    const seen: string[] = [];
    const facade = new BackendOperationsFacade({
      async lookup() {
        return null;
      },
      async request(handle, request) {
        expect(handle).toEqual({ handleId: 'TEST-handle' });
        seen.push(request.method);
        if (request.method === 'team.attachment.upload')
          return f.composition.methods[request.method]!.handle(f.envelope(request.payload ?? {}), {
            requestId: 'TEST-upload',
            signal: new AbortController().signal,
          });
        expect(request.method).toBe('team.execute');
        const command = {
          ...(request.payload as object),
          commandId: request.commandId,
        } as TeamCommand;
        return JSON.parse(
          JSON.stringify({ ok: true, value: f.connection.execute(command) })
        ) as JsonValue;
      },
    });
    let current = true,
      switchAfterUpload = false,
      switchBetweenUploadAndPublish = false,
      queueScopeSwitch = false;
    const backend: AgentBackendApi = {
      async getConnections() {
        throw new Error('Unexpected connection lookup');
      },
      async invoke(request) {
        const result = await facade.invoke(request);
        if (
          switchAfterUpload &&
          request.operation === 'attachment.upload' &&
          result.ok &&
          result.value &&
          'nextOffset' in result.value &&
          result.value.nextOffset === null
        )
          current = false;
        if (
          switchBetweenUploadAndPublish &&
          request.operation === 'attachment.upload' &&
          result.ok &&
          result.value &&
          'nextOffset' in result.value &&
          result.value.nextOffset === null
        )
          queueScopeSwitch = true;
        return result;
      },
    };
    const mutations = createHostTeamMutations({
      backend,
      captureScope: () => () => {
        const observed = current;
        if (queueScopeSwitch) {
          queueScopeSwitch = false;
          queueMicrotask(() => {
            current = false;
          });
        }
        return observed;
      },
      async resolve() {
        return { handle: { handleId: 'TEST-handle' }, teamName: f.binding.teamName };
      },
    });
    const bytes = Buffer.alloc(1024 * 1024 + 41, 0x63);
    const comment = await mutations.addTaskComment('TEST-selection', f.taskId, {
      text: 'TEST uploaded through existing comment API',
      attachments: [
        {
          id: 'TEST-adapter-file',
          filename: 'attachment.bin',
          mimeType: 'application/octet-stream',
          base64Data: bytes.toString('base64'),
        },
      ],
    });
    expect(comment.attachments).toEqual([
      {
        id: 'TEST-adapter-file',
        filename: 'attachment.bin',
        mimeType: 'application/octet-stream',
        size: bytes.length,
        addedAt: expect.any(String),
      },
    ]);
    expect(seen).toEqual([
      'team.attachment.upload',
      'team.attachment.upload',
      'team.attachment.upload',
      'team.execute',
    ]);
    const taskFile = await mutations.saveTaskAttachment(
      'TEST-selection',
      f.taskId,
      'TEST-task-file',
      'task.txt',
      'text/plain',
      'VEVTVA=='
    );
    expect(taskFile).toMatchObject({
      id: 'TEST-task-file',
      filename: 'task.txt',
      mimeType: 'text/plain',
      size: 4,
    });
    const reopened = createFilesystemTeamOwner(f.options).connect('TEST-human');
    const taskFiles = reopened.getTask(f.taskId).attachments;
    expect(f.artifacts().read(taskFiles, 'TEST-task-file', 0)?.base64).toBe('VEVTVA==');
    await mutations.deleteTaskAttachment('TEST-selection', f.taskId, 'TEST-task-file');
    expect(
      f.artifacts().read(reopened.getTask(f.taskId).attachments, 'TEST-task-file', 0)
    ).toBeNull();
    switchAfterUpload = true;
    await expect(
      mutations.addTaskComment('TEST-selection', f.taskId, {
        text: 'TEST must not publish',
        attachments: [
          {
            id: 'TEST-abandoned-file',
            filename: 'retained.bin',
            mimeType: 'application/octet-stream',
            base64Data: 'VEVTVA==',
          },
        ],
      })
    ).rejects.toMatchObject({ code: 'attachment-upload', outcome: 'unknown' });
    expect(f.connection.getTask(f.taskId).comments).toHaveLength(1);
    expect(seen.at(-1)).toBe('team.attachment.upload');
    current = true;
    switchAfterUpload = false;
    switchBetweenUploadAndPublish = true;
    await expect(
      mutations.addTaskComment('TEST-selection', f.taskId, {
        text: 'TEST microtask must not publish',
        attachments: [
          {
            id: 'TEST-microtask-file',
            filename: 'retained.bin',
            mimeType: 'application/octet-stream',
            base64Data: 'VEVTVA==',
          },
        ],
      })
    ).rejects.toMatchObject({ code: 'context-changed', outcome: 'not-dispatched' });
    expect(f.connection.getTask(f.taskId).comments).toHaveLength(1);
    expect(seen.at(-1)).toBe('team.attachment.upload');
  });

  it('resumes a >1MiB upload after lost response/restart, publishes exactly one comment and reads exact bytes after owner restart', () => {
    const f = fixture(),
      bytes = Buffer.alloc(1024 * 1024 + 61, 0x6a),
      input = f.input(bytes, 'TEST-upload');
    const first = {
      ...input,
      offset: 0,
      base64: bytes.subarray(0, ATTACHMENT_CHUNK_BYTES).toString('base64'),
    };
    expect(f.artifacts().upload(first).nextOffset).toBe(ATTACHMENT_CHUNK_BYTES);
    expect(f.artifacts().upload(first).nextOffset).toBe(ATTACHMENT_CHUNK_BYTES);
    const reference = f.upload(bytes, 'TEST-upload');
    expect(f.connection.getTask(f.taskId).comments).toBeUndefined();
    const command = {
      commandId: 'TEST-comment',
      operation: 'task.comment' as const,
      payload: { taskId: f.taskId, text: 'TEST comment', attachments: [reference] },
    };
    const receipt = f.connection.execute(command);
    expect(receipt.phase).toBe('completed');
    const reopened = createFilesystemTeamOwner(f.options).connect('TEST-human');
    expect(reopened.execute(command)).toEqual(receipt);
    const task = reopened.getTask(f.taskId),
      comments = task.comments as { attachments: unknown[] }[];
    expect(comments).toHaveLength(1);
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < bytes.length; offset += ATTACHMENT_CHUNK_BYTES) {
      const chunk = f
        .artifacts()
        .read(comments[0]!.attachments, 'TEST-file', offset, reference.digest)!;
      chunks.push(Buffer.from(chunk.base64, 'base64'));
    }
    expect(Buffer.concat(chunks)).toEqual(bytes);
    const metadata = comments[0]!.attachments[0] as { filePath: string };
    expect(readFileSync(metadata.filePath)).toEqual(bytes);
    expect(() =>
      new AttachmentArtifactStore(
        f.root,
        { ...f.binding, teamId: 'TEST-other' },
        new TeamOwnerStore(f.root, f.binding.teamName)
      ).metadata([reference])
    ).toThrow();
    expect(() =>
      reopened.execute({
        ...command,
        commandId: 'TEST-other-comment',
        payload: { ...command.payload, taskId: 'TEST-other-task' },
      })
    ).toThrow();
  });

  it('rejects changed chunks/digests, oversized declarations and unsafe artifact ancestry before publication', () => {
    const f = fixture(),
      bytes = Buffer.alloc(ATTACHMENT_CHUNK_BYTES + 1, 0x61),
      input = f.input(bytes, 'TEST-conflict');
    f.artifacts().upload({
      ...input,
      offset: 0,
      base64: bytes.subarray(0, ATTACHMENT_CHUNK_BYTES).toString('base64'),
    });
    expect(() =>
      f.artifacts().upload({
        ...input,
        offset: 0,
        base64: Buffer.alloc(ATTACHMENT_CHUNK_BYTES, 0x62).toString('base64'),
      })
    ).toThrow();
    expect(() =>
      f.artifacts().upload({
        ...input,
        digest: 'f'.repeat(64),
        offset: ATTACHMENT_CHUNK_BYTES,
        base64: 'YQ==',
      })
    ).toThrow();
    expect(() =>
      attachmentUploadSchema.parse({
        ...input,
        purpose: { kind: 'message', member: 'captain' },
        attachment: { ...input.attachment, size: 10 * 1024 * 1024 + 1 },
        offset: 0,
        base64: 'YQ==',
      })
    ).toThrow();
    mkdirSync(join(f.root, 'appData'), { recursive: true });
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-attachment-target-')));
    roots.push(other);
    symlinkSync(other, join(f.root, 'appData', 'attachments'));
    expect(() => f.upload(Buffer.from('TEST'), 'TEST-symlink')).toThrow();
    expect(f.connection.getTask(f.taskId).comments).toBeUndefined();
  });

  it('retains chat 10/20MiB and task/comment 20/100MiB bounds with five files without lifting host frame limits', () => {
    const metadataOnly = Array.from({ length: 5 }, (_, index) => ({
      artifactId: `TEST-reference-${index}`,
      mimeType: 'text/plain',
      byteLength: 20 * 1024 * 1024,
      digest: 'a'.repeat(64),
    }));
    expect(attachmentReferencesSchema.parse(metadataOnly)).toHaveLength(5);
    expect(() =>
      attachmentReferencesSchema.parse([
        ...metadataOnly,
        { ...metadataOnly[0], artifactId: 'TEST-reference-6' },
      ])
    ).toThrow();
    expect(() =>
      messageAttachmentReferencesSchema.parse(
        metadataOnly.slice(0, 2).map((ref) => ({ ...ref, byteLength: 11 * 1024 * 1024 }))
      )
    ).toThrow();
    const f = fixture(),
      size = 10 * 1024 * 1024,
      chunk = Buffer.alloc(ATTACHMENT_CHUNK_BYTES);
    expect(
      f
        .artifacts()
        .upload({
          uploadId: 'TEST-task-twenty',
          purpose: { kind: 'task', taskId: f.taskId },
          attachment: {
            id: 'TEST-task-twenty',
            filename: 'large.bin',
            mimeType: 'application/octet-stream',
            size: 20 * 1024 * 1024,
          },
          digest: '0'.repeat(64),
          offset: 0,
          base64: chunk.toString('base64'),
        }).nextOffset
    ).toBe(ATTACHMENT_CHUNK_BYTES);
    expect(() =>
      attachmentUploadSchema.parse({
        ...f.input(Buffer.from('x'), 'TEST-too-large-task'),
        attachment: {
          id: 'TEST-file',
          filename: 'large.bin',
          mimeType: 'application/octet-stream',
          size: 20 * 1024 * 1024 + 1,
        },
        offset: 0,
        base64: 'eA==',
      })
    ).toThrow();
    for (let index = 0; index < 2; index++) {
      expect(
        f.artifacts().upload({
          uploadId: 'TEST-large-batch',
          purpose: { kind: 'message', member: 'captain' },
          attachment: {
            id: `TEST-${index}`,
            filename: 'large.bin',
            mimeType: 'application/octet-stream',
            size,
          },
          digest: '0'.repeat(64),
          offset: 0,
          base64: chunk.toString('base64'),
        }).nextOffset
      ).toBe(ATTACHMENT_CHUNK_BYTES);
    }
    expect(() =>
      f.artifacts().upload({
        uploadId: 'TEST-large-batch',
        purpose: { kind: 'message', member: 'captain' },
        attachment: { id: 'TEST-third', filename: 'small.txt', mimeType: 'text/plain', size: 1 },
        digest: sha(Buffer.from('x')),
        offset: 0,
        base64: 'eA==',
      })
    ).toThrow();
    for (let index = 0; index < 5; index++) {
      const input = f.input(Buffer.from('x'), 'TEST-count');
      f.artifacts().upload({
        ...input,
        attachment: { ...input.attachment, id: `TEST-count-${index}` },
        offset: 0,
        base64: 'eA==',
      });
    }
    expect(() =>
      f
        .artifacts()
        .upload({ ...f.input(Buffer.from('x'), 'TEST-count'), offset: 0, base64: 'eA==' })
    ).toThrow();
  });

  it('keeps message refs in product/outbox/native identity and rejects reordered/cross-owner requests', async () => {
    const f = fixture(),
      reference = f.upload(Buffer.from('TEST native image'), 'TEST-message', {
        kind: 'message',
        member: 'captain',
      });
    const command = {
      commandId: 'TEST-message',
      operation: 'message.send' as const,
      payload: {
        to: 'captain',
        text: 'Inspect image',
        messageId: 'TEST-message',
        attachments: [reference],
      },
    };
    const receipt = f.connection.execute(command);
    expect(receipt.phase).toBe('completed');
    const intent = f.connection.pendingDeliveries()[0]!;
    expect(intent.attachments).toEqual([reference]);
    expect(deliveryIdentity(intent).attachments).toEqual([reference]);
    const { attachments: _attachments, ...textOnly } = intent;
    const historical = createHash('sha256')
      .update(
        JSON.stringify({
          binding: {
            backendId: f.delivery.backendId,
            teamId: f.delivery.teamId,
            runId: f.delivery.runId,
            memberId: f.delivery.memberId,
            generation: f.delivery.generation,
          },
          deliveryId: intent.deliveryId,
          inputId: intent.inputId,
          messageId: intent.messageId,
          content: intent.content,
        })
      )
      .digest('hex');
    expect(deliveryFingerprint(textOnly)).toBe(historical);
    expect(deliveryFingerprint({ ...textOnly, attachments: [] })).toBe(historical);
    expect(deliveryFingerprint(intent)).not.toBe(
      deliveryFingerprint({ ...intent, attachments: [{ ...reference, digest: 'f'.repeat(64) }] })
    );
    expect(f.owner.authorizeDeliveryIntent(intent)).toBe(true);
    expect(f.owner.authorizeDeliveryIntent({ ...intent, attachments: [] })).toBe(false);
    const list = await f.composition.methods['team.message.attachments.read']!.handle(
      f.envelope({ reference: 'TEST-message' }),
      { requestId: 'TEST-read', signal: new AbortController().signal }
    );
    expect(list).toMatchObject({
      ok: true,
      value: [{ id: 'TEST-file', size: reference.byteLength }],
    });
    const raw = f.envelope({
      ...f.input(Buffer.from('x'), 'TEST-host', { kind: 'message', member: 'captain' }),
      offset: 0,
      base64: 'eA==',
    });
    raw.binding.scope = { ...raw.binding.scope, projectId: 'TEST-wrong' };
    expect(
      await f.composition.methods['team.attachment.upload']!.handle(raw, {
        requestId: 'TEST-upload',
        signal: new AbortController().signal,
      })
    ).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
  });

  it('resolves native bytes only for the exact current claimed input; unsupported recipients get an empty native MIME policy', async () => {
    const f = fixture(),
      reference = f.upload(Buffer.from('TEST native bytes'), 'TEST-native', {
        kind: 'message',
        member: 'captain',
      });
    f.connection.execute({
      commandId: 'TEST-native',
      operation: 'message.send',
      payload: { to: 'captain', text: 'Inspect', attachments: [reference] },
    });
    const intent = f.connection.pendingDeliveries()[0]!;
    const entry = {
      team: f.hosted,
      binding: f.delivery,
      delivery: f.delivery,
      profile: {
        provider: 'claude',
        model: 'claude-haiku-4-5',
        principalId: 'TEST-human',
        configRevision: 'TEST-revision',
      },
    } as unknown as MemberEntry;
    const operationRef = 'TEST-operation';
    const record = {
      sessionRef: 'TEST-native-session',
      inputs: [{ intent, operationRef, phase: 'claimed' }],
    } as unknown as RuntimeSessionRecord;
    const port = createMemberAttachmentPort({
      entry,
      storageRoot: f.root,
      assertCurrent() {},
      readRuntime: () => ({ record, attached: true }),
    });
    const stablePolicy = createMemberAttachmentPort({
      entry: {
        ...entry,
        binding: { ...entry.binding, generation: '2' },
        profile: { ...entry.profile, configRevision: 'TEST-next-technical-revision' },
      },
      storageRoot: f.root,
      assertCurrent() {},
      readRuntime: () => ({ record, attached: true }),
    });
    expect(stablePolicy.revision).toBe(port.revision);
    expect(stablePolicy.mimeTypes).toEqual(port.mimeTypes);
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          intent.content,
          [reference].map((ref) => [ref.artifactId, ref.mimeType, ref.byteLength, ref.digest]),
        ])
      )
      .digest('hex');
    const request = {
      trustedBinding: `${f.binding.backendId}/${f.binding.teamId}/${f.delivery.runId}/${f.delivery.memberId}`,
      sessionRef: record.sessionRef!,
      inputId: intent.inputId,
      operationRef,
      fingerprint,
      reference,
    };
    const signal = new AbortController().signal;
    expect((await port.resolve(request, signal))?.bytes).toEqual(Buffer.from('TEST native bytes'));
    expect(await port.resolve({ ...request, inputId: 'TEST-other-input' }, signal)).toBeUndefined();
    expect(await port.resolve({ ...request, fingerprint: 'f'.repeat(64) }, signal)).toBeUndefined();
    const unsupported = {
      ...entry,
      team: {
        ...entry.team,
        definition: {
          ...entry.team.definition,
          members: entry.team.definition.members.map((member) => ({
            ...member,
            role: 'member' as const,
          })),
        },
      },
    };
    expect(
      createMemberAttachmentPort({
        entry: unsupported,
        storageRoot: f.root,
        assertCurrent() {},
        readRuntime: () => ({ record, attached: true }),
      }).mimeTypes
    ).toEqual([]);
  });
});
