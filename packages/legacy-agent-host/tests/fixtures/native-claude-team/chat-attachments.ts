import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { crc32, inflateSync } from 'node:zlib';
export const CHAT_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwHwQBEPgD/U6VwW8AAAAASUVORK5CYII=';
export const CHAT_TEXT = 'TEST native chat attachment exact bytes\n';
export const CHAT_PREPARED_IMAGE_NAME = 'TEST-native-chat.prepared.png';
export const CHAT_IMAGE_NAME = 'TEST-native-chat.png';
export const CHAT_FILE_NAME = 'TEST-native-chat.txt';
const row = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
/** Only this 2×1, noninterlaced RGBA fixture; SDKs may losslessly reencode its PNG. */
export function assertChatImagePixels(value: unknown): Buffer {
  assert.equal(typeof value, 'string');
  assert.ok(typeof value === 'string' && value.length <= 1368);
  const png = Buffer.from(value, 'base64');
  assert.equal(png.toString('base64'), value);
  assert.ok(png.length <= 1024);
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const compressed: Buffer[] = [];
  let offset = 8,
    header = false,
    ended = false;
  while (offset < png.length) {
    assert.ok(offset + 12 <= png.length);
    const length = png.readUInt32BE(offset);
    assert.ok(offset + length + 12 <= png.length);
    const type = png.toString('latin1', offset + 4, offset + 8);
    const payload = png.subarray(offset + 8, offset + 8 + length);
    assert.equal(
      crc32(png.subarray(offset + 4, offset + 8 + length)),
      png.readUInt32BE(offset + 8 + length)
    );
    if (!header) {
      assert.equal(type, 'IHDR');
      assert.deepEqual(payload, Buffer.from([0, 0, 0, 2, 0, 0, 0, 1, 8, 6, 0, 0, 0]));
      header = true;
    } else if (type === 'IDAT') {
      compressed.push(payload);
    } else {
      assert.equal(type, 'IEND', 'only fixture PNG header/data/end chunks');
      assert.equal(length, 0);
      assert.equal(offset + 12, png.length);
      ended = true;
    }
    offset += length + 12;
  }
  assert.ok(header && ended && compressed.length > 0);
  const scanline = inflateSync(Buffer.concat(compressed), { maxOutputLength: 9 });
  assert.equal(scanline.length, 9);
  const filter = scanline[0]!;
  assert.ok(filter >= 0 && filter <= 4, 'valid PNG scanline filter');
  const pixels = Buffer.alloc(8);
  // Height is exactly one: Up=0; Paeth(left,0,0)=left. Bytes per RGBA pixel=4.
  for (let i = 0; i < pixels.length; i++) {
    const left = i >= 4 ? pixels[i - 4]! : 0;
    const predictor = filter === 1 || filter === 4 ? left : filter === 3 ? Math.floor(left / 2) : 0;
    pixels[i] = (scanline[i + 1]! + predictor) & 255;
  }
  assert.deepEqual(
    pixels,
    Buffer.from([255, 0, 0, 255, 0, 255, 0, 255]),
    'exact opaque red/green fixture pixels'
  );
  return png;
}
/** Assert actual Anthropic request blocks; metadata or a filename is not native delivery proof. */
export function assertNativeChatAttachments(messages: unknown) {
  assert.ok(Array.isArray(messages));
  const matching = messages
    .map(row)
    .filter(
      (message) =>
        message.role === 'user' &&
        Array.isArray(message.content) &&
        message.content.some(
          (value) =>
            row(value).type === 'text' && String(row(value).text).includes('NATIVE_TEAM_TWO')
        )
    );
  assert.equal(matching.length, 1, 'one deliberate second human input');
  const blocks = (matching[0]!.content as unknown[]).map(row);
  const images = blocks.filter((block) => block.type === 'image');
  const documents = blocks.filter((block) => block.type === 'document');
  assert.equal(images.length, 1);
  assert.equal(documents.length, 1);
  const { data, ...encoding } = row(images[0]!.source);
  assert.deepEqual(encoding, { type: 'base64', media_type: 'image/png' });
  const png = assertChatImagePixels(data);
  assert.deepEqual(row(documents[0]!.source), {
    type: 'text',
    media_type: 'text/plain',
    data: CHAT_TEXT,
  });
  assert.ok(blocks.every((block) => ['text', 'image', 'document'].includes(String(block.type))));
  const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  return {
    image: {
      base64: png.toString('base64'),
      byteLength: png.length,
      digest: digest(png),
      mimeType: 'image/png',
      width: 2,
      height: 1,
    },
    document: {
      byteLength: Buffer.byteLength(CHAT_TEXT),
      digest: digest(Buffer.from(CHAT_TEXT)),
      mimeType: 'text/plain',
    },
  };
}
