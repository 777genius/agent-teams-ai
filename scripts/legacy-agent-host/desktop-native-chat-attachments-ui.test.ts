import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertNativeChatAttachments, CHAT_PNG, CHAT_TEXT } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/chat-attachments.ts';
const input = () => [{ role: 'user', content: [
  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: CHAT_PNG } },
  { type: 'document', source: { type: 'text', media_type: 'text/plain', data: CHAT_TEXT } },
  { type: 'text', text: 'Message context: TEST\nNATIVE_TEAM_TWO' },
] }];
test('native attachment oracle accepts exact actual request blocks and refuses missing, altered MIME/bytes and duplicated input', () => {
  assertNativeChatAttachments(input());
  const missing = input(); missing[0]!.content.splice(0, 1);
  assert.throws(() => assertNativeChatAttachments(missing));
  for (const [key, value] of [['media_type', 'image/jpeg'], ['data', CHAT_PNG.slice(4)]] as const) {
    const tampered = input(); tampered[0]!.content[0]!.source![key] = value;
    assert.throws(() => assertNativeChatAttachments(tampered));
  }
  const document = input(); document[0]!.content[1]!.source!.data = 'TEST wrong bytes';
  assert.throws(() => assertNativeChatAttachments(document));
  assert.throws(() => assertNativeChatAttachments([...input(), ...input()]));
  const metadataOnly = [{ role: 'user', content: [{ type: 'text', text: 'NATIVE_TEAM_TWO TEST-native-chat.png' }] }];
  assert.throws(() => assertNativeChatAttachments(metadataOnly));
});
