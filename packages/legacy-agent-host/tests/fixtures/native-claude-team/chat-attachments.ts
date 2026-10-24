import assert from 'node:assert/strict';
export const CHAT_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwHwQBEPgD/U6VwW8AAAAASUVORK5CYII=';
export const CHAT_TEXT = 'TEST native chat attachment exact bytes\n';
export const CHAT_IMAGE_NAME = 'TEST-native-chat.png';
export const CHAT_FILE_NAME = 'TEST-native-chat.txt';
const row = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
/** Assert actual Anthropic request blocks; metadata or a filename is not native delivery proof. */
export function assertNativeChatAttachments(messages: unknown): void {
  assert.ok(Array.isArray(messages));
  const matching = messages.map(row).filter(message => message.role === 'user' && Array.isArray(message.content) &&
    message.content.some(value => row(value).type === 'text' && String(row(value).text).includes('NATIVE_TEAM_TWO')));
  assert.equal(matching.length, 1, 'one deliberate second human input');
  const blocks = (matching[0]!.content as unknown[]).map(row);
  const images = blocks.filter(block => block.type === 'image');
  const documents = blocks.filter(block => block.type === 'document');
  assert.equal(images.length, 1); assert.equal(documents.length, 1);
  assert.deepEqual(row(images[0]!.source), { type: 'base64', media_type: 'image/png', data: CHAT_PNG });
  assert.deepEqual(row(documents[0]!.source), { type: 'text', media_type: 'text/plain', data: CHAT_TEXT });
  assert.ok(blocks.every(block => ['text', 'image', 'document'].includes(String(block.type))));
}
