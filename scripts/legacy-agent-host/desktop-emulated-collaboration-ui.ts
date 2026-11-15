import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { runtimeDigest } from '../../packages/legacy-agent-host/dist/runtime/identity.js';
import { processFacts } from '../../packages/legacy-agent-host/tests/fixtures/native-input-capture.ts';
import { fileDigest } from './desktop-backend-fixture.ts';
import { createDesktopUiControls, desktopJsLiteral as literal } from './desktop-ui-controls.ts';
import { record, rows } from './desktop-resume-records.ts';
import { prepareNativeChatAttachments, verifyNativeChatAttachmentMessage } from './desktop-native-chat-attachments-ui.ts';
import { revealDesktopReply } from './desktop-reply-visibility.ts';
import { readDesktopEmulatedCollaborationEffects, verifyDesktopEmulatedCollaborationFixture } from './desktop-emulated-collaboration-fixture.ts';
import { array, createCollaborationRecords, observeCollaborationPeers, one, runtimeOrigin } from './desktop-emulated-collaboration-records.ts';
import type { DesktopEmulatedCollaborationFixture } from './desktop-emulated-collaboration-fixture.ts';
import type { Row } from './desktop-emulated-collaboration-records.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';

/** Ordinary renderer controls own every business mutation; finite peers use the original advertised MCP. */
export async function runDesktopEmulatedCollaborationUi(cdp: UiCdpPort, options: {
  fixture: DesktopEmulatedCollaborationFixture; evidence: Row; assertOwnedRenderer(): void;
}) {
  const { fixture } = options, steps: Row[] = [], records = createCollaborationRecords(fixture);
  const proof: Row = { status: 'INCOMPLETE', providers: ['claude', 'codex', 'opencode'], execution: 'finite-protocol-peers',
    scope: 'Original saved Launch, live Add/Remove/Restore, cross-member DM, direct image/text attachments, group Send/ACK/reply, Stop and read-only renderer reload',
    nativeQualification: false, groupAttachments: 'Unavailable in the original group Composer and Host send contract', steps };
  options.evidence.emulatedCollaborationUiProof = proof;
  const ui = createDesktopUiControls(cdp, { assertOwnedRenderer: options.assertOwnedRenderer, step: value => steps.push(value) });
  const effects = () => readDesktopEmulatedCollaborationEffects(fixture);
  const poll = async <T>(read: () => Promise<T>, accepts: (value: T) => boolean, label: string) => {
    const deadline = performance.now() + 75_000;
    const current = () => assert.ok(performance.now() < deadline, label + '; the original action is never repeated');
    for (;;) {
      current(); options.assertOwnedRenderer(); await effects(); current();
      const value = await read(); current(); if (accepts(value)) return value;
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(100, deadline - performance.now())));
    }
  };
  const fill = async (selector: string, value: string) => {
    await ui.scrollTo(selector, 'original collaboration input'); await ui.click(selector, 'focus original collaboration input');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA',
      modifiers: process.platform === 'darwin' ? 4 : 2, commands: ['selectAll'] });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' });
    await cdp.send('Input.insertText', { text: value });
    await ui.waitRead(`document.querySelector(${literal(selector)})?.value===${literal(value)}`, 'exact original collaboration input');
  };
  const visible = (text: string) => ui.waitRead(`document.body.innerText.includes(${literal(text)})`, 'original visible ' + text, 60_000);
  const screenshot = async (name: string) => {
    const image = record(await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }));
    assert.equal(typeof image.data, 'string'); const path = join(fixture.root, `ui-emulated-collaboration-${name}.png`);
    await writeFile(path, Buffer.from(String(image.data), 'base64'), { mode: 0o600, flag: 'wx' });
    return { path, sha256: await fileDigest(path) };
  };
  const back = async () => {
    if (await cdp.evaluate(`Boolean(document.querySelector('button[aria-label="Back to chats"]'))`)) {
      await ui.scrollTo('button[aria-label="Back to chats"]', 'original Back to chats');
      await ui.click('button[aria-label="Back to chats"]', 'original Back to chats');
    }
  };
  const openMember = async (member: string) => {
    assert.ok(['alice', 'bob', 'carol'].includes(member)); await back();
    const selector = `button[aria-label^=${literal(member + ',')}]`;
    await ui.scrollTo(selector, 'original ' + member + ' conversation'); await ui.click(selector, 'open original ' + member + ' conversation');
  };
  const commandText = (row: Row) => row.command && record(row.command).operation === 'message.send'
    ? record(record(row.command).payload).text : undefined;
  const observeSent = async (before: Set<unknown>, text: string) => {
    const entries = await poll(records.commands, values => values.some(row => !before.has(row.commandId) &&
      commandText(row) === text && row.phase === 'completed'), 'one original direct message receipt');
    return one(entries, row => !before.has(row.commandId) && commandText(row) === text);
  };
  const send = async (text: string) => {
    const before = new Set((await records.commands()).map(row => row.commandId));
    await fill('.message-composer-flat-layout textarea', text);
    await ui.click('button.message-composer-send-button', 'send original direct message once', 'Send');
    return observeSent(before, text);
  };
  await ui.observeInput(); await ui.clickSidebar(fixture.uiSeed.subject);
  await ui.click('button', 'open original saved Team Launch', 'Launch');
  const settings = record(await ui.waitRead(`(()=>{const rows=[...document.querySelectorAll('[role="dialog"] button[aria-controls]')]
    .filter(e=>e.textContent.includes('Optional launch settings')&&e.textContent.includes('sonnet'));
    return rows.length===1?{id:rows[0].getAttribute('aria-controls'),expanded:rows[0].getAttribute('aria-expanded')}:null})()`, 'saved launch settings hydrate'));
  if (settings.expanded !== 'true') await ui.click(`[role="dialog"] button[aria-controls=${literal(settings.id)}]`, 'expand original saved launch settings');
  await fill('[role="dialog"] #dialog-prompt', 'TEST_UI_BOOT');
  assert.equal(await cdp.evaluate(`document.querySelector('[role="dialog"] #dialog-skip-permissions')?.getAttribute('data-state')`), 'unchecked');
  await ui.scrollTo('[role="dialog"] button', 'original Launch team', 'Launch team');
  await ui.waitRead(`[...document.querySelectorAll('[role="dialog"] button')].some(e=>e.textContent.trim()==='Launch team'&&!e.disabled)`, 'original mixed launch preflight', 90_000);
  assert.equal(array((await records.owner()).runtimeCaptures ?? []).length, 0);
  await ui.click('[role="dialog"] button', 'launch original two-member team once', 'Launch team');
  await ui.waitRead(`!document.querySelector('[role="dialog"] #dialog-prompt')`, 'original Launch dialog closes', 60_000);
  const launched = await poll(records.owner, value => array(value.runtimeCaptures ?? []).length === 1, 'one original launch capture');
  const capture = array(launched.runtimeCaptures)[0]!, launchId = capture.launchId;
  assert.equal(record(launched.savedSettings).prompt, 'TEST_UI_BOOT');
  const sessions = () => records.sessions(launchId);
  const completedInputs = (value: Row, count: number) => array(value.inputs).length === count &&
    array(value.inputs).every(row => row.phase === 'terminal' && row.terminal === 'succeeded');
  const byMember = (selected: Row[], memberId: unknown) => one(selected, row => record(row.binding).memberId === memberId);
  const initial = await poll(async () => sessions().catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error;
  }), values => values.length === 2 && values.every(row => row.phase === 'allocated' && row.custody === 'owned' && row.nativeReady === true) &&
    completedInputs(byMember(values, 'alice-id'), 1) && completedInputs(byMember(values, 'bob-id'), 0), 'initial original ready sessions');
  const initialPhysical = await observeCollaborationPeers(fixture, ['claude', 'codex']);
  const initialPrincipals = Object.fromEntries(array(capture.members).map(row => [String(row.memberId), row.principalId]));
  await openMember('alice'); await visible('TEST boot ready');
  proof.initial = { capture, sessions: initial, physical: [...initialPhysical], screenshot: await screenshot('launch') };
  const unchangedPeers = async (snapshot: Row[], physical: Awaited<ReturnType<typeof observeCollaborationPeers>>) => {
    const current = await sessions();
    for (const [provider, memberId] of [['claude', 'alice-id'], ['codex', 'bob-id']] as const) {
      const after = byMember(current, memberId), before = byMember(snapshot, memberId);
      assert.deepEqual(runtimeOrigin(after), runtimeOrigin(before)); assert.deepEqual(after.inputs, before.inputs);
      for (const key of ['phase', 'custody', 'nativeReady']) assert.equal(after[key], before[key]);
      assert.deepEqual(physical.get(provider), initialPhysical.get(provider));
    }
  };
  const membershipAfter = async (before: Row, kind: 'add' | 'remove' | 'restore') => {
    const prior = new Set(array(before.rosterCommands ?? []).map(row => row.commandId));
    const state = await poll(records.owner, value => array(value.rosterCommands ?? []).some(row =>
      !prior.has(row.commandId) && row.liveMembership && record(row.liveMembership).phase === 'completed'), 'original live ' + kind + ' completes');
    const receipt = one(array(state.rosterCommands), row => !prior.has(row.commandId));
    assert.equal(record(record(receipt.liveMembership).delta).kind, kind); assert.equal(record(receipt.liveMembership).launchId, launchId);
    return { state, receipt, memberId: record(record(receipt.liveMembership).delta).targetId };
  };
  const liveReady = async (change: Awaited<ReturnType<typeof membershipAfter>>, kind: 'add' | 'restore') => {
    const delivery = record(record(record(change.receipt.liveMembership).selection).delivery);
    await poll(sessions, values => values.some(row => record(row.binding).memberId === change.memberId &&
      record(row.binding).generation === delivery.generation && row.phase === 'allocated' && row.custody === 'owned' && row.nativeReady === true), 'new original live generation ready');
    const result = await records.membership(change.receipt.commandId, kind, launchId);
    const physical = await observeCollaborationPeers(fixture, ['claude', 'codex', 'opencode']);
    const peer = physical.get('opencode')!;
    const nativeSession = one(await effects(), row => row.event === 'collaboration-session' && row.pid === peer.pid);
    assert.equal(nativeSession.memberId, change.memberId);
    return { ...result, physical: peer, nativeSession, allPhysical: physical };
  };
  await back(); const beforeAdd = await records.owner();
  await ui.scrollTo('[data-section-id="team"] button[aria-label="Add"]', 'original Add Members control');
  await ui.click('[data-section-id="team"] button[aria-label="Add"]', 'open original Add Members');
  await fill('[role="dialog"] input[aria-label="Member 1 name"]', 'carol');
  const picker = '[role="dialog"] button[aria-label*=" provider,"]';
  await ui.scrollTo(picker, 'original new member model selector'); await ui.click(picker, 'expand original member model selector');
  const local = '[role="dialog"] [data-testid="team-model-selector-provider-nav-local-models"]';
  await ui.scrollTo(local, 'original Local models'); await ui.click(local, 'select original Local models');
  const model = '[role="dialog"] [data-testid="team-model-selector-model-option"][aria-label^="TEST-model"]';
  await ui.scrollTo(model, 'configured original OpenCode model'); await ui.click(model, 'select original OpenCode model');
  const beforeLiveProbes = (await effects()).filter(row => row.provider === 'opencode' && row.event === 'input' && row.marker === 'TEST_MODEL_PROBE');
  assert.deepEqual(beforeLiveProbes, [], 'passive inventory does not execute model input');
  await ui.scrollTo('[role="dialog"] > div:last-child > button', 'original Add submit', 'Add member');
  await ui.click('[role="dialog"] > div:last-child > button', 'add original Carol once', 'Add member');
  const added = await membershipAfter(beforeAdd, 'add');
  await ui.waitRead(`!document.querySelector('[role="dialog"] input[aria-label="Member 1 name"]')`, 'original Add dialog closes');
  const addedReady = await liveReady(added, 'add');
  assert.deepEqual(record(addedReady.member.settings).providerId, 'opencode');
  assert.equal(record(addedReady.member.settings).model, 'test-provider/TEST-model');
  await unchangedPeers(initial, addedReady.allPhysical);
  assert.equal((await effects()).filter(row => row.provider === 'opencode' && row.event === 'input' && row.marker === 'TEST_MODEL_PROBE').length, 1);
  proof.added = { ...addedReady, allPhysical: [...addedReady.allPhysical] };
  await openMember('bob'); const directReceipt = await send('TEST_UI_COLLAB_DM');
  const directSessions = await poll(sessions, values => completedInputs(byMember(values, 'bob-id'), 1) &&
    completedInputs(byMember(values, added.memberId), 1), 'cross-member original input completion');
  const direct = await records.delivery(directReceipt, directSessions), directCommands = await records.commands();
  assert.equal(directReceipt.principalId, 'TEST-human');
  const dispatched = one(directCommands, row => commandText(row) === 'TEST_UI_COLLAB_WORK');
  assert.equal(dispatched.principalId, initialPrincipals['bob-id']);
  const delivered = await records.delivery(dispatched, directSessions);
  assert.equal(record(record(delivered.input.intent).binding).memberId, added.memberId);
  const reply = one(directCommands, row => commandText(row) === 'TEST collaboration Carol reply');
  assert.equal(reply.principalId, addedReady.selection.principalId); assert.equal(reply.phase, 'completed');
  await openMember('carol'); await visible('TEST collaboration Carol reply');
  proof.direct = { direct, dispatched: delivered, reply, screenshot: await screenshot('direct') };

  await openMember('alice'); const attachmentBefore = new Set((await records.commands()).map(row => row.commandId));
  await fill('.message-composer-flat-layout textarea', 'TEST_UI_COLLAB_ATTACH');
  const attachmentOptions = { root: fixture.root, evidence: options.evidence, finite: 'collaboration-v1' as const,
    assertOwnedRenderer: options.assertOwnedRenderer, step: (value: Row) => steps.push(value) };
  const verifyAttachments = await prepareNativeChatAttachments(cdp, attachmentOptions);
  await ui.click('button.message-composer-send-button', 'send original attachments once', 'Send');
  const attachmentReceipt = await observeSent(attachmentBefore, 'TEST_UI_COLLAB_ATTACH');
  const attachmentSessions = await poll(sessions, values => completedInputs(byMember(values, 'alice-id'), 2), 'original attachment input terminal');
  const attachmentDelivery = await records.delivery(attachmentReceipt, attachmentSessions);
  const attachmentMessageId = String(attachmentDelivery.physical.messageId);
  await visible('TEST collaboration attachments received'); await verifyAttachments(attachmentMessageId);
  const observedBytes = one(await effects(), row => row.event === 'collaboration-attachments');
  const attachmentProof = record(options.evidence.nativeChatAttachments);
  for (const key of ['sha256', 'size', 'mimeType'])
    assert.equal(record(observedBytes.image)[key], record(attachmentProof.preparedImage)[key]);
  const textFile = one(array(attachmentProof.files), row => row.mimeType === 'text/plain');
  for (const key of ['sha256', 'size', 'mimeType']) assert.equal(record(observedBytes.document)[key], textFile[key]);
  proof.attachments = { delivery: attachmentDelivery, observedBytes, screenshot: await screenshot('attachments') };

  await back(); await ui.click('[data-testid="group-chat-list"] button', 'original Create group chat', 'Create group chat');
  const dialog = '[data-testid="create-group-chat-dialog"]';
  await fill(dialog + ' input[id^="group-name-"]', 'TEST-finite-collaboration');
  for (const member of ['alice', 'bob', 'carol']) assert.equal(await cdp.evaluate(
    `document.querySelector(${literal(dialog + ' [role="checkbox"][aria-label="' + member + '"]')})?.getAttribute('data-state')`), 'checked');
  await ui.click(dialog + ' [role="checkbox"][id^="group-auto-"]', 'fixed original group membership');
  await ui.click(dialog + ' button', 'create original group once', 'Create group chat');
  await ui.waitRead(`!document.querySelector(${literal(dialog)})`, 'original group saved');
  const group = one(await records.groups(), row => row.name === 'TEST-finite-collaboration');
  assert.equal(record(group.membership).kind, 'fixed');
  const groupNames = record(group.membership).memberNames; assert.ok(Array.isArray(groupNames));
  assert.deepEqual([...groupNames].sort(), ['alice', 'bob', 'carol']);
  const composer = '[data-testid="group-chat-composer"]';
  assert.equal(await cdp.evaluate(`document.querySelectorAll(${literal(composer + ' input[type="file"]')}).length`), 0);
  await ui.click(composer + ' .message-composer-recipient-selector', 'original group directed recipient');
  await ui.click('[data-radix-popper-content-wrapper] button span.font-medium', 'original Bob group recipient', 'bob');
  await ui.waitRead(`document.querySelector(${literal(composer + ' .message-composer-recipient-selector')})?.textContent.trim()==='bob'`, 'exact group recipient retained');
  await fill(composer + ' textarea', 'TEST_UI_COLLAB_GROUP');
  await ui.click(composer + ' button.message-composer-send-button', 'send original directed group once', 'Send');
  await visible('TEST_UI_COLLAB_GROUP_REPLY');
  await poll(sessions, values => completedInputs(byMember(values, 'alice-id'), 3) && completedInputs(byMember(values, 'bob-id'), 2) &&
    completedInputs(byMember(values, added.memberId), 2), 'three original physical group inputs finish');
  const groupProof = await records.group(group.id, launchId);
  const principalByName: Row = { alice: initialPrincipals['alice-id'], bob: initialPrincipals['bob-id'], carol: addedReady.selection.principalId };
  const collaborationCalls = (await effects()).filter(row => row.event === 'collaboration-call' && row.commandId);
  const completedCommands = await records.commands();
  for (const call of collaborationCalls) {
    const receipt = one(completedCommands, row => row.commandId === call.commandId);
    assert.equal(receipt.phase, 'completed'); assert.equal(receipt.principalId, principalByName[String(call.memberName)]);
  }
  const groupsObserved = (await effects()).filter(row => row.event === 'collaboration-group'); assert.equal(groupsObserved.length, 3);
  for (const received of groupsObserved) assert.ok(groupProof.deliveries.some(value => value.physical.messageId === received.messageId &&
    value.physical.groupMessageId === received.groupMessageId && value.physical.groupRunKey === received.groupRunKey));
  await revealDesktopReply(cdp, 'TEST_UI_COLLAB_GROUP_REPLY', { assertOwnedRenderer: options.assertOwnedRenderer, step: value => steps.push(value) });
  proof.group = { ...groupProof, calls: collaborationCalls, observedInputs: groupsObserved, screenshot: await screenshot('group') };

  const beforeRemoveSessions = await sessions(); await back(); const beforeRemove = await records.owner();
  await ui.scrollTo('[data-section-id="team"] [role="button"] span.font-medium', 'original Carol detail', 'carol');
  await ui.click('[data-section-id="team"] [role="button"] span.font-medium', 'open original Carol detail', 'carol');
  await ui.click('[role="dialog"] button', 'request original Carol removal once', 'Remove');
  const confirmation = await ui.waitRead(`(()=>{const dialogs=[...document.querySelectorAll('[role="dialog"]')].filter(node=>
    node.querySelector('h2')?.textContent.trim()==='Remove member'&&node.textContent.includes('Tasks and messages will be preserved'));
    return dialogs.length===1&&dialogs[0].id||null})()`, 'original Remove member confirmation');
  assert.equal(typeof confirmation, 'string');
  await ui.click(`[role="dialog"][id=${literal(confirmation)}] > div:last-child > button`, 'confirm original Carol removal once', 'Remove');
  const removed = await membershipAfter(beforeRemove, 'remove'); assert.equal(removed.memberId, added.memberId);
  const tombstone = one(array(removed.state.removedMembers), row => row.memberId === added.memberId);
  assert.deepEqual(tombstone.settings, addedReady.member.settings); assert.ok(tombstone.removedAt);
  assert.equal(array(removed.state.members).length, 2);
  const oldGrant = one(array(removed.state.grants), row => row.principalId === addedReady.selection.principalId); assert.equal(oldGrant.revoked, true);
  const removedSessions = await poll(sessions, values => values.some(row => runtimeDigest(row.binding) === runtimeDigest(addedReady.binding) &&
    row.phase === 'closed' && row.custody === 'released'), 'original Carol generation released');
  await poll(async () => processFacts(), values => !values.some(row => row.pid === addedReady.physical.pid), 'original Carol process absent');
  await unchangedPeers(beforeRemoveSessions, await observeCollaborationPeers(fixture, ['claude', 'codex']));
  const oldSession = one(removedSessions, row => runtimeDigest(row.binding) === runtimeDigest(addedReady.binding));
  assert.deepEqual(oldSession.inputs, byMember(beforeRemoveSessions, added.memberId).inputs);
  proof.removed = { receipt: removed.receipt, member: tombstone, oldGrant, session: oldSession, originalProcessAbsent: true };
  const restore = '[data-section-id="team"] button[aria-label="Restore teammate"]';
  await ui.waitRead(`(()=>{const controls=[...document.querySelectorAll(${literal(restore)})];return controls.length===1&&
    controls[0].closest('[role="button"]')?.querySelector('span.font-medium')?.textContent.trim()==='carol'})()`, 'Restore belongs to original Carol');
  const beforeRestore = await records.owner();
  await ui.scrollTo(restore, 'original Carol Restore'); await ui.click(restore, 'restore original Carol once');
  const restored = await membershipAfter(beforeRestore, 'restore'); assert.equal(restored.memberId, added.memberId);
  assert.equal(array(restored.state.removedMembers).length, 0); assert.equal(array(restored.state.members).length, 3);
  const restoredReady = await liveReady(restored, 'restore');
  assert.deepEqual(restoredReady.member.settings, addedReady.member.settings);
  assert.notEqual(restoredReady.selection.principalId, addedReady.selection.principalId);
  assert.notEqual(restoredReady.binding.generation, addedReady.binding.generation);
  assert.notEqual(record(restoredReady.session.config).generation, record(addedReady.session.config).generation);
  assert.notEqual(restoredReady.session.sessionRef, addedReady.session.sessionRef);
  assert.notEqual(restoredReady.physical.pid, addedReady.physical.pid);
  await unchangedPeers(beforeRemoveSessions, restoredReady.allPhysical);
  assert.equal((await effects()).filter(row => row.provider === 'opencode' && row.event === 'input' && row.marker === 'TEST_MODEL_PROBE').length, 2);
  await openMember('carol'); const restoredReceipt = await send('TEST_UI_COLLAB_RESTORE');
  const restoreSessions = await poll(sessions, values => values.some(row => runtimeDigest(row.binding) === runtimeDigest(restoredReady.binding) && completedInputs(row, 1)), 'restored original input terminal');
  const restoredReply = one(await records.commands(), row => commandText(row) === 'TEST collaboration Carol restored');
  assert.equal(restoredReply.phase, 'completed'); assert.equal(restoredReply.principalId, restoredReady.selection.principalId);
  assert.deepEqual(one(restoreSessions, row => runtimeDigest(row.binding) === runtimeDigest(addedReady.binding)), oldSession);
  await unchangedPeers(beforeRemoveSessions, await observeCollaborationPeers(fixture, ['claude', 'codex', 'opencode']));
  await visible('TEST collaboration Carol restored');
  proof.restored = { ...restoredReady, allPhysical: [...restoredReady.allPhysical], reply: restoredReply,
    delivery: await records.delivery(restoredReceipt, restoreSessions), screenshot: await screenshot('restored') };

  await ui.scrollTo('button[aria-label="Stop"]', 'original whole Team Stop');
  await ui.click('button[aria-label="Stop"]', 'stop original whole team once', 'Stop');
  const stopped = await poll(sessions, values => values.length === 4 && values.every(row => row.phase === 'closed' && row.custody === 'released'), 'all four original generations released');
  assert.deepEqual(stopped.map(row => array(row.inputs).length).sort(), [1, 2, 2, 3]);
  assert.ok(stopped.every(row => array(row.inputs).every(input => input.phase === 'terminal' && input.terminal === 'succeeded')));
  const originalBirths = [...initialPhysical.values(), addedReady.physical, restoredReady.physical];
  await poll(async () => processFacts(), values => originalBirths.every(birth => !values.some(row => row.pid === birth.pid)), 'all original Runtime processes absent');
  await observeCollaborationPeers(fixture, []);
  proof.stopped = { sessions: stopped, originalBirths, originalProcessesAbsent: true, screenshot: await screenshot('stopped') };
  const snapshot = async () => ({ owner: await records.owner(), commands: await records.commands(), sessions: await sessions(),
    launch: await records.launch(launchId), groups: await records.groups(), reactions: await records.reactions(),
    probes: (await rows(join(fixture.root, 'hoststore/management-commands'))).filter(row => row.kind === 'model.probe'),
    inputsAndCalls: (await effects()).filter(row => ['input', 'collaboration-call', 'collaboration-session', 'connected', 'mcp-connected'].includes(String(row.event))) });
  const beforeReload = await snapshot(), timeOrigin = await cdp.evaluate('performance.timeOrigin');
  await cdp.send('Page.reload', { ignoreCache: true });
  await ui.waitRead(`performance.timeOrigin!==${literal(timeOrigin)}&&document.readyState==='complete'`, 'original renderer reloaded');
  await ui.observeInput(); await ui.clickSidebar(fixture.uiSeed.subject); await openMember('carol');
  await visible('TEST collaboration Carol restored'); await visible('TEST collaboration Carol reply');
  await openMember('alice'); await visible('TEST_UI_COLLAB_ATTACH');
  await verifyNativeChatAttachmentMessage(cdp, { ...attachmentOptions, messageId: attachmentMessageId, finiteReadback: true });
  await back();
  const groupButton = `[data-testid="group-chat-list"] button[data-group-chat-id=${literal(group.id)}]`;
  await ui.scrollTo(groupButton, 'original retained group'); await ui.click(groupButton, 'open original retained group');
  await visible('TEST_UI_COLLAB_GROUP_REPLY');
  assert.deepEqual(await snapshot(), beforeReload, 'read-only history reload cannot launch, deliver, probe, acknowledge or mutate original receipts');
  await observeCollaborationPeers(fixture, []);
  proof.reload = { historyRetained: true, noEffects: true, screenshot: await screenshot('reloaded') };
  proof.effects = await effects(); proof.fixturePins = await verifyDesktopEmulatedCollaborationFixture(fixture);
  await writeFile(join(fixture.root, 'ui-emulated-collaboration-effects.json'), JSON.stringify(proof.effects, null, 2), { mode: 0o600, flag: 'wx' });
  proof.status = 'PASS'; proof.visualReview = 'Original screenshot files require independent inspection';
}
