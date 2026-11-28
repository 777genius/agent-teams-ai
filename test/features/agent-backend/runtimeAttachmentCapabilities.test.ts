// @vitest-environment node
import { expect, it } from 'vitest';

import { resolveAgentAttachmentCapability } from '../../../packages/legacy-agent-host/src/attachments/capabilities';
import { getMessageAttachmentRoute } from '../../../packages/legacy-agent-host/src/attachments/messageFileReferences';
import { projectBackendResult } from '../../../src/features/agent-backend/main/adapters/output/projectBackendResult';

import type { BackendOperationRequest } from '../../../src/features/agent-backend/contracts/operations';

const request: BackendOperationRequest = {
  handle: { handleId: 'TEST-handle' },
  commandId: 'TEST-runtime-capabilities',
  operation: 'runtime.read',
  payload: { memberId: 'TEST-member' },
};
const snapshot = () => ({
  memberId: 'TEST-member',
  generation: 'TEST-current',
  phase: 'allocated',
  sealed: false,
  custody: 'owned',
  nativeReady: true,
  attached: true,
  inputs: [],
  interactions: [],
  attachmentCapabilities: {
    images: true,
    documents: true,
    textFiles: true,
    privatePath: '/TEST-private',
  },
});

it('projects only explicit native channel booleans from a current attached ready Runtime snapshot', () => {
  const result = projectBackendResult(request, { ok: true, value: snapshot() });
  expect(result).toMatchObject({
    ok: true,
    value: {
      attachmentCapabilities: { images: true, documents: true, textFiles: true },
    },
  });
  expect(JSON.stringify(result)).not.toContain('TEST-private');
});

it('rejects native channel claims for inactive snapshots or non-boolean channel values', () => {
  for (const patch of [
    { generation: undefined },
    { phase: 'closed' },
    { sealed: true },
    { custody: 'unknown' },
    { nativeReady: false },
    { attached: false },
    { attachmentCapabilities: { images: 'true', documents: false, textFiles: false } },
  ]) {
    expect(() =>
      projectBackendResult(request, { ok: true, value: { ...snapshot(), ...patch } })
    ).toThrow();
  }
});

it('keeps historical hosts without explicit channel metadata compatible and does not infer support', () => {
  const { attachmentCapabilities: _capabilities, ...legacy } = snapshot();
  const result = projectBackendResult(request, { ok: true, value: legacy });
  expect(result).toEqual({ ok: true, value: legacy });
});


it('keeps V2 transport and selected model support separate without offering video or falling back to a file reference', () => {
  const transport = { revision: 'opencode-2.1.4-native-media-v1' as const,
    mimeTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'] as const,
    maxBytes: 4 * 1024 * 1024, maxCount: 5, maxTotalBytes: 8 * 1024 * 1024, videos: false as const };
  const value = { ...snapshot(), attachmentCapabilities: { images: true, documents: true, textFiles: false, nativeMedia: transport } };
  expect(projectBackendResult(request, { ok: true, value })).toMatchObject({ ok: true, value: {
    attachmentCapabilities: { nativeMedia: transport },
  } });
  const capability = resolveAgentAttachmentCapability({ providerId: 'opencode',
    declaredInputModalities: ['text', 'image', 'pdf', 'video'], nativeMediaTransport: transport });
  expect(capability.supportedImageMimeTypes).toEqual(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  expect(capability.supportedFileMimeTypes).toEqual(['application/pdf']);
  expect(capability.supportsVideo).toBe(false);
  for (const mimeType of transport.mimeTypes) {
    expect(getMessageAttachmentRoute({ providerId: 'opencode', isLeadRecipient: true,
      nativeMediaTransport: transport.revision }, mimeType)).toBe('native');
  }
  const textOnly = resolveAgentAttachmentCapability({ providerId: 'opencode',
    declaredInputModalities: ['text'], nativeMediaTransport: { ...transport, mimeTypes: [] } });
  expect(textOnly.supportsImages).toBe(false);
  expect(textOnly.supportsFiles).toBe(false);
  expect(textOnly.supportsVideo).toBe(false);
  expect(getMessageAttachmentRoute({ providerId: 'opencode', isLeadRecipient: true,
    nativeMediaTransport: transport.revision }, 'image/gif')).toBe('native');
  for (const patch of [{ videos: true }, { revision: 'unknown' }, { maxBytes: 4 * 1024 * 1024 + 1 },
    { mimeTypes: ['video/mp4'] }, { mimeTypes: ['image/png'] }]) {
    expect(() => projectBackendResult(request, { ok: true, value: { ...value,
      attachmentCapabilities: { ...value.attachmentCapabilities, nativeMedia: { ...transport, ...patch } },
    } })).toThrow();
  }
});
