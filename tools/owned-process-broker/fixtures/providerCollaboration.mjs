/** Closed TEST scripts. Authenticated MCP owns all product effects and original input authority. */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';

assert.equal(process.env.TEST_EMULATED_DESKTOP_PROVIDER, '1');
assert.equal(process.env.TEST_DESKTOP_COLLABORATION, 'mixed-v1');
export const collaborationMember = process.env.TEST_DESKTOP_COLLABORATION_MEMBER;
assert.ok(['alice', 'bob', 'carol'].includes(collaborationMember));
assert.equal(collaborationMember, { claude: 'alice', codex: 'bob', opencode: 'carol' }[process.env.TEST_PEER_PROVIDER]);
export const collaborationMarkers = ['TEST_UI_COLLAB_DM', 'TEST_UI_COLLAB_WORK', 'TEST_UI_COLLAB_RESTORE',
  'TEST_UI_COLLAB_ATTACH', 'TEST_UI_COLLAB_GROUP', 'TEST_UI_COLLAB_GROUP_REPLY'];
const record = value => { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value; };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** Exact bytes observed at the original Claude input boundary, after the real Composer optimizer. */
export function verifyCollaborationAttachments(content) {
  assert.equal(collaborationMember, 'alice'); assert.ok(Array.isArray(content));
  assert.ok(content.every(row => ['text', 'image', 'document'].includes(record(row).type)));
  const images = content.filter(row => row.type === 'image'), documents = content.filter(row => row.type === 'document');
  assert.equal(images.length, 1); assert.equal(documents.length, 1);
  const image = record(images[0].source), document = record(documents[0].source);
  assert.deepEqual(Object.keys(image).sort(), ['data', 'media_type', 'type']);
  assert.equal(image.type, 'base64'); assert.equal(image.media_type, 'image/png');
  assert.equal(typeof image.data, 'string'); assert.ok(image.data.length <= 1368);
  const bytes = Buffer.from(image.data, 'base64'); assert.equal(bytes.toString('base64'), image.data);
  const path = join(dirname(process.env.TEST_DESKTOP_PEER_ROOT), 'native-chat-attachment-inputs', 'TEST-native-chat.prepared.png');
  const stat = lstatSync(path); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 1024);
  assert.equal(realpathSync(path), path); assert.deepEqual(bytes, readFileSync(path));
  assert.deepEqual(document, { type: 'text', media_type: 'text/plain', data: 'TEST native chat attachment exact bytes\n' });
  return { image: { sha256: digest(bytes), size: bytes.length, mimeType: 'image/png' },
    document: { sha256: digest(document.data), size: Buffer.byteLength(document.data), mimeType: 'text/plain' } };
}

export async function runCollaboration({ marker, raw, inputId, mcp, tools, current, effect, attachments }) {
  assert.ok(collaborationMarkers.includes(marker)); assert.ok(mcp);
  assert.equal(typeof raw, 'string'); assert.ok(Buffer.byteLength(raw) <= 65536);
  assert.equal(typeof inputId, 'string'); assert.ok(inputId.length <= 128);
  const command = suffix => `TEST-collab-${collaborationMember}-${process.pid}-${inputId}-${suffix}`;
  const call = async (name, args) => {
    current(); const declared = tools.filter(row => row.name === name); assert.equal(declared.length, 1);
    const properties = record(record(declared[0].inputSchema).properties);
    assert.ok(Object.keys(args).every(key => Object.hasOwn(properties, key)), 'only advertised arguments');
    const reply = await mcp.callTool({ name, arguments: args }); current();
    assert.notEqual(reply.isError, true); assert.ok(Array.isArray(reply.content) && reply.content.length === 1);
    assert.equal(reply.content[0].type, 'text'); assert.ok(Buffer.byteLength(reply.content[0].text) <= 256 * 1024);
    const result = JSON.parse(reply.content[0].text);
    if (args.commandId) {
      assert.equal(record(result).commandId, args.commandId); assert.equal(result.phase, 'completed');
    }
    effect({ event: 'collaboration-call', marker, inputId, memberName: collaborationMember, name,
      ...(args.commandId ? { commandId: args.commandId } : {}) });
    return result;
  };
  if (marker === 'TEST_UI_COLLAB_DM') {
    assert.equal(collaborationMember, 'bob');
    await call('message_send', { commandId: command('dispatch'), to: 'carol', text: 'TEST_UI_COLLAB_WORK' });
    return 'TEST direct work sent';
  }
  if (marker === 'TEST_UI_COLLAB_WORK' || marker === 'TEST_UI_COLLAB_RESTORE') {
    assert.equal(collaborationMember, 'carol');
    const text = marker === 'TEST_UI_COLLAB_WORK' ? 'TEST collaboration Carol reply' : 'TEST collaboration Carol restored';
    await call('message_send', { commandId: command('reply'), to: 'user', text });
    return text;
  }
  if (marker === 'TEST_UI_COLLAB_ATTACH') {
    assert.equal(collaborationMember, 'alice'); assert.ok(attachments);
    effect({ event: 'collaboration-attachments', marker, inputId, memberName: collaborationMember, ...attachments });
    return 'TEST collaboration attachments received';
  }
  const matches = [...raw.matchAll(/Group context: (\{[^\n]+\})/g)]; assert.equal(matches.length, 1);
  const context = record(JSON.parse(matches[0][1]));
  assert.equal(context.to, collaborationMember); assert.equal(context.text, marker);
  assert.equal(context.groupChatProtocolVersion, 1);
  assert.match(context.groupChatId, /^[a-f0-9-]{36}$/);
  assert.match(context.messageId, /^[a-f0-9-]{36}:g:[a-f0-9]{24}$/); assert.notEqual(context.messageId, context.groupMessageId);
  assert.match(context.groupRunKey, /^host-group-v1:[a-f0-9]{64}$/);
  assert.equal(record(context.groupRecipientRunKeys)[collaborationMember], context.groupRunKey);
  if (marker === 'TEST_UI_COLLAB_GROUP') {
    assert.equal(collaborationMember, 'bob'); assert.equal(context.from, 'user'); assert.equal(context.source, 'user_sent');
    const listed = await call('group_chat_list', {});
    const groups = Array.isArray(listed) ? listed : record(listed).groups;
    assert.ok(Array.isArray(groups) && groups.filter(row => row.id === context.groupChatId).length === 1);
  } else {
    assert.ok(collaborationMember === 'alice' || collaborationMember === 'carol');
    assert.equal(context.from, 'bob'); assert.equal(context.source, 'runtime_delivery');
  }
  await call('group_chat_react', { commandId: command('ack'), groupChatId: context.groupChatId, relayOfMessageId: context.messageId });
  if (marker === 'TEST_UI_COLLAB_GROUP') await call('group_chat_send', { commandId: command('group-reply'),
    messageId: randomUUID(), groupChatId: context.groupChatId, text: 'TEST_UI_COLLAB_GROUP_REPLY', relayOfMessageId: context.messageId });
  effect({ event: 'collaboration-group', marker, inputId, memberName: collaborationMember,
    groupChatId: context.groupChatId, messageId: context.messageId, groupMessageId: context.groupMessageId, groupRunKey: context.groupRunKey });
  return marker === 'TEST_UI_COLLAB_GROUP' ? 'TEST group reply sent' : 'TEST group acknowledged';
}
