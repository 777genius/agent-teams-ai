import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  GROUP_INPUT,
  GROUP_REPLY,
  GROUP_REPLY_ID,
} from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/group-chat.ts';
import { runtimeDigest } from '../../packages/legacy-agent-host/dist/runtime/identity.js';
import { fileDigest } from './desktop-backend-fixture.ts';
import { createDesktopUiControls, desktopJsLiteral } from './desktop-ui-controls.ts';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';
import { revealDesktopReply } from './desktop-reply-visibility.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';
import type { startNativeTeamModel } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts';
type Row = Record<string, unknown>;
const row = (value: unknown): Row => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Row;
};
const rows = (value: unknown): Row[] => {
  assert.ok(Array.isArray(value));
  return value.map(row);
};

/** Existing group controls only. Setup/SDK ownership comes from native-conversation-ui. */
export async function runDesktopNativeGroupUiSmoke(
  cdp: UiCdpPort,
  options: {
    root: string;
    seed: { taskId: string; subject: string; commandId: string };
    evidence: Row;
    assertOwnedRenderer(): void;
    nativeStop: { assertNativeAbsent(): void };
    model: Awaited<ReturnType<typeof startNativeTeamModel>>;
  }
): Promise<void> {
  const nativeRequests = options.model.groupRequests;
  assert.ok(nativeRequests, 'explicit finite native group script selected');
  const steps: Row[] = [],
    snapshots: Row[] = [];
  const proof: Row = {
    status: 'INCOMPLETE',
    steps,
    snapshots,
    scope:
      'Existing group Create/directed Send/native source-create/ACK/reply/Bob ACK, human reaction/archive/reload/restore and ordinary Stop of both actors',
    excluded: [
      'ordinary Launch UI',
      'cold app restart',
      'vendor authentication/inference',
      'Stage2',
      'full Stage1',
    ],
  };
  options.evidence.groupChatUiProof = proof;
  const step = (value: Row) => steps.push(value);
  const ui = createDesktopUiControls(cdp, {
    assertOwnedRenderer: options.assertOwnedRenderer,
    step,
  });
  const team = join(options.root, 'hoststore/teams/test-desktop-backend');
  const read = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'));
  const commands = async () => {
    const directory = join(team, '.host-owner/commands');
    const files = (await readdir(directory)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
    assert.ok(files.length <= 128);
    return Promise.all(files.map(async (name) => row(await read(join(directory, name)))));
  };
  const groups = async () => rows(row(await read(join(team, 'group-chats.json'))).groups);
  const inbox = async (name: string) => rows(await read(join(team, 'inboxes', name + '.json')));
  const reactions = async () =>
    rows(row(await read(join(team, 'group-chat-reactions.json'))).entries);
  const poll = async <T>(
    get: () => Promise<T>,
    accepts: (value: T) => boolean,
    label: string
  ): Promise<T> => {
    const until = Date.now() + 60_000;
    let value = await get();
    while (!accepts(value) && Date.now() < until) {
      assert.deepEqual(options.model.failures, [], 'finite localhost model fails closed');
      await new Promise<void>((done) => setTimeout(done, 100));
      value = await get();
    }
    assert.ok(accepts(value), label);
    return value;
  };
  const sessionsBefore = await readDesktopNativeStopSessions(options.root);
  assert.equal(sessionsBefore.length, 2);
  assert.deepEqual(sessionsBefore.map((session) => row(session.binding).memberId).sort(), [
    'alice-id',
    'bob-id',
  ]);
  assert.ok(
    sessionsBefore.every(
      (session) =>
        session.phase === 'allocated' &&
        session.custody === 'owned' &&
        session.nativeReady === true &&
        rows(session.inputs).length === 0
    )
  );
  proof.runtimeBeforeInput = sessionsBefore;
  await ui.observeInput();
  await ui.clickSidebar(options.seed.subject);
  await ui.click(
    '[data-testid="group-chat-list"] button',
    'open existing group Create',
    'Create group chat'
  );
  const dialog = '[data-testid="create-group-chat-dialog"]';
  await ui.waitRead(
    `Boolean(document.querySelector(${desktopJsLiteral(dialog + ' input[id^="group-name-"]')}))`,
    'existing group name input'
  );
  await ui.click(dialog + ' input[id^="group-name-"]', 'name original UI group');
  await cdp.send('Input.insertText', { text: 'TEST-ui-group' });
  await ui.waitRead(
    `document.querySelector(${desktopJsLiteral(dialog + ' input[id^="group-name-"]')})?.value==='TEST-ui-group'`,
    'original UI group name retained'
  );
  for (const name of ['alice', 'bob'])
    assert.equal(
      await cdp.evaluate(
        `document.querySelector(${desktopJsLiteral(dialog + ' [role="checkbox"][aria-label="' + name + '"]')})?.getAttribute('data-state')`
      ),
      'checked'
    );
  await ui.click(
    dialog + ' [role="checkbox"][id^="group-auto-"]',
    'select original fixed membership'
  );
  await ui.click(dialog + ' button', 'create original UI group once', 'Create group chat');
  await ui.waitRead(
    `!document.querySelector(${desktopJsLiteral(dialog)})`,
    'group Create closes after saved result'
  );
  const uiGroups = await groups();
  assert.equal(uiGroups.length, 1);
  const group = uiGroups[0]!;
  assert.equal(group.name, 'TEST-ui-group');
  assert.deepEqual(group.membership, { kind: 'fixed', memberNames: ['alice', 'bob'] });
  assert.equal(group.archivedAt, null);
  const groupId = String(group.id);
  const composer = '[data-testid="group-chat-composer"]';
  const back = 'button[aria-label="Back to chats"]';
  const showList = async (label: string) => {
    await ui.scrollTo(back, label);
    await ui.click(back, label);
    await ui.waitRead(
      `Boolean(document.querySelector('[data-testid="group-chat-list"]'))&&!document.querySelector(${desktopJsLiteral(composer)})`,
      label + ' list visible'
    );
  };
  const observeGroupRow = async (id: string, name: string, archived: boolean, label: string) => {
    const selector = '[data-group-chat-id=' + JSON.stringify(id) + ']';
    await ui.waitRead(
      `(() => {const rows=[...document.querySelectorAll(${desktopJsLiteral(selector)})];return rows.length===1&&rows[0].getAttribute('data-archived')===${desktopJsLiteral(String(archived))}&&[...rows[0].querySelectorAll('span')].some(e=>e.textContent.trim()===${desktopJsLiteral(name)});})()`,
      label
    );
    return selector;
  };
  const openOriginalGroup = async (archived: boolean, label: string) => {
    const selector = await observeGroupRow(groupId, String(group.name), archived, label + ' exact canonical row');
    await ui.scrollTo(selector, label);
    await ui.click(selector, label);
    await ui.waitRead(
      `(() => {const titles=[...document.querySelectorAll('span.text-sm')].filter(e=>e.textContent.trim()===${desktopJsLiteral(group.name)}&&e.getBoundingClientRect().width>0);return titles.length===1&&Boolean(document.querySelector(${desktopJsLiteral(composer)}))&&Boolean(document.querySelector(${desktopJsLiteral(back)}))&&!document.querySelector('[data-testid="group-chat-list"]');})()`,
      label + ' exact group header and Composer'
    );
  };
  await showList('Back after original UI group Create');
  await openOriginalGroup(false, 'open original canonical UI-created group');
  await ui.click(
    composer + ' .message-composer-recipient-selector',
    'open existing group recipient selector'
  );
  await ui.click(
    '[data-radix-popper-content-wrapper] button span.font-medium',
    'select exact live Alice recipient',
    'alice'
  );
  await ui.waitRead(
    `document.querySelector(${desktopJsLiteral(composer + ' .message-composer-recipient-selector')})?.textContent.trim()==='alice'`,
    'original directed Alice recipient'
  );
  await ui.click(
    composer + ' textarea[aria-label="Message this group"]',
    'focus existing group Composer'
  );
  await cdp.send('Input.insertText', { text: GROUP_INPUT });
  await ui.waitRead(
    `document.querySelector(${desktopJsLiteral(composer + ' textarea')})?.value===${desktopJsLiteral(GROUP_INPUT)}`,
    'original human group text retained'
  );
  await ui.click(
    composer + ' button.message-composer-send-button',
    'Send original directed group message once',
    'Send'
  );
  await ui.waitRead(
    `document.querySelector(${desktopJsLiteral(composer + ' textarea')})?.value===''`,
    'group Composer clears after admitted original Send'
  );
  const settled = await poll(
    () => readDesktopNativeStopSessions(options.root),
    (sessions) =>
      sessions.length === 2 &&
      sessions.every(
        (session) =>
          rows(session.inputs).length === 1 &&
          rows(session.inputs).every(
            (input) => input.phase === 'terminal' && input.terminal === 'succeeded'
          )
      ),
    'one successful actual native input per group actor'
  );
  assert.deepEqual(options.model.failures, []);
  assert.equal(nativeRequests.length, 7);
  assert.equal(nativeRequests.filter((request) => request.memberName === 'alice').length, 5);
  assert.equal(nativeRequests.filter((request) => request.memberName === 'bob').length, 2);
  const all = await commands(),
    groupCommands = all.filter((command) => command.family === 'group-chat');
  const humanSends = groupCommands.filter(
    (command) =>
      command.principalId === 'TEST-human' &&
      row(command.request).operation === 'send' &&
      row(command.request).text === GROUP_INPUT
  );
  assert.equal(humanSends.length, 1);
  const human = humanSends[0]!,
    humanRequest = row(human.request),
    humanId = String(humanRequest.messageId);
  assert.equal(human.phase, 'completed');
  assert.equal(human.actor, 'user');
  assert.equal(humanRequest.recipientName, 'alice');
  assert.equal(humanRequest.groupChatId, groupId);
  const humanDeliveries = rows(human.deliveries);
  assert.equal(humanDeliveries.length, 1);
  assert.equal(row(humanDeliveries[0]!.recipient).name, 'alice');
  const logical = (await inbox('user')).filter(
    (message) => message.groupChatId === groupId && message.messageId === message.groupMessageId
  );
  assert.equal(logical.length, 2);
  const original = logical.find((message) => message.messageId === humanId)!;
  const reply = logical.find((message) => message.messageId === GROUP_REPLY_ID)!;
  assert.ok(original && reply);
  assert.equal(original.text, GROUP_INPUT);
  assert.equal(original.source, 'user_sent');
  assert.deepEqual(original.groupRecipientNames, ['alice']);
  assert.equal(reply.from, 'alice');
  assert.equal(reply.text, GROUP_REPLY);
  assert.deepEqual(reply.groupRecipientNames, ['bob']);
  const nativeCreate = groupCommands.find(
    (command) => command.commandId === 'TEST-native-group-create'
  )!;
  const nativeReply = groupCommands.find(
    (command) => command.commandId === 'TEST-native-group-reply'
  )!;
  assert.ok(nativeCreate && nativeReply);
  for (const [id, principal, operation] of [
    ['TEST-native-group-create', 'alice-session', 'create.agent'],
    ['TEST-native-group-ack-alice', 'alice-session', 'reaction.ack'],
    ['TEST-native-group-reply', 'alice-session', 'send'],
    ['TEST-native-group-ack-bob', 'bob-session', 'reaction.ack'],
  ]) {
    const receipts = groupCommands.filter((command) => command.commandId === id);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]!.principalId, principal);
    assert.equal(receipts[0]!.phase, 'completed');
    assert.equal(row(receipts[0]!.request).operation, operation);
  }
  assert.equal(row(nativeCreate.request).sourceMessageId, humanId);
  const nativeGroup = (await groups()).find((value) => value.name === 'TEST-native-created-group')!;
  assert.ok(nativeGroup);
  assert.equal(row(nativeGroup.agentCreation).sourceMessageId, humanId);
  await showList('Back to observe native-created group');
  await observeGroupRow(String(nativeGroup.id), String(nativeGroup.name), false,
    'exact source-authorized native-created group appears in existing list');
  await openOriginalGroup(false, 'return to original group conversation');
  assert.deepEqual(row(nativeGroup.agentCreation).recipientNames, ['alice']);
  assert.equal(row(nativeReply.request).messageId, GROUP_REPLY_ID);
  const inputProofs: Row[] = [];
  for (const [source, member, logicalMessage] of [
    [human, 'alice', original],
    [nativeReply, 'bob', reply],
  ] as const) {
    const deliveries = rows(source.deliveries);
    assert.equal(deliveries.length, 1);
    const recipient = row(deliveries[0]!.recipient),
      binding = row(recipient.binding);
    assert.equal(recipient.name, member);
    assert.equal(binding.memberId, member + '-id');
    const physical = (await inbox(member)).filter(
      (message) => message.messageId === recipient.physicalMessageId
    );
    assert.equal(physical.length, 1);
    assert.equal(physical[0]!.groupMessageId, logicalMessage.messageId);
    assert.equal(physical[0]!.groupRunKey, row(logicalMessage.groupRecipientRunKeys)[member]);
    const direct = all.filter((command) => command.commandId === recipient.commandId);
    assert.equal(direct.length, 1);
    assert.equal(direct[0]!.phase, 'completed');
    const command = row(direct[0]!.command),
      payload = row(command.payload);
    assert.equal(command.operation, 'message.send');
    assert.equal(payload.to, member);
    const capturedGroup = row(direct[0]!.group);
    assert.equal(capturedGroup.sourceCommandId, source.commandId);
    assert.equal(row(capturedGroup.message).messageId, recipient.physicalMessageId);
    const deliveryId = String(row(direct[0]!.effects).deliveryId);
    const outbox = row(await read(join(team, '.host-owner/outbox', deliveryId + '.json')));
    assert.equal(outbox.phase, 'admitted');
    assert.equal(outbox.messageId, recipient.physicalMessageId);
    assert.deepEqual(outbox.binding, binding);
    const session = settled.find((value) => row(value.binding).memberId === binding.memberId)!;
    assert.ok(session);
    assert.equal(session.sessionRef === undefined, false);
    assert.equal(row(session.binding).generation, binding.generation);
    assert.equal(row(session.binding).runId, binding.runId);
    const nativeInput = rows(session.inputs)[0]!;
    assert.equal(row(nativeInput.intent).inputId, deliveryId);
    assert.equal(row(nativeInput.intent).messageId, recipient.physicalMessageId);
    const currentRun =
      'host-group-v1:' +
      runtimeDigest({ binding, config: session.config, sessionRef: session.sessionRef });
    assert.equal(physical[0]!.groupRunKey, currentRun);
    const observed = nativeRequests.filter((value) => value.memberName === member);
    assert.ok(
      observed.every(
        (value) =>
          value.physicalMessageId === recipient.physicalMessageId &&
          value.logicalMessageId === logicalMessage.messageId &&
          value.groupRunKey === currentRun
      )
    );
    inputProofs.push({
      member,
      source,
      recipient,
      physical: physical[0],
      direct: direct[0],
      outbox,
      nativeInput,
      currentRun,
    });
  }
  assert.equal(reply.relayOfMessageId, row(humanDeliveries[0]!.recipient).physicalMessageId);
  const beforeReactions = await reactions();
  const aliceAck = beforeReactions.find((value) => value.messageId === humanId)!,
    bobAck = beforeReactions.find((value) => value.messageId === GROUP_REPLY_ID)!;
  assert.ok(aliceAck && bobAck);
  assert.deepEqual(
    rows(aliceAck.actors).map((actor) => actor.name),
    ['alice']
  );
  assert.deepEqual(
    rows(bobAck.actors).map((actor) => actor.name),
    ['bob']
  );
  assert.equal(
    rows(aliceAck.actors)[0]!.inboxMessageId,
    row(humanDeliveries[0]!.recipient).physicalMessageId
  );
  assert.equal(
    rows(bobAck.actors)[0]!.inboxMessageId,
    row(rows(nativeReply.deliveries)[0]!.recipient).physicalMessageId
  );
  for (const [member, ack] of [
    ['alice', aliceAck],
    ['bob', bobAck],
  ] as const)
    assert.equal(
      rows(ack.actors)[0]!.groupRunKey,
      inputProofs.find((value) => value.member === member)!.currentRun
    );
  proof.inputProofs = inputProofs;
  proof.nativeCreate = nativeCreate;
  proof.reactionsBeforeHuman = beforeReactions;
  const revealReply = async () => {
    await ui.waitRead(
      `document.body.innerText.includes(${desktopJsLiteral(GROUP_REPLY)})`,
      'exact native reply in existing group history'
    );
    const visible = row(
      await revealDesktopReply(cdp, GROUP_REPLY, {
        assertOwnedRenderer: options.assertOwnedRenderer,
        step,
      })
    );
    const rect = row(visible.rect);
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Number(rect.x) + Number(rect.width) / 2,
      y: Number(rect.y) + Number(rect.height) / 2,
    });
    const key = String(
      await ui.waitRead(
        `(() => {const rows=[...document.querySelectorAll('[data-timeline-row-key]')].filter(e=>[...e.querySelectorAll('p')].some(p=>p.textContent.trim()===${desktopJsLiteral(GROUP_REPLY)}));return rows.length===1&&rows[0].getAttribute('data-timeline-row-key');})()`,
        'exact original reply row key'
      )
    );
    return (
      '[data-timeline-row-key=' + JSON.stringify(key) + '] [data-group-message-reaction] button'
    );
  };
  const reaction = await revealReply();
  await ui.click(reaction, 'add original human reaction once');
  await ui.waitRead(
    `document.querySelector(${desktopJsLiteral(reaction)})?.getAttribute('aria-pressed')==='true'`,
    'human reaction visible'
  );
  const humanReaction = (await reactions()).find((value) => value.messageId === GROUP_REPLY_ID)!;
  assert.deepEqual(
    rows(humanReaction.actors)
      .map((actor) => actor.name)
      .sort(),
    ['bob', 'user']
  );
  const user = rows(humanReaction.actors).find((actor) => actor.name === 'user')!;
  assert.equal(user.inboxMessageId, undefined);
  assert.equal(user.groupRunKey, undefined);
  assert.deepEqual(
    rows(humanReaction.actors).find((actor) => actor.name === 'bob'),
    rows(bobAck.actors)[0]
  );
  await ui.click('button[aria-label="Archive chat"]', 'archive original group once');
  await ui.waitRead(
    `Boolean(document.querySelector('button[aria-label="Restore chat"]'))&&document.querySelector(${desktopJsLiteral(composer + ' textarea')})?.readOnly===true`,
    'original open group archived and read-only'
  );
  const archived = (await groups()).find((value) => value.id === groupId)!;
  assert.ok(archived.archivedAt);
  snapshots.push({ phase: 'archived', groups: await groups(), reactions: await reactions() });
  await showList('Back to observe original archived group');
  await observeGroupRow(groupId, String(group.name), true, 'exact original archived group list row');
  const origin = await cdp.evaluate('performance.timeOrigin');
  await cdp.send('Page.reload', { ignoreCache: false });
  await ui.waitRead(
    `performance.timeOrigin!==${desktopJsLiteral(origin)}&&window.__claudeTeamsUiDidInit===true`,
    'same profile renderer reload only'
  );
  await ui.observeInput();
  await ui.clickSidebar(options.seed.subject);
  await openOriginalGroup(true, 'open exact archived group after reload');
  await ui.waitRead(
    `document.querySelector(${desktopJsLiteral(composer + ' textarea')})?.readOnly===true`,
    'archived group remains read-only'
  );
  const reloadedReaction = await revealReply();
  await ui.waitRead(
    `document.querySelector(${desktopJsLiteral(reloadedReaction)})?.getAttribute('aria-pressed')==='true'`,
    'saved human reaction survives renderer reload'
  );
  assert.deepEqual(
    (await groups()).find((value) => value.id === groupId),
    archived
  );
  await ui.click('button[aria-label="Restore chat"]', 'restore original group once');
  await ui.waitRead(
    `Boolean(document.querySelector('button[aria-label="Archive chat"]'))&&document.querySelector(${desktopJsLiteral(composer + ' textarea')})?.readOnly===false`,
    'original open group restored and writable'
  );
  assert.equal((await groups()).find((value) => value.id === groupId)!.archivedAt, null);
  snapshots.push({ phase: 'restored', groups: await groups(), reactions: await reactions() });
  await showList('Back to observe original restored group');
  await openOriginalGroup(false, 'return to exact restored original group');
  await ui.click(await revealReply(), 'remove original human reaction once');
  const retainedAck = await poll(
    reactions,
    (entries) =>
      rows(entries.find((value) => value.messageId === GROUP_REPLY_ID)!.actors).length === 1,
    'human reaction removed independently'
  );
  assert.deepEqual(
    retainedAck.find((value) => value.messageId === GROUP_REPLY_ID),
    bobAck
  );
  assert.equal(
    nativeRequests.length,
    7,
    'catalog/reaction/archive/read reload cannot send another model input'
  );
  const screenshot = row(
    await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  );
  const path = join(options.root, 'ui-native-group-chat.png');
  await writeFile(path, Buffer.from(String(screenshot.data), 'base64'), {
    mode: 0o600,
    flag: 'wx',
  });
  proof.screenshot = { path, sha256: await fileDigest(path) };
  await ui.scrollTo('button[aria-label="Stop"]', 'original Stop for both captured actors');
  await ui.click(
    'button[aria-label="Stop"]',
    'Stop both original native group actors once',
    'Stop'
  );
  const closed = await poll(
    () => readDesktopNativeStopSessions(options.root),
    (sessions) =>
      sessions.length === 2 &&
      sessions.every((session) => session.phase === 'closed' && session.custody === 'released'),
    'both native sessions released before Quit'
  );
  options.nativeStop.assertNativeAbsent();
  assert.deepEqual(options.model.failures, []);
  proof.closedSessions = closed;
  proof.nativeRequests = nativeRequests;
  proof.status = 'PASS';
}
