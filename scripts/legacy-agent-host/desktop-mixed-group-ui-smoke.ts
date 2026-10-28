import {
  assertMixedInputAccounting,
  initialMixedBusinessTurns,
  mixedInputAccounting,
} from './desktop-mixed-input-proof.ts';
import { runtimeDigest } from '../../packages/legacy-agent-host/dist/runtime/identity.js';
import { readMixedCapturedPrincipal } from './desktop-mixed-native-fixture.ts';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { MIXED_GROUP_INPUT, MIXED_GROUP_REPLY, MIXED_GROUP_REPLY_ID } from '../../packages/legacy-agent-host/tests/fixtures/native-mixed-groups.ts';
import { createDesktopUiControls, desktopJsLiteral } from './desktop-ui-controls.ts';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';
import { revealDesktopReply } from './desktop-reply-visibility.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';
import type { DesktopMixedModels } from './desktop-mixed-native-fixture.ts';

type Row = Record<string, unknown>;
const row = (value: unknown): Row => { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Row; };
const rows = (value: unknown): Row[] => { assert.ok(Array.isArray(value)); return value.map(row); };
/** Extends the existing mixed Create/Launch run; no alternative form, setup API or native input path. */
export async function runDesktopMixedGroupUiSmoke(cdp: UiCdpPort, options: {
  root: string; teamName: string; models: DesktopMixedModels; launchId: unknown;
  assertOwnedRenderer(): void; step(value: Row): void;
}) {
  const ui = createDesktopUiControls(cdp, options);
  const teamRoot = join(options.root, 'hoststore/teams', options.teamName);
  const read = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'));
  await ui.scrollTo('button[aria-label="Back to chats"]', 'mixed Back to existing chat list');
  await ui.click('button[aria-label="Back to chats"]', 'mixed Back to existing chat list');
  await ui.click('[data-testid="group-chat-list"] button', 'original mixed group Create', 'Create group chat');
  const dialog = '[data-testid="create-group-chat-dialog"]';
  await ui.click(dialog + ' input[id^="group-name-"]', 'name original mixed group');
  await cdp.send('Input.insertText', { text: 'TEST-mixed-group' });
  await ui.waitRead(`document.querySelector(${desktopJsLiteral(dialog + ' input[id^="group-name-"]')})?.value==='TEST-mixed-group'`, 'mixed group name retained');
  for (const name of ['team-lead', 'bob', 'carol'])
    assert.equal(await cdp.evaluate(`document.querySelector(${desktopJsLiteral(dialog + ' [role="checkbox"][aria-label="' + name + '"]')})?.getAttribute('data-state')`), 'checked');
  await ui.click(dialog + ' [role="checkbox"][id^="group-auto-"]', 'fixed original mixed group membership');
  await ui.click(dialog + ' button', 'Create original mixed group once', 'Create group chat');
  await ui.waitRead(`!document.querySelector(${desktopJsLiteral(dialog)})`, 'mixed group creation saved');
  const groups = rows(row(await read(join(teamRoot, 'group-chats.json'))).groups);
  assert.equal(groups.length, 1);
  const group = groups[0]!;
  assert.equal(group.name, 'TEST-mixed-group');
  assert.deepEqual(group.membership, { kind: 'fixed', memberNames: ['bob', 'carol', 'team-lead'] });
  const composer = '[data-testid="group-chat-composer"]';
  await ui.click(composer + ' .message-composer-recipient-selector', 'mixed directed recipient selector');
  await ui.click('[data-radix-popper-content-wrapper] button span.font-medium', 'exact mixed Bob recipient', 'bob');
  await ui.waitRead(`document.querySelector(${desktopJsLiteral(composer + ' .message-composer-recipient-selector')})?.textContent.trim()==='bob'`, 'mixed Bob recipient retained');
  await ui.click(composer + ' textarea', 'original mixed group Composer');
  await cdp.send('Input.insertText', { text: MIXED_GROUP_INPUT });
  await ui.waitRead(`document.querySelector(${desktopJsLiteral(composer + ' textarea')})?.value===${desktopJsLiteral(MIXED_GROUP_INPUT)}`, 'mixed group input retained');
  await ui.click(composer + ' button.message-composer-send-button', 'send original directed mixed group once', 'Send');
  await ui.waitRead(`document.querySelector(${desktopJsLiteral(composer + ' textarea')})?.value===''&&document.body.innerText.includes(${desktopJsLiteral(MIXED_GROUP_REPLY)})`, 'mixed native group reply visible', 90_000);
  await revealDesktopReply(cdp, MIXED_GROUP_REPLY, options);
  const until = Date.now() + 90_000;
  let sessions: Row[] = [];
  while (Date.now() < until) {
    options.assertOwnedRenderer();
    for (const model of [options.models.claude, options.models.codex, options.models.opencode]) assert.deepEqual(model.failures, []);
    sessions = (await readDesktopNativeStopSessions(options.root)).filter(value => row(value.binding).runId === options.launchId);
    if (mixedInputAccounting(options.root, sessions, options.models, initialMixedBusinessTurns).ready) break;
    await new Promise<void>(resolve => setTimeout(resolve, 100));
  }
  assert.equal(sessions.length, 3);
  const inputAccounting = assertMixedInputAccounting(options.root, sessions, options.models, initialMixedBusinessTurns);
  assert.deepEqual([options.models.claude, options.models.codex, options.models.opencode].map(model => model.observations.length), [10, 12, 10]);
  const reactions = rows(row(await read(join(teamRoot, 'group-chat-reactions.json'))).entries);
  const logical = rows(await read(join(teamRoot, 'inboxes/user.json'))).filter(message => message.groupChatId === group.id && message.messageId === message.groupMessageId);
  assert.equal(logical.length, 2);
  const human = logical.find(message => message.text === MIXED_GROUP_INPUT)!;
  const reply = logical.find(message => message.messageId === MIXED_GROUP_REPLY_ID)!;
  assert.ok(human && reply);
  assert.equal(human.from, 'user');
  assert.deepEqual(human.groupRecipientNames, ['bob']);
  assert.equal(reply.from, 'bob');
  assert.equal(reply.text, MIXED_GROUP_REPLY);
  assert.deepEqual(rows(reactions.find(value => value.messageId === human.messageId)!.actors).map(actor => actor.name), ['bob']);
  assert.deepEqual(rows(reactions.find(value => value.messageId === reply.messageId)!.actors).map(actor => actor.name).sort(), ['carol', 'team-lead']);
  assert.deepEqual([...(reply.groupRecipientNames as string[])].sort(), ['carol', 'team-lead']);
  const commands = await Promise.all((await readdir(join(teamRoot, '.host-owner/commands'))).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(async name => row(await read(join(teamRoot, '.host-owner/commands', name)))));
  const groupCommands = commands.filter(value => value.family === 'group-chat');
  const sends = groupCommands.filter(value => row(value.request).operation === 'send');
  assert.equal(sends.length, 2);
  assert.ok(groupCommands.every(value => value.phase === 'completed'));
  for (const [actor, provider] of [['team-lead', 'claude'], ['bob', 'codex'], ['carol', 'opencode']] as const) {
    const ack = groupCommands.filter(value => value.commandId === 'TEST-mixed-group-ack-' + actor);
    assert.equal(ack.length, 1);
    assert.equal(ack[0]!.principalId, readMixedCapturedPrincipal(options.root, provider));
    assert.equal(row(ack[0]!.request).operation, 'reaction.ack');
  }
  const nativeSends = sends.filter(value => value.commandId === 'TEST-mixed-group-reply');
  assert.equal(nativeSends.length, 1);
  assert.equal(nativeSends[0]!.principalId, readMixedCapturedPrincipal(options.root, 'codex'));
  const inputProofs: Row[] = [];
  for (const source of sends) {
    const logicalId = row(source.request).messageId;
    for (const delivery of rows(source.deliveries)) {
      const recipient = row(delivery.recipient), binding = row(recipient.binding);
      const physical = rows(await read(join(teamRoot, 'inboxes', String(recipient.name) + '.json'))).filter(message => message.messageId === recipient.physicalMessageId);
      assert.equal(physical.length, 1);
      assert.equal(physical[0]!.groupMessageId, logicalId);
      const direct = commands.filter(value => value.commandId === recipient.commandId);
      assert.equal(direct.length, 1);
      assert.equal(direct[0]!.phase, 'completed');
      const deliveryId = String(row(direct[0]!.effects).deliveryId);
      const outbox = row(await read(join(teamRoot, '.host-owner/outbox', deliveryId + '.json')));
      assert.equal(outbox.phase, 'admitted');
      assert.deepEqual(outbox.binding, binding);
      const selected = sessions.find(value => row(value.binding).memberId === binding.memberId && row(value.binding).generation === binding.generation)!;
      assert.ok(selected);
      const runKey = 'host-group-v1:' + runtimeDigest({ binding, config: selected.config, sessionRef: selected.sessionRef });
      assert.equal(physical[0]!.groupRunKey, runKey);
      const logicalMessage = logical.find(message => message.messageId === logicalId)!;
      assert.ok(logicalMessage);
      assert.equal(row(logicalMessage.groupRecipientRunKeys)[String(recipient.name)], runKey);
      const ack = reactions.find(value => value.messageId === logicalId)!;
      const actor = rows(ack.actors).find(value => value.name === recipient.name)!;
      assert.ok(actor);
      assert.equal(actor.inboxMessageId, recipient.physicalMessageId);
      assert.equal(actor.groupRunKey, runKey);
      const input = rows(selected.inputs).filter(value => row(value.intent).inputId === deliveryId);
      assert.equal(input.length, 1);
      assert.equal(row(input[0]!.intent).messageId, recipient.physicalMessageId);
      inputProofs.push({ sourceCommandId: source.commandId, recipient, physical: physical[0], outbox, input: input[0] });
    }
  }
  assert.equal(inputProofs.length, 3);
  return { status: 'PASS', inputAccounting, group, logical, reactions, groupCommands, inputProofs, sessions,
    expectedObservations: [10, 12, 10], scope: 'Existing mixed Create group/directed Codex Send/native Bob ACK+reply/Claude and OpenCode ACK; exact input and inbox/outbox identity. No new restart or natural Quit claim.' };
}
