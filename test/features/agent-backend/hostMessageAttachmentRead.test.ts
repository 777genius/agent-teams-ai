// @vitest-environment node
import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { BACKEND_ATTACHMENT_CHUNK_BYTES } from '../../../src/features/agent-backend/contracts/attachments';
import { BackendOperationsFacade } from '../../../src/features/agent-backend/main/adapters/input/BackendOperationsFacade';
import { parseBackendOperation } from '../../../src/features/agent-backend/main/adapters/input/validateBackendOperation';
import { projectBackendResult } from '../../../src/features/agent-backend/main/adapters/output/projectBackendResult';
import { projectTaskSourceMessage } from '../../../src/features/agent-backend/main/adapters/output/projectSourceMessage';
import { createHostBackendRenderer } from '../../../src/features/agent-backend/renderer/createHostBackendRenderer';
import { createHostMessageAttachmentRead } from '../../../src/features/agent-backend/renderer/createHostMessageAttachmentRead';

import type { AgentBackendApi } from '../../../src/features/agent-backend/contracts/operations';
import type { TeamsAPI } from '../../../src/shared/types/api';

const reference = `im1:TEST-task:${'a'.repeat(64)}`;
function reader(bytes = Buffer.from('TEST-original-image')) {
  let current = true;
  const metadata = {
    id: 'TEST-image',
    filename: 'test.png',
    mimeType: 'image/png',
    size: bytes.length,
  };
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const invoke = vi.fn(async (request: { operation: string; payload: { offset?: number } }) => {
    if (request.operation === 'message.attachments.read') return { ok: true, value: [metadata] };
    const offset = request.payload.offset!;
    const end = Math.min(bytes.length, offset + BACKEND_ATTACHMENT_CHUNK_BYTES);
    return {
      ok: true,
      value: {
        attachment: metadata,
        sha256,
        offset,
        base64: bytes.subarray(offset, end).toString('base64'),
        nextOffset: end < bytes.length ? end : null,
      },
    };
  });
  const read = createHostMessageAttachmentRead({
    backend: { invoke } as unknown as AgentBackendApi,
    captureScope: () => () => current,
    resolve: async () => ({
      handle: { handleId: 'TEST-handle' },
      assertCurrent() {
        if (!current) throw new Error('revoked');
      },
    }),
  });
  return {
    invoke,
    read,
    metadata,
    revoke() {
      current = false;
    },
  };
}
describe('existing source message attachment API', () => {
  it('reads metadata and hash-verified multi-chunk bytes through the actual renderer composition without invalidating its own fence', async () => {
    const bytes = Buffer.alloc(BACKEND_ATTACHMENT_CHUNK_BYTES + 10, 0x61);
    const f = reader(bytes);
    const legacyRead = vi.fn();
    const handle = { handleId: 'TEST-handle' };
    const backend = {
      getConnections: vi.fn().mockResolvedValue({
        state: 'ready',
        bindings: [{ handle, label: 'TEST canonical owner', members: [] }],
      }),
      invoke: f.invoke,
    } as unknown as AgentBackendApi;
    const renderer = createHostBackendRenderer(
      Object.freeze({ getAttachments: legacyRead }) as unknown as TeamsAPI,
      backend,
      () => () => true
    );
    await expect(
      renderer.teams.getAttachments('host-team:TEST-handle', reference)
    ).resolves.toEqual([
      { id: 'TEST-image', mimeType: 'image/png', data: bytes.toString('base64') },
    ]);
    expect(legacyRead).not.toHaveBeenCalled();
    expect(f.invoke.mock.calls.map(([request]) => request.operation)).toEqual([
      'message.attachments.read',
      'message.attachment.read',
      'message.attachment.read',
    ]);
    expect(f.invoke.mock.calls[2]![0].payload).toMatchObject({
      reference,
      offset: BACKEND_ATTACHMENT_CHUNK_BYTES,
      expectedSha256: createHash('sha256').update(bytes).digest('hex'),
    });
  });
  it('projects exact opaque task provenance and strips paths/extras from snapshots', () => {
    expect(
      projectTaskSourceMessage(
        { id: 'TEST-task', sourceMessageId: 'original-message' },
        'TEST-team'
      )
    ).toEqual({});
    const projected = projectTaskSourceMessage(
      {
        id: 'TEST-task',
        sourceMessageId: 'original-secret-message',
        sourceMessage: {
          text: 'TEST',
          from: 'user',
          timestamp: '2026-10-23',
          source: 'user_sent',
          private: '/private/TEST',
          attachments: [
            {
              id: 'TEST-image',
              filename: 'x.png',
              mimeType: 'image/png',
              size: 1,
              filePath: '/private/TEST/image',
            },
          ],
        },
      },
      'TEST-team'
    );
    const hash = createHash('sha256')
      .update(JSON.stringify(['TEST-team', 'TEST-task', 'original-secret-message']))
      .digest('hex');
    expect(projected.sourceMessageId).toBe(`im1:TEST-task:${hash}`);
    expect(JSON.stringify(projected)).not.toContain('original-secret');
    expect(JSON.stringify(projected)).not.toContain('/private');
    expect(() =>
      projectTaskSourceMessage(
        { id: '../bad', sourceMessageId: 'message', sourceMessage: {} },
        'TEST-team'
      )
    ).toThrow();
  });
  it('reads bounded chunks and validates final reconstructed bytes before exposing data', async () => {
    const bytes = Buffer.alloc(BACKEND_ATTACHMENT_CHUNK_BYTES + 10, 0x61),
      f = reader(bytes);
    expect(await f.read('host-team:TEST', reference)).toEqual([
      { id: 'TEST-image', mimeType: 'image/png', data: bytes.toString('base64') },
    ]);
    expect(f.invoke.mock.calls.map(([request]) => request.operation)).toEqual([
      'message.attachments.read',
      'message.attachment.read',
      'message.attachment.read',
    ]);
    expect(f.invoke.mock.calls[2]![0].payload).toMatchObject({
      reference,
      offset: BACKEND_ATTACHMENT_CHUNK_BYTES,
      expectedSha256: createHash('sha256').update(bytes).digest('hex'),
    });
  });
  it('rejects same-sized valid base64 tampering with unchanged authoritative digest', async () => {
    const f = reader();
    const original = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation(async (request) => {
      const result = await original(request);
      if (request.operation === 'message.attachment.read')
        return {
          ...result,
          value: {
            ...(result.value as object),
            base64: Buffer.from('XEST-original-image').toString('base64'),
          },
        } as typeof result;
      return result;
    });
    await expect(f.read('host-team:TEST', reference)).rejects.toThrow('integrity');
  });
  it('refuses stale authority after metadata or bytes and never exposes partial data', async () => {
    for (const phase of ['message.attachments.read', 'message.attachment.read']) {
      const f = reader(),
        original = f.invoke.getMockImplementation()!;
      f.invoke.mockImplementation(async (request) => {
        const value = await original(request);
        if (request.operation === phase) f.revoke();
        return value;
      });
      await expect(f.read('host-team:TEST', reference)).rejects.toThrow('context');
    }
  });
  it('rejects malformed/path references and invalid or duplicate metadata before chunk IO', async () => {
    const f = reader();
    for (const ref of ['/private/path', 'foreign:original-message', 'im1:../bad:' + 'a'.repeat(64)])
      await expect(f.read('host-team:TEST', ref)).rejects.toThrow();
    expect(f.invoke).not.toHaveBeenCalled();
    f.invoke.mockResolvedValue({
      ok: true,
      value: [{ ...f.metadata, id: 123 } as unknown as typeof f.metadata],
    });
    await expect(f.read('host-team:TEST', reference)).rejects.toThrow();
    f.invoke.mockClear();
    f.invoke.mockResolvedValue({ ok: true, value: [f.metadata, f.metadata] });
    await expect(f.read('host-team:TEST', reference)).rejects.toThrow();
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });
  it('routes plain canonical message IDs only through the selected owner and propagates refusal before chunk IO', async () => {
    const f = reader();
    const reference = 'original-message';
    const request = parseBackendOperation({
      handle: { handleId: 'TEST-handle' },
      commandId: 'TEST-read-canonical',
      operation: 'message.attachments.read',
      payload: { reference },
    });
    expect(request.payload).toEqual({ reference });
    await expect(f.read('host-team:TEST', reference)).resolves.toEqual([
      { id: 'TEST-image', mimeType: 'image/png', data: Buffer.from('TEST-original-image').toString('base64') },
    ]);
    expect(f.invoke.mock.calls[0]![0]).toMatchObject({
      handle: { handleId: 'TEST-handle' },
      operation: 'message.attachments.read',
      payload: { reference },
    });
    f.invoke.mockClear();
    f.invoke.mockResolvedValue({ ok: false, code: 'hold' } as never);
    await expect(f.read('host-team:TEST', reference)).rejects.toThrow('hold');
    expect(f.invoke).toHaveBeenCalledTimes(1);
    expect(f.invoke.mock.calls[0]![0].operation).toBe('message.attachments.read');
  });
  it('uses finite validated control routes with no path-bearing response fields', async () => {
    const request = parseBackendOperation({
      handle: { handleId: 'TEST-handle' },
      commandId: 'TEST-read',
      operation: 'message.attachments.read',
      payload: { reference },
    });
    const route = vi.fn().mockResolvedValue({
      ok: true,
      value: [
        {
          id: 'TEST-image',
          filename: 'x.png',
          mimeType: 'image/png',
          size: 1,
          filePath: '/private/blob',
        },
      ],
    });
    const facade = new BackendOperationsFacade({ request: route } as never);
    const result = await facade.invoke(request);
    expect(route.mock.calls[0]![1]).toMatchObject({
      method: 'team.message.attachments.read',
      control: true,
    });
    expect(JSON.stringify(result)).not.toContain('/private');
    expect(() =>
      parseBackendOperation({ ...request, payload: { reference, path: '/private/x' } })
    ).toThrow();
    expect(() =>
      parseBackendOperation({
        ...request,
        operation: 'message.attachment.read',
        payload: { reference, attachmentId: 'TEST-image', offset: BACKEND_ATTACHMENT_CHUNK_BYTES },
      })
    ).toThrow();
    expect(() =>
      projectBackendResult(request, {
        ok: true,
        value: Array(65).fill({ id: 'TEST-image', filename: 'x', mimeType: 'image/png', size: 1 }),
      })
    ).toThrow();
  });
});
