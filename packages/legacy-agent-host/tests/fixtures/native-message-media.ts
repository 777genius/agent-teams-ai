/** Exact media fixtures through the existing Host upload and native model API. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { NATIVE_MESSAGE_PNG, uploadNativeMessageImage, readNativeMessageImage } from './native-message-image.ts';
import { NATIVE_MESSAGE_PDF } from './native-message-pdf.ts';
import type { AttachmentReference } from '../../dist/attachments/uploadContracts.js';

const row = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function chunk(type: string, data: Buffer) {
  const bytes = Buffer.alloc(data.length + 12); bytes.writeUInt32BE(data.length);
  bytes.write(type, 4, 'ascii'); data.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4); return bytes;
}
// A valid exact 4 MiB PNG, 2001x1 solid opaque red. Its tEXt chunk belongs to
// the original uploaded bytes; the native 2000px/5MiB-base64 normalizer removes it.
function originalLargePng() {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.from([0, 0, 7, 209, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  const pixels = Buffer.alloc(1 + 2001 * 4);
  for (let i = 1; i < pixels.length; i += 4) { pixels[i] = 255; pixels[i + 3] = 255; }
  const ihdr = chunk('IHDR', header), idat = chunk('IDAT', deflateSync(pixels)), end = chunk('IEND', Buffer.alloc(0));
  const padding = Buffer.alloc(4 * 1024 * 1024 - signature.length - ihdr.length - idat.length - end.length - 12, 32);
  padding.write('TEST\0', 0, 'ascii');
  return Buffer.concat([signature, ihdr, chunk('tEXt', padding), idat, end]);
}
const extras = [
  { id: 'TEST-native-jpeg', mime: 'image/jpeg', bytes: Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z', 'base64') },
  { id: 'TEST-native-gif', mime: 'image/gif', bytes: Buffer.from('R0lGODdhAgABAIEAAP8AAAAAAAAAAAAAACwAAAAAAgABAAAIBQABAAgIADs=', 'base64') },
  { id: 'TEST-native-webp', mime: 'image/webp', bytes: Buffer.from('UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAEAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=', 'base64') },
  { id: 'TEST-native-normalized', mime: 'image/png', bytes: originalLargePng() },
  { id: 'TEST-native-media-pdf', mime: 'application/pdf', bytes: NATIVE_MESSAGE_PDF },
] as const;
type Host = Parameters<typeof uploadNativeMessageImage>[0];
type Envelope = Parameters<typeof uploadNativeMessageImage>[1];

export async function uploadNativeMessageMedia(host: Host, envelope: Envelope, member: string) {
  const references: AttachmentReference[] = [await uploadNativeMessageImage(host, envelope, member)];
  for (const media of extras) {
    let reference: Record<string, unknown> | undefined;
    for (let offset = 0; offset < media.bytes.length; offset += 384 * 1024) {
      const bytes = media.bytes.subarray(offset, offset + 384 * 1024);
      const reply = await host.rpc('team.attachment.upload', envelope(`${media.id}-upload-${offset}`, {
        uploadId: media.id, purpose: { kind: 'message', member },
        attachment: { id: media.id, filename: media.id, mimeType: media.mime, size: media.bytes.length },
        digest: sha(media.bytes), offset, base64: bytes.toString('base64'),
      }));
      assert.equal(reply.ok, true, JSON.stringify(reply));
      const result = row(reply.value);
      assert.equal(result.nextOffset, offset + bytes.length === media.bytes.length ? null : offset + bytes.length);
      if (result.reference) reference = row(result.reference);
    }
    assert.ok(reference); assert.equal(typeof reference.artifactId, 'string');
    assert.equal(reference.mimeType, media.mime); assert.equal(reference.byteLength, media.bytes.length);
    assert.equal(reference.digest, sha(media.bytes));
    references.push({ artifactId: String(reference.artifactId), mimeType: media.mime,
      byteLength: media.bytes.length, digest: sha(media.bytes) });
  }
  return { one: [references[4]!], two: references.filter((_, index) => index !== 4) };
}

export async function readNativeMessageMedia(host: Host, envelope: Envelope, receipts: Record<string, unknown>[]) {
  const original = await readNativeMessageImage(host, envelope, receipts[1]!);
  const result = [{ mime: 'image/png', sha256: original.sha256, byteLength: original.byteLength }];
  for (const media of extras) {
    const messageId = media.id === 'TEST-native-normalized'
      ? row(row(receipts[0]!.value).effects).messageId : original.messageId;
    assert.equal(typeof messageId, 'string');
    const chunks: Buffer[] = []; let offset = 0;
    while (offset < media.bytes.length) {
      const reply = await host.rpc('team.message.attachment.read', envelope(`${media.id}-read-${offset}`, {
        reference: messageId, attachmentId: media.id, offset, expectedSha256: sha(media.bytes),
      }));
      assert.equal(reply.ok, true); const value = row(reply.value), attachment = row(value.attachment);
      assert.equal(attachment.id, media.id); assert.equal(attachment.mimeType, media.mime);
      assert.equal(attachment.size, media.bytes.length); assert.equal(value.sha256, sha(media.bytes));
      assert.equal(value.offset, offset); assert.equal(typeof value.base64, 'string');
      const bytes = Buffer.from(String(value.base64), 'base64');
      assert.ok(bytes.length > 0 && offset + bytes.length <= media.bytes.length);
      chunks.push(bytes); offset += bytes.length;
      assert.equal(value.nextOffset, offset === media.bytes.length ? null : offset);
    }
    assert.deepEqual(Buffer.concat(chunks), media.bytes, 'original public bytes survive delivery and cold readback');
    result.push({ mime: media.mime, sha256: sha(media.bytes), byteLength: media.bytes.length });
  }
  return result;
}

function normalizedPixels(bytes: Buffer) {
  assert.ok(bytes.length < 32 * 1024);
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  let offset = 8, width = 0, channels = 0; const data: Buffer[] = [];
  while (offset < bytes.length) {
    assert.ok(offset + 12 <= bytes.length); const length = bytes.readUInt32BE(offset);
    assert.ok(offset + length + 12 <= bytes.length);
    const type = bytes.toString('ascii', offset + 4, offset + 8), part = bytes.subarray(offset + 8, offset + 8 + length);
    assert.equal(crc32(bytes.subarray(offset + 4, offset + 8 + length)), bytes.readUInt32BE(offset + 8 + length));
    if (type === 'IHDR') {
      assert.equal(offset, 8); assert.equal(part.length, 13); width = part.readUInt32BE(0);
      assert.equal(width, 2000); assert.equal(part.readUInt32BE(4), 1); assert.equal(part[8], 8);
      assert.ok(part[9] === 2 || part[9] === 6); channels = part[9] === 2 ? 3 : 4;
      assert.deepEqual(part.subarray(10), Buffer.from([0, 0, 0]));
    } else if (type === 'IDAT') data.push(part);
    else { assert.equal(type, 'IEND'); assert.equal(length, 0); assert.equal(offset + 12, bytes.length); }
    offset += length + 12;
  }
  assert.ok(channels && data.length);
  const scanline = inflateSync(Buffer.concat(data), { maxOutputLength: 1 + width * channels });
  assert.equal(scanline.length, 1 + width * channels); const filter = scanline[0]!;
  assert.ok(filter >= 0 && filter <= 4); const pixels = Buffer.alloc(width * channels);
  for (let i = 0; i < pixels.length; i++) {
    const left = i >= channels ? pixels[i - channels]! : 0;
    const predictor = filter === 1 || filter === 4 ? left : filter === 3 ? Math.floor(left / 2) : 0;
    pixels[i] = (scanline[i + 1]! + predictor) & 255;
    assert.equal(pixels[i], i % channels === 0 || channels === 4 && i % channels === 3 ? 255 : 0);
  }
}

/** Actual native API multipart payload: MIME-preserving small media, normalized PNG and exact PDF. */
export function assertNativeMessageMedia(messages: unknown[]) {
  const matching = messages.map(row).filter(message => message.role === 'user' && Array.isArray(message.content) &&
    message.content.some(raw => String(row(raw).text ?? '').includes('OPENCODE_TEAM_TWO')));
  assert.equal(matching.length, 1);
  const parts = (matching[0]!.content as unknown[]).map(row);
  const images = parts.filter(part => part.type === 'image_url'), documents = parts.filter(part => part.type === 'file');
  assert.equal(images.length, 4); assert.equal(documents.length, 1);
  assert.ok(parts.every(part => ['text', 'image_url', 'file'].includes(String(part.type))));
  assert.ok(parts.slice(0, parts.indexOf(images[0]!)).some(part => String(part.text ?? '').includes('OPENCODE_TEAM_TWO')));
  const expected = [{ mime: 'image/png', bytes: NATIVE_MESSAGE_PNG }, ...extras.slice(0, 3)];
  const imageFacts = images.map((image, index) => {
    const url = row(image.image_url).url; assert.equal(typeof url, 'string');
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(url));
    assert.ok(match); const bytes = Buffer.from(match[2]!, 'base64'); assert.equal(bytes.toString('base64'), match[2]);
    assert.equal(match[1], expected[index]!.mime);
    assert.deepEqual(bytes, expected[index]!.bytes);
    return { mime: match[1], originalSha256: sha(expected[index]!.bytes), nativeSha256: sha(bytes),
      originalBytes: expected[index]!.bytes.length, nativeBytes: bytes.length, normalized: false };
  });
  const first = messages.map(row).filter(message => message.role === 'user' && Array.isArray(message.content) &&
    message.content.some(raw => String(row(raw).text ?? '').includes('OPENCODE_TEAM_ONE')));
  assert.equal(first.length, 1);
  const normalized = (first[0]!.content as unknown[]).map(row).filter(part => part.type === 'image_url');
  assert.equal(normalized.length, 1);
  const nativeUrl = row(normalized[0]!.image_url).url;
  assert.ok(typeof nativeUrl === 'string' && nativeUrl.startsWith('data:image/png;base64,'));
  const nativeBytes = Buffer.from(nativeUrl.slice('data:image/png;base64,'.length), 'base64');
  normalizedPixels(nativeBytes); assert.notEqual(sha(nativeBytes), sha(extras[3].bytes));
  const normalization = { originalBytes: extras[3].bytes.length, originalSha256: sha(extras[3].bytes),
    nativeBytes: nativeBytes.length, nativeSha256: sha(nativeBytes), width: 2000, height: 1, exactRedPixels: true };
  const document = row(documents[0]!.file);
  assert.equal(document.file_data, 'data:application/pdf;base64,' + NATIVE_MESSAGE_PDF.toString('base64'));
  assert.ok(typeof document.filename === 'string' && document.filename.length > 0);
  return { images: imageFacts, normalization, pdf: { mime: 'application/pdf', sha256: sha(NATIVE_MESSAGE_PDF),
    byteLength: NATIVE_MESSAGE_PDF.length, exactBytes: true }, normalized: true };
}
