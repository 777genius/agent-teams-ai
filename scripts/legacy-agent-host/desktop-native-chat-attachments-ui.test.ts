import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import {
  assertNativeChatAttachments,
  CHAT_PNG,
  CHAT_TEXT,
} from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/chat-attachments.ts';
const input = () => [
  {
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: CHAT_PNG } },
      { type: 'document', source: { type: 'text', media_type: 'text/plain', data: CHAT_TEXT } },
      { type: 'text', text: 'Message context: TEST\nNATIVE_TEAM_TWO' },
    ],
  },
];
test('native attachment oracle accepts exact actual request blocks and refuses missing, altered MIME/content and duplicated input', () => {
  assertNativeChatAttachments(input());
  const missing = input();
  missing[0]!.content.splice(0, 1);
  assert.throws(() => assertNativeChatAttachments(missing));
  for (const [key, value] of [
    ['media_type', 'image/jpeg'],
    ['data', CHAT_PNG.slice(4)],
  ] as const) {
    const tampered = input();
    tampered[0]!.content[0]!.source![key] = value;
    assert.throws(() => assertNativeChatAttachments(tampered));
  }
  const document = input();
  document[0]!.content[1]!.source!.data = 'TEST wrong bytes';
  assert.throws(() => assertNativeChatAttachments(document));
  assert.throws(() => assertNativeChatAttachments([...input(), ...input()]));
  const metadataOnly = [
    { role: 'user', content: [{ type: 'text', text: 'NATIVE_TEAM_TWO TEST-native-chat.png' }] },
  ];
  assert.throws(() => assertNativeChatAttachments(metadataOnly));
});

// Actual Chat2 SDK request, retained before this oracle correction: different compression/filter.
const SDK_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAD0lEQVR4AWL6z8DwHwQBAAAA//9Sl3jWAAAABklEQVQDABEKA/9Vf2IMAAAAAElFTkSuQmCC';
function withImage(data: string) {
  const request = input();
  request[0]!.content[0]!.source!.data = data;
  return request;
}
function chunk(type: string, payload: Buffer) {
  const result = Buffer.alloc(payload.length + 12);
  result.writeUInt32BE(payload.length, 0);
  result.write(type, 4, 'ascii');
  payload.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, 8 + payload.length)), 8 + payload.length);
  return result;
}
function png(scanline: number[], header = [0, 0, 0, 2, 0, 0, 0, 1, 8, 6, 0, 0, 0]) {
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', Buffer.from(header)),
    chunk('IDAT', deflateSync(Buffer.from(scanline))),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}
test('native oracle accepts original and actual SDK lossless encoding with exact red/green RGBA content', () => {
  assert.notEqual(SDK_PNG, CHAT_PNG);
  assertNativeChatAttachments(withImage(CHAT_PNG));
  const actual = assertNativeChatAttachments(withImage(SDK_PNG));
  assert.deepEqual(actual.image, {
    base64: SDK_PNG,
    byteLength: 90,
    digest: '43d614f0bc1b36ec2da1effa16b34498a3a62922caff5fd38238990423c50d49',
    mimeType: 'image/png',
    width: 2,
    height: 1,
  });
  // Independently specified first-row PNG encodings for each valid filter.
  for (const scanline of [
    [0, 255, 0, 0, 255, 0, 255, 0, 255],
    [1, 255, 0, 0, 255, 1, 255, 0, 0],
    [2, 255, 0, 0, 255, 0, 255, 0, 255],
    [3, 255, 0, 0, 255, 129, 255, 0, 128],
    [4, 255, 0, 0, 255, 1, 255, 0, 0],
  ])
    assertNativeChatAttachments(withImage(png(scanline)));
});
test('native oracle rejects wrong full pixels, dimensions, RGBA depth, filter, CRC and inflated bounds', () => {
  const exact = [0, 255, 0, 0, 255, 0, 255, 0, 255];
  for (const changed of [
    png([0, 255, 0, 0, 255, 255, 0, 0, 255]), // valid PNG with two red pixels
    png(exact, [0, 0, 0, 1, 0, 0, 0, 2, 8, 6, 0, 0, 0]),
    png(exact, [0, 0, 0, 2, 0, 0, 0, 1, 16, 6, 0, 0, 0]),
    png([5, ...exact.slice(1)]),
    png([...exact, 0]),
  ])
    assert.throws(() => assertNativeChatAttachments(withImage(changed)));
  const badCrc = Buffer.from(CHAT_PNG, 'base64');
  badCrc[29] = badCrc[29]! ^ 1;
  assert.throws(() => assertNativeChatAttachments(withImage(badCrc.toString('base64'))));
  assert.throws(() => assertNativeChatAttachments(withImage(CHAT_PNG + 'AAAA')));
  assert.throws(() => assertNativeChatAttachments(withImage('A'.repeat(1372))));
});
