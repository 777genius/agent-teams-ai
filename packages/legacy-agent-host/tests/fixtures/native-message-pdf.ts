import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AttachmentReference } from '../../dist/attachments/uploadContracts.js';

// Valid one-page PDF1.4: Catalog/Pages/Page/Helvetica/content stream, exact xref/trailer.
// Independent parser validation belongs to this fixture's preparation record.
export const NATIVE_MESSAGE_PDF = Buffer.from('JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAyMDAgMTAwXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggNDYgPj4Kc3RyZWFtCkJUIC9GMSAxMiBUZiAyMCA1MCBUZCAoVEVTVCBuYXRpdmUgUERGKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDI0MSAwMDAwMCBuIAowMDAwMDAwMzExIDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNiAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKNDA2CiUlRU9GCg==', 'base64');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const row = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
type Host = { rpc(method: string, payload: unknown): Promise<Record<string, unknown>> };
type Envelope = (commandId: string, payload: unknown) => unknown;

export async function uploadNativeMessagePdf(host: Host, envelope: Envelope): Promise<AttachmentReference> {
  const reply = await host.rpc('team.attachment.upload', envelope('TEST-native-pdf-upload', {
    uploadId: 'TEST-native-pdf-upload', purpose: { kind: 'message', member: 'alice' },
    attachment: { id: 'TEST-native-pdf', filename: 'TEST-native-message.pdf', mimeType: 'application/pdf', size: NATIVE_MESSAGE_PDF.length },
    digest: sha(NATIVE_MESSAGE_PDF), offset: 0, base64: NATIVE_MESSAGE_PDF.toString('base64'),
  }));
  assert.equal(reply.ok, true);
  const value = row(reply.value), ref = row(value.reference);
  assert.equal(value.nextOffset, null); assert.equal(typeof ref.artifactId, 'string'); assert.ok(ref.artifactId);
  assert.equal(ref.mimeType, 'application/pdf'); assert.equal(ref.byteLength, NATIVE_MESSAGE_PDF.length);
  assert.equal(ref.digest, sha(NATIVE_MESSAGE_PDF));
  return { artifactId: String(ref.artifactId), mimeType: 'application/pdf', byteLength: NATIVE_MESSAGE_PDF.length, digest: sha(NATIVE_MESSAGE_PDF) };
}

export async function readNativeMessagePdf(host: Host, envelope: Envelope, receipt: Record<string, unknown>) {
  const messageId = row(row(receipt.value).effects).messageId;
  assert.equal(typeof messageId, 'string'); assert.ok(messageId);
  const reply = await host.rpc('team.message.attachment.read', envelope('TEST-native-pdf-read', {
    reference: messageId, attachmentId: 'TEST-native-pdf', offset: 0, expectedSha256: sha(NATIVE_MESSAGE_PDF),
  }));
  assert.equal(reply.ok, true);
  const value = row(reply.value), attachment = row(value.attachment);
  assert.equal(attachment.id, 'TEST-native-pdf'); assert.equal(attachment.mimeType, 'application/pdf');
  assert.equal(attachment.size, NATIVE_MESSAGE_PDF.length); assert.equal(value.offset, 0); assert.equal(value.nextOffset, null);
  assert.equal(value.sha256, sha(NATIVE_MESSAGE_PDF)); assert.equal(value.base64, NATIVE_MESSAGE_PDF.toString('base64'));
  return { messageId, sha256: value.sha256, byteLength: attachment.size };
}

/** Actual Anthropic HTTP request: PDF document/base64, not text/plain, image or filename. */
export function assertNativeMessagePdf(messages: unknown[]) {
  const matching = messages.map(row).filter(message => message.role === 'user' && Array.isArray(message.content) &&
    message.content.some(raw => row(raw).type === 'text' && String(row(raw).text ?? '').includes('NATIVE_TEAM_TWO')));
  assert.equal(matching.length, 1, 'one original second human DM');
  const blocks = (matching[0]!.content as unknown[]).map(row), documents = blocks.filter(block => block.type === 'document');
  assert.equal(documents.length, 1, 'one native PDF document');
  assert.equal(blocks.filter(block => block.type === 'image').length, 0, 'PDF was not replaced by image blocks');
  const document = documents[0]!, source = row(document.source);
  assert.deepEqual(source, { type: 'base64', media_type: 'application/pdf', data: NATIVE_MESSAGE_PDF.toString('base64') });
  assert.equal(typeof document.title, 'string'); assert.ok(document.title);
  return { title: document.title, sourceType: source.type, mediaType: source.media_type,
    base64: source.data, byteLength: NATIVE_MESSAGE_PDF.length, sha256: sha(NATIVE_MESSAGE_PDF) };
}
