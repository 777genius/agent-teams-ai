// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFilesystemTeamOwner } from '../../../packages/legacy-agent-host/dist/adapters/team/createFilesystemTeamOwner.js';
import { importedMessageReference } from '../../../packages/legacy-agent-host/dist/attachments/importedMessageReference.js';
import {
  readImportedMessageAttachment,
  readImportedTaskAttachment,
} from '../../../packages/legacy-agent-host/dist/attachments/readImportedTaskAttachment.js';
import { createTeamAttachmentComposition } from '../../../packages/legacy-agent-host/dist/composition/createTeamAttachmentComposition.js';
import { readBackendAttachmentChunk } from '../../../src/features/agent-backend/contracts/attachments';
import { BackendOperationsFacade } from '../../../src/features/agent-backend/main/adapters/input/BackendOperationsFacade';
import { projectBackendResult } from '../../../src/features/agent-backend/main/adapters/output/projectBackendResult';
import { projectTeamSnapshot } from '../../../src/features/agent-backend/main/adapters/output/projectTeamSnapshot';
import { BackendOwnerRouter } from '../../../src/features/agent-backend/main/application/BackendOwnerRouter';
import { CapturedHostClient } from '../../../src/features/agent-backend/main/infrastructure/CapturedHostClient';
import { createHostMessageAttachmentRead } from '../../../src/features/agent-backend/renderer/createHostMessageAttachmentRead';
import { createHostTaskAttachmentRead } from '../../../src/features/agent-backend/renderer/createHostTaskAttachmentRead';

import type { HostedTeam } from '../../../packages/legacy-agent-host/dist/composition/MemberEntry.js';
import type { JsonValue } from '../../../packages/legacy-agent-host/dist/contracts.js';
import type { AgentBackendApi } from '../../../src/features/agent-backend/contracts/operations';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-attachment-owner-')));
  roots.push(root);
  const binding = { backendId: 'TEST-owner', teamId: 'TEST-team-id', teamName: 'TEST-team' };
  const members = [{ memberId: 'TEST-lead', name: 'captain', role: 'lead' as const }];
  const grants = [
    { principalId: 'TEST-reader', memberName: 'user', permissions: ['read' as const] },
    {
      principalId: 'TEST-admin',
      memberName: 'user',
      permissions: ['read' as const, 'admin' as const],
    },
  ];
  const owner = createFilesystemTeamOwner({ root, binding, members, grants });
  const blob =
    'teams/TEST-team/.host-owner/import/blobs/task-attachments/TEST-task/TEST-image--test.png';
  mkdirSync(dirname(join(root, blob)), { recursive: true });
  const bytes = Buffer.alloc(384 * 1024 + 10, 0x61);
  writeFileSync(join(root, blob), bytes);
  const attachment = {
    id: 'TEST-image',
    filename: 'test.png',
    mimeType: 'image/png',
    size: bytes.length,
    filePath: join(root, blob),
  };
  const task = {
    id: 'TEST-task',
    subject: 'TEST',
    status: 'pending',
    attachments: [attachment],
    sourceMessageId: 'TEST-original-message',
    sourceMessage: {
      text: 'TEST source',
      from: 'user',
      timestamp: '2026-10-23',
      attachments: [attachment],
    },
    comments: [
      {
        id: 'TEST-comment',
        author: 'user',
        text: 'TEST',
        type: 'regular',
        createdAt: '2026-10-23',
        attachments: [{ ...attachment, id: 'TEST-comment-image' }],
      },
    ],
  };
  const taskPath = 'tasks/TEST-team/TEST-task.json';
  mkdirSync(dirname(join(root, taskPath)), { recursive: true });
  writeFileSync(join(root, taskPath), JSON.stringify(task));
  const file = (path: string, data: Buffer) => ({
    path,
    base64: data.toString('base64'),
    sha256: sha(data),
  });
  const files = [file(taskPath, Buffer.from(JSON.stringify(task))), file(blob, bytes)];
  const scope = {
    projectId: 'TEST-context',
    workspaceId: 'TEST-context',
    teamId: binding.teamId,
    runId: 'TEST-run',
    memberId: 'user',
    generation: '1',
  };
  const hosted: HostedTeam = {
    definition: { binding, scope, members, grants },
    owner,
    connection: owner.connect('TEST-reader'),
  };
  const profile = {
    principalId: 'TEST-reader',
    owner: {
      ownerId: 'TEST-owner',
      revision: 'TEST-revision',
      storageRoot: root,
      profileId: 'TEST-profile',
      protocolVersion: 1 as const,
      buildId: 'TEST-build',
      nodeSha256: 'a'.repeat(64),
      hostEntrySha256: 'b'.repeat(64),
    },
  };
  let current = true;
  const read = vi.fn((_teamId: string, currentTask: unknown, payload: unknown) => {
    const authority = {
      root,
      teamName: binding.teamName,
      task: currentTask,
      files,
      gaps: [],
      assertCurrent: () => {
        if (!current) throw new Error('TEST-stale');
      },
    };
    const { messageMode, ...input } = payload as Record<string, unknown>;
    return messageMode
      ? readImportedMessageAttachment(authority, input, messageMode === 'list')
      : readImportedTaskAttachment(authority, payload);
  });
  const composition = createTeamAttachmentComposition({
    profile,
    teams: new Map([[binding.teamId, hosted]]),
    read,
    assertCurrent: () => {
      if (!current) throw new Error('TEST-stale');
    },
  });
  const handler = composition.methods['team.task.attachment.read']!;
  const method = {
    handle: (raw: JsonValue | undefined) =>
      handler.handle(raw, { requestId: 'TEST-read', signal: new AbortController().signal }),
  };
  const envelope = {
    binding: { schemaVersion: 1 as const, handleId: 'TEST-handle', owner: profile.owner, scope },
    commandId: 'TEST-read',
    payload: { taskId: 'TEST-task', attachmentId: 'TEST-image', offset: 0 },
  };
  // Exercise the actual owner router's retained binding, without starting a child transport.
  const client = new CapturedHostClient({
    profileId: profile.owner.profileId,
    nodeExecutable: process.execPath,
    nodeVersion: 'v24.21.0',
    nodeSha256: profile.owner.nodeSha256,
    hostEntry: join(root, 'TEST-unused-host.js'),
    hostEntrySha256: profile.owner.hostEntrySha256,
    expectedBuildId: profile.owner.buildId,
    cwd: root,
    env: { HOME: root, TMPDIR: root },
    startupTimeoutMs: 1000,
    requestTimeoutMs: 1000,
    writeTimeoutMs: 1000,
    shutdownTimeoutMs: 1000,
  });
  const wire = vi.spyOn(client, 'request').mockImplementation(async (name, params, options) => {
    expect(options?.control).toBe(true);
    expect(params).toMatchObject({ binding: envelope.binding });
    const route = composition.methods[name];
    if (!route) throw new Error('Unexpected TEST route');
    return route.handle(params, { requestId: 'TEST-read', signal: new AbortController().signal });
  });
  const router = new BackendOwnerRouter({
    read: async (handleId) => (handleId === envelope.binding.handleId ? envelope.binding : null),
    create: async () => false,
  });
  router.registerOwner({ ...profile.owner, client });
  const facade = new BackendOperationsFacade(router);
  const backend: AgentBackendApi = {
    invoke: (request) => facade.invoke(request, { isCurrent: () => current }),
    getConnections: vi.fn(),
  };
  const getAttachment = createHostTaskAttachmentRead({
    backend,
    captureScope: () => () => current,
    resolve: async () => ({
      handle: { handleId: 'TEST-handle' },
      assertCurrent: () => {
        if (!current) throw new Error('TEST-stale');
      },
    }),
  });
  return {
    root,
    owner,
    hosted,
    profile,
    envelope,
    method,
    facade,
    backend,
    getAttachment,
    bytes,
    wire,
    read,
    getMessages: createHostMessageAttachmentRead({
      backend,
      captureScope: () => () => current,
      resolve: async () => ({
        handle: { handleId: 'TEST-handle' },
        assertCurrent() {
          if (!current) throw new Error('TEST-stale');
        },
      }),
    }),
    reference: importedMessageReference(binding.teamName, task.id, task.sourceMessageId),
    retire: () => {
      current = false;
    },
  };
}
describe('actual canonical Team read authority through Main/renderer attachment adapters', () => {
  it('returns exact task/comment bytes through existing getTaskAttachment and omits paths in both consumer projections', async () => {
    const f = fixture();
    expect(
      await f.getAttachment('host-team:TEST-handle', 'TEST-task', 'TEST-image', 'image/png')
    ).toBe(f.bytes.toString('base64'));
    expect(
      await f.getAttachment('host-team:TEST-handle', 'TEST-task', 'TEST-comment-image', 'image/png')
    ).toBe(f.bytes.toString('base64'));
    const snapshot = projectTeamSnapshot(f.hosted.connection.readSnapshot());
    expect(snapshot.tasks[0]!.attachments).toHaveLength(1);
    expect(snapshot.tasks[0]!.comments![0]!.attachments).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toContain(f.root);
    const task = f.hosted.connection.getTask('TEST-task');
    const projected = projectBackendResult(
      {
        handle: { handleId: 'TEST-handle' },
        commandId: 'TEST-read',
        operation: 'task.get',
        payload: { taskId: 'TEST-task' },
      },
      { ok: true, value: task }
    );
    expect(JSON.stringify(projected)).not.toContain(f.root);
    expect(JSON.stringify(projected)).toContain('TEST-comment-image');
  });
  it('routes full retained Main binding through all three real Host read operations and exact multi-chunk source bytes', async () => {
    const f = fixture();
    expect(await f.getMessages('host-team:TEST-handle', f.reference)).toEqual([
      { id: 'TEST-image', mimeType: 'image/png', data: f.bytes.toString('base64') },
    ]);
    expect(
      await f.getAttachment('host-team:TEST-handle', 'TEST-task', 'TEST-image', 'image/png')
    ).toBe(f.bytes.toString('base64'));
    expect([...new Set(f.wire.mock.calls.map(([method]) => method))].sort()).toEqual([
      'team.message.attachment.read',
      'team.message.attachments.read',
      'team.task.attachment.read',
    ]);
    for (const invalid of [
      { owner: f.profile.owner, scope: f.envelope.binding.scope },
      { ...f.envelope.binding, privatePath: '/TEST-not-a-selector' },
    ])
      expect(await f.method.handle({ ...f.envelope, binding: invalid })).toMatchObject({
        ok: false,
        code: 'invalid',
      });
  });
  it('rejects wrong original owner/scope and current revoked actor before blob reader access', async () => {
    const f = fixture();
    expect(
      await f.method.handle({
        ...f.envelope,
        binding: { ...f.envelope.binding, owner: { ...f.profile.owner, ownerId: 'TEST-other' } },
      })
    ).toMatchObject({ ok: false, code: 'forbidden' });
    expect(
      await f.method.handle({
        ...f.envelope,
        binding: {
          ...f.envelope.binding,
          scope: { ...f.envelope.binding.scope, runId: 'TEST-other' },
        },
      })
    ).toMatchObject({ ok: false, code: 'forbidden' });
    expect(f.read).not.toHaveBeenCalled();
    f.owner.connect('TEST-admin').revoke('TEST-reader');
    expect(await f.method.handle(f.envelope)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(f.read).not.toHaveBeenCalled();
  });
  it('refuses stale context and MIME reinterpretation without any legacy fallback', async () => {
    const f = fixture();
    await expect(
      f.getAttachment('host-team:TEST-handle', 'TEST-task', 'TEST-image', 'application/pdf')
    ).rejects.toThrow('metadata changed');
    f.retire();
    await expect(
      f.getAttachment('host-team:TEST-handle', 'TEST-task', 'TEST-image', 'image/png')
    ).rejects.toThrow('context changed');
  });
  it('rejects malformed/cross-file continuation envelopes and oversized chunks at consumer boundary', () => {
    const value = {
      attachment: { id: 'TEST-image', filename: 'test.png', mimeType: 'image/png', size: 1 },
      sha256: 'a'.repeat(64),
      offset: 0,
      base64: 'YQ==',
      nextOffset: null,
    };
    expect(() =>
      readBackendAttachmentChunk(
        { ...value, offset: 1 },
        { taskId: 'TEST-task', attachmentId: 'TEST-image', offset: 0 }
      )
    ).toThrow();
    expect(() =>
      readBackendAttachmentChunk(
        { ...value, sha256: 'b'.repeat(64) },
        {
          taskId: 'TEST-task',
          attachmentId: 'TEST-image',
          offset: 0,
          expectedSha256: 'a'.repeat(64),
        }
      )
    ).toThrow();
    expect(() =>
      readBackendAttachmentChunk(
        { ...value, base64: 'a'.repeat(600000) },
        { taskId: 'TEST-task', attachmentId: 'TEST-image', offset: 0 }
      )
    ).toThrow();
  });
  it('rejects same-sized valid base64 tampering even when original metadata and claimed digest are unchanged', async () => {
    const f = fixture();
    const backend: AgentBackendApi = {
      ...f.backend,
      invoke: async (request) => {
        const result = await f.backend.invoke(request);
        if (result.ok && result.value && 'base64' in result.value)
          return {
            ok: true,
            value: {
              ...result.value,
              base64: Buffer.alloc(
                Buffer.from(String(result.value.base64), 'base64').length,
                42
              ).toString('base64'),
            },
          };
        return result;
      },
    };
    const read = createHostTaskAttachmentRead({
      backend,
      captureScope: () => () => true,
      resolve: async () => ({ handle: { handleId: 'TEST-handle' }, assertCurrent() {} }),
    });
    await expect(
      read('host-team:TEST-handle', 'TEST-task', 'TEST-image', 'image/png')
    ).rejects.toThrow('integrity failed');
  });
});
