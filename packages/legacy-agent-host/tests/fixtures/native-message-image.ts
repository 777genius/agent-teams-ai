import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CHAT_PNG, assertChatImagePixels } from './native-claude-team/chat-attachments.ts';
import type { AttachmentReference } from '../../dist/attachments/uploadContracts.js';

const row = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const NATIVE_MESSAGE_PNG = assertChatImagePixels(CHAT_PNG);
type Host = { rpc(method: string, payload: unknown): Promise<Record<string, unknown>> };
type Envelope = (commandId: string, payload: unknown) => unknown;

/** Public Team upload, reused by the existing native two-DM fixtures. */
export async function uploadNativeMessageImage(
  host: Host,
  envelope: Envelope,
  member: string
): Promise<AttachmentReference> {
  const reply = await host.rpc(
    'team.attachment.upload',
    envelope('TEST-native-image-upload', {
      uploadId: 'TEST-native-image-upload',
      purpose: { kind: 'message', member },
      attachment: {
        id: 'TEST-native-image',
        filename: 'TEST-native-image.png',
        mimeType: 'image/png',
        size: NATIVE_MESSAGE_PNG.length,
      },
      digest: sha(NATIVE_MESSAGE_PNG),
      offset: 0,
      base64: NATIVE_MESSAGE_PNG.toString('base64'),
    })
  );
  assert.equal(reply.ok, true);
  const value = row(reply.value),
    ref = row(value.reference);
  assert.equal(value.nextOffset, null);
  assert.equal(typeof ref.artifactId, 'string');
  assert.ok(ref.artifactId);
  assert.equal(ref.mimeType, 'image/png');
  assert.equal(ref.byteLength, NATIVE_MESSAGE_PNG.length);
  assert.equal(ref.digest, sha(NATIVE_MESSAGE_PNG));
  return {
    artifactId: String(ref.artifactId),
    mimeType: 'image/png',
    byteLength: NATIVE_MESSAGE_PNG.length,
    digest: sha(NATIVE_MESSAGE_PNG),
  };
}

/** Verify canonical public bytes for the exact original sent message, also after restart. */
export async function readNativeMessageImage(
  host: Host,
  envelope: Envelope,
  receipt: Record<string, unknown>
) {
  const messageId = row(row(receipt.value).effects).messageId;
  assert.equal(typeof messageId, 'string');
  assert.ok(messageId);
  const reply = await host.rpc(
    'team.message.attachment.read',
    envelope('TEST-native-image-read', {
      reference: messageId,
      attachmentId: 'TEST-native-image',
      offset: 0,
      expectedSha256: sha(NATIVE_MESSAGE_PNG),
    })
  );
  assert.equal(reply.ok, true);
  const value = row(reply.value),
    attachment = row(value.attachment);
  assert.equal(attachment.id, 'TEST-native-image');
  assert.equal(attachment.mimeType, 'image/png');
  assert.equal(attachment.size, NATIVE_MESSAGE_PNG.length);
  assert.equal(value.offset, 0);
  assert.equal(value.nextOffset, null);
  assert.equal(value.sha256, sha(NATIVE_MESSAGE_PNG));
  assert.equal(value.base64, NATIVE_MESSAGE_PNG.toString('base64'));
  return { messageId, sha256: value.sha256, byteLength: attachment.size };
}

/** Actual model API payload, not a local expected object. Allows only lossless fixture PNG reencoding. */
export function assertNativeMessageImage(messages: unknown[], provider: 'codex' | 'opencode') {
  const marker = provider === 'codex' ? 'CODEX_TEAM_TWO' : 'OPENCODE_TEAM_TWO';
  const matching = messages
    .map(row)
    .filter(
      (message) =>
        message.role === 'user' &&
        Array.isArray(message.content) &&
        message.content.some((raw) => String(row(raw).text ?? '').includes(marker))
    );
  assert.equal(matching.length, 1, 'one original second human DM');
  const parts = (matching[0]!.content as unknown[]).map(row);
  const images = parts.filter(
    (part) => part.type === (provider === 'codex' ? 'input_image' : 'image_url')
  );
  assert.equal(images.length, 1, 'one actual native image part');
  const imageIndex = parts.indexOf(images[0]!);
  const textType = provider === 'codex' ? 'input_text' : 'text';
  assert.ok(
    parts
      .slice(0, imageIndex)
      .some((part) => part.type === textType && String(part.text ?? '').includes(marker)),
    'original human DM text precedes its image'
  );
  const trailing = parts.slice(imageIndex + 1);
  // Codex 0.162 wraps local images with a native input_text closing delimiter.
  if (provider === 'codex' && trailing.length === 1)
    assert.deepEqual(trailing, [{ type: 'input_text', text: '</image>' }]);
  else assert.deepEqual(trailing, [], 'no trailing business content after image');
  const url = provider === 'codex' ? images[0]!.image_url : row(images[0]!.image_url).url;
  assert.equal(typeof url, 'string');
  assert.ok(String(url).startsWith('data:image/png;base64,'));
  const native = assertChatImagePixels(String(url).slice('data:image/png;base64,'.length));
  return {
    provider,
    canonicalSha256: sha(NATIVE_MESSAGE_PNG),
    canonicalByteLength: NATIVE_MESSAGE_PNG.length,
    nativeSha256: sha(native),
    nativeByteLength: native.length,
    nativeBase64: native.toString('base64'),
    exactCanonicalBytes: native.equals(NATIVE_MESSAGE_PNG),
    knownFixturePixels: '2x1 opaque red/green RGBA',
    nativeEncoding: 'image/png;base64',
  };
}
