import assert from 'node:assert/strict';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileDigest } from './desktop-backend-fixture.ts';
import { groupMembers, processTable } from './desktop-backend-observations.ts';
import { observeDesktopEmulatedRuntimeCleanup, readDesktopEmulatedRuntimeEffects, verifyDesktopEmulatedRuntimeFixture } from './desktop-emulated-runtime-fixture.ts';
import { lifecycleRows, readEmulatedClaudeCheckpoint, readEmulatedLifecycleProduct, readEmulatedLifecycleSessions } from './desktop-emulated-lifecycle-records.ts';
import { json, jsonDigest, record, rows } from './desktop-resume-records.ts';
import { createDesktopUiControls, desktopJsLiteral as literal } from './desktop-ui-controls.ts';
import type { EmulatedLifecycleFixture, EmulatedLifecycleRow as Row } from './desktop-emulated-lifecycle-records.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';

/** Every launch, restoration and input is submitted by the existing renderer controls. */
export async function runDesktopEmulatedLifecycleUi(initialCdp: UiCdpPort, options: {
  fixture: EmulatedLifecycleFixture; evidence: Row; assertOwnedRenderer(): void;
  restartSameProfile(): Promise<UiCdpPort>;
}) {
  const { fixture, evidence } = options;
  assert.equal(fixture.emulatedRuntime.provider, 'claude'); assert.equal(fixture.emulatedRuntime.variant, 'lifecycle');
  let cdp = initialCdp;
  const steps: Row[] = [], commands: Row[] = [];
  const proof: Row = { status: 'INCOMPLETE', provider: 'claude', steps, commands, nativeQualification: false,
    scope: 'Original Launch/Stop, full same-profile cold startup, explicit checkpoint Resume, Composer continuation and active/queued Quit with finite SDK peer',
    excluded: ['vendor inference/authentication', 'native provider qualification', 'automatic app.relaunch'] };
  evidence.emulatedLifecycleUiProof = proof;
  const controls = () => createDesktopUiControls(cdp, { assertOwnedRenderer: options.assertOwnedRenderer, step: value => steps.push(value) });
  let ui = controls();
  const effects = () => readDesktopEmulatedRuntimeEffects(fixture);
  const owner = join(fixture.root, 'hoststore/teams/test-desktop-backend/.host-owner');
  const state = () => json(join(owner, 'state.json'));
  const receipts = () => rows(join(owner, 'commands'));
  const poll = async <T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string) => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      options.assertOwnedRenderer(); await effects(); const value = await read(); if (accept(value)) return value;
      assert.ok(Date.now() < deadline, label + '; original action is never repeated');
      await new Promise<void>(resolve => setTimeout(resolve, 100));
    }
  };
  const screenshot = async (name: string) => {
    const image = record(await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }));
    assert.equal(typeof image.data, 'string'); const path = join(fixture.root, `ui-emulated-lifecycle-${name}.png`);
    await writeFile(path, Buffer.from(String(image.data), 'base64'), { mode: 0o600, flag: 'wx' });
    return { path, sha256: await fileDigest(path) };
  };
  const fill = async (selector: string, text: string) => {
    await ui.scrollTo(selector, 'original lifecycle input'); await ui.click(selector, 'focus original lifecycle input');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA',
      modifiers: process.platform === 'darwin' ? 4 : 2, commands: ['selectAll'] });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' });
    await cdp.send('Input.insertText', { text });
    await ui.waitRead(`document.querySelector(${literal(selector)})?.value===${literal(text)}`, 'exact original lifecycle input');
  };
  let queryId = 0;
  const query = async (operation: 'team.launch.read' | 'runtime.checkpoints.read' | 'team.launch.restorations.read', payload: Row) => {
    options.assertOwnedRenderer();
    const request = { handle: { handleId: fixture.handleId }, commandId: `TEST-emulated-lifecycle-read-${++queryId}`, operation, payload };
    const response = record(await cdp.evaluate(`window.electronAPI.agentBackend.invoke(${literal(request)})`));
    assert.equal(response.ok, true); assert.equal(JSON.stringify(response).includes(fixture.root), false);
    return record(response.value);
  };
  const send = async (text: string) => {
    const before = new Set((await receipts()).map(row => row.commandId));
    await fill('.message-composer-flat-layout textarea', text);
    await ui.click('button.message-composer-send-button', 'original lifecycle Composer Send once', 'Send');
    await ui.waitRead(`document.querySelector('.message-composer-flat-layout textarea')?.value===''`, 'lifecycle Composer admitted');
    const selected = await poll(receipts, values => values.some(row => !before.has(row.commandId) &&
      record(row.command).operation === 'message.send' && record(record(row.command).payload).text === text && row.phase === 'completed'), 'original lifecycle message receipt');
    const matches = selected.filter(row => !before.has(row.commandId) && record(row.command).operation === 'message.send' && record(record(row.command).payload).text === text);
    assert.equal(matches.length, 1); const receipt = matches[0]!, inputId = record(receipt.effects).deliveryId;
    assert.equal(typeof inputId, 'string'); const result = { text, commandId: receipt.commandId, inputId };
    commands.push(result); return result;
  };
  await ui.observeInput(); await ui.clickSidebar(fixture.uiSeed.subject);
  await ui.click('button', 'original lifecycle saved Team Launch', 'Launch');
  const settings = record(await ui.waitRead(`(()=>{const rows=[...document.querySelectorAll('[role="dialog"] button[aria-controls]')]
    .filter(e=>e.textContent.includes('Optional launch settings')&&e.textContent.includes(${literal(fixture.emulatedRuntime.savedModel)}));
    return rows.length===1?{id:rows[0].getAttribute('aria-controls'),expanded:rows[0].getAttribute('aria-expanded')}:null})()`, 'original lifecycle saved settings'));
  if (settings.expanded !== 'true') await ui.click(`[role="dialog"] button[aria-controls=${literal(settings.id)}]`, 'expand original lifecycle saved settings');
  await fill('[role="dialog"] #dialog-prompt', 'TEST_UI_BOOT');
  assert.equal(await cdp.evaluate(`document.querySelector('[role="dialog"] #dialog-skip-permissions')?.getAttribute('data-state')`), 'unchecked');
  await ui.scrollTo('[role="dialog"] button', 'original lifecycle Launch team', 'Launch team');
  await ui.waitRead(`[...document.querySelectorAll('[role="dialog"] button')].some(e=>e.textContent.trim()==='Launch team'&&!e.disabled)`, 'original lifecycle model readiness', 90_000);
  assert.equal(lifecycleRows((await state()).runtimeCaptures ?? []).length, 0);
  await ui.click('[role="dialog"] button', 'original lifecycle Launch once', 'Launch team');
  await ui.waitRead(`!document.querySelector('[role="dialog"] #dialog-prompt')`, 'original lifecycle Launch closes', 60_000);
  const saved = await poll(state, value => lifecycleRows(value.runtimeCaptures ?? []).length === 1, 'one lifecycle launch capture');
  const capture = lifecycleRows(saved.runtimeCaptures)[0]!;
  const sessions = () => readEmulatedLifecycleSessions(fixture, capture.launchId);
  const ready = await poll(sessions, values => values.length === 1 && lifecycleRows(values[0]!.inputs).length === 1 &&
    lifecycleRows(values[0]!.inputs)[0]!.terminal === 'succeeded', 'one original boot input terminal');
  assert.equal(record(saved.savedSettings).prompt, 'TEST_UI_BOOT');
  const sourceBinding = record(ready[0]!.binding);
  await ui.click('button[aria-label^="alice,"]', 'original lifecycle lead chat');
  await ui.waitRead(`document.body.innerText.includes('TEST boot ready')`, 'original lifecycle boot reply');
  proof.launchScreenshot = await screenshot('launch');
  await ui.scrollTo('button[aria-label="Stop"]', 'original lifecycle Team Stop');
  await ui.click('button[aria-label="Stop"]', 'original lifecycle Stop once', 'Stop');
  const stopped = await poll(sessions, values => values.length === 1 && values[0]!.phase === 'closed' && values[0]!.custody === 'released', 'original lifecycle custody release');
  const source = stopped[0]!, checkpoint = await readEmulatedClaudeCheckpoint(fixture, source);
  assert.equal(checkpoint.transcript.length, 2);
  assert.ok(String(record(checkpoint.transcript[0]!.message).content).includes('TEST_UI_BOOT'));
  assert.equal(record(checkpoint.transcript[1]!.message).content, 'TEST boot ready');
  const originalPids = (await effects()).filter(row => row.event === 'mcp-connected').map(row => Number(row.pid));
  assert.equal(originalPids.length, 1);
  await poll(async () => processTable(), values => originalPids.every(pid => !values.some(row => row.pid === pid)), 'first runtime peer absent after original Stop');
  proof.capture = capture; proof.source = { session: source, reference: checkpoint.payload.reference,
    payloadFileSha256: checkpoint.payloadFileSha256, historyPath: checkpoint.historyPath,
    historySha256: checkpoint.historySha256, nativeSession: checkpoint.nativeSession, originalPids };
  proof.stoppedScreenshot = await screenshot('stopped');
  cdp = await options.restartSameProfile(); ui = controls();
  assert.equal(record(evidence.emulatedColdResumeBoundary).status, 'PASS');
  await ui.observeInput(); await ui.clickSidebar(fixture.uiSeed.subject);
  assert.deepEqual(await sessions(), [source]);
  assert.deepEqual((await state()).runtimeCaptures, saved.runtimeCaptures);
  assert.deepEqual((await state()).savedSettings, saved.savedSettings);
  const launch = await query('team.launch.read', {});
  assert.equal(launch.launchId, capture.launchId);
  assert.equal(record(lifecycleRows(launch.members)[0]).generation, sourceBinding.generation);
  const availability = await query('runtime.checkpoints.read', { memberId: 'alice-id', expectedGeneration: sourceBinding.generation });
  assert.equal(availability.status, 'owner-eligible');
  assert.equal(lifecycleRows(availability.checkpoints).length, 1);
  const available = lifecycleRows(availability.checkpoints)[0]!;
  assert.equal(available.reference, checkpoint.payload.reference); assert.equal(available.status, 'owner-eligible');
  const beforeRestoration = await query('team.launch.restorations.read', { launchId: capture.launchId });
  assert.deepEqual(beforeRestoration.preparations, []); assert.deepEqual(beforeRestoration.restorations, []);
  await ui.click('button', 'open original lifecycle Resume dialog', 'Launch');
  await ui.waitRead(`Boolean(document.querySelector('[role="dialog"] #launch-continuation-mode'))`, 'original lifecycle continuation control');
  await ui.scrollTo('[role="dialog"] #launch-continuation-mode', 'original lifecycle continuation mode');
  await ui.click('[role="dialog"] #launch-continuation-mode', 'open original lifecycle continuation mode');
  await ui.click('[role="option"][data-value="resume"][aria-disabled="false"]', 'select original lifecycle Resume checkpoint');
  await ui.scrollTo('#resume-checkpoint-alice-id', 'original lifecycle Alice checkpoint');
  await ui.click('#resume-checkpoint-alice-id', 'open original lifecycle checkpoint choices');
  await ui.click(`[role="option"][data-value=${literal(available.reference)}][aria-disabled="false"]`, 'select exact original lifecycle checkpoint');
  await ui.waitRead(`document.querySelector('#resume-checkpoint-alice-id')?.textContent.trim()==='Saved checkpoint 1'`, 'explicit original lifecycle checkpoint selected');
  await ui.scrollTo('[role="dialog"] button', 'original lifecycle Resume submit', 'Resume selected checkpoints');
  await ui.waitRead(`[...document.querySelectorAll('[role="dialog"] button')].some(e=>e.textContent.trim()==='Resume selected checkpoints'&&!e.disabled)`, 'original lifecycle Resume ready', 90_000);
  proof.resumeSelectedScreenshot = await screenshot('resume-selected');
  await ui.click('[role="dialog"] button', 'original lifecycle Resume exactly once', 'Resume selected checkpoints');
  await ui.waitRead(`!document.querySelector('[role="dialog"] #launch-continuation-mode')`, 'original lifecycle Resume closes', 60_000);
  const restored = await poll(sessions, values => values.length === 2 && values.some(row => row.phase === 'allocated' && row.custody === 'owned' && row.nativeReady === true), 'one restored lifecycle generation');
  const active = restored.find(row => record(row.binding).generation !== sourceBinding.generation)!;
  const selectedBinding = record(active.binding);
  assert.deepEqual(restored.find(row => record(row.binding).generation === sourceBinding.generation), source);
  assert.deepEqual({ ...selectedBinding, generation: sourceBinding.generation }, sourceBinding);
  assert.deepEqual(active.restoredFrom, { reference: available.reference, sourceBinding });
  assert.equal(record(active.config).checkpointRef, available.reference); assert.deepEqual(active.inputs, []);
  assert.deepEqual((await state()).runtimeCaptures, [capture]); assert.deepEqual((await state()).savedSettings, saved.savedSettings);
  const restoration = await query('team.launch.restorations.read', { launchId: capture.launchId });
  assert.equal(lifecycleRows(restoration.preparations).length, 1); assert.equal(lifecycleRows(restoration.restorations).length, 1);
  const preparation = lifecycleRows(restoration.preparations)[0]!, choices = lifecycleRows(preparation.members);
  assert.equal(choices.length, 1); const choice = choices[0]!;
  assert.deepEqual({ memberId: choice.memberId, reference: choice.reference, sourceGeneration: choice.sourceGeneration },
    { memberId: 'alice-id', reference: available.reference, sourceGeneration: sourceBinding.generation });
  assert.equal(choice.requested, true); assert.equal(choice.refused, undefined);
  assert.deepEqual(restoration.restorations, [{ commandId: choice.commandId, memberId: 'alice-id', reference: available.reference,
    sourceGeneration: sourceBinding.generation, selectedGeneration: selectedBinding.generation, current: true, phase: 'allocated', custody: 'owned', attached: true }]);
  const journal = await json(join(owner, 'launches', `${jsonDigest(capture.launchId)}.json`));
  const retainedPreparation = lifecycleRows(journal.resumePreparations)[0]!;
  const members = lifecycleRows(retainedPreparation.members).map(({ requested: _requested, refused: _refused, ...member }) => member);
  assert.equal(retainedPreparation.fingerprint, jsonDigest({ resumeId: preparation.resumeId, rosterRevision: preparation.rosterRevision, members }));
  const resumed = (await effects()).filter(row => row.event === 'started' && row.restored === true);
  assert.equal(resumed.length, 1); assert.equal(resumed[0]!.sessionId, checkpoint.nativeSession);
  assert.equal(record(resumed[0]!.resumedHistory).sha256, checkpoint.historySha256);
  assert.equal(record(resumed[0]!.resumedHistory).rows, 2); assert.equal(record(resumed[0]!.resumedHistory).bootRetained, true);
  assert.deepEqual(await readFile(checkpoint.historyPath), checkpoint.history);
  assert.equal((await effects()).filter(row => row.event === 'input' && row.marker === 'TEST_UI_BOOT').length, 1);
  if (!(await cdp.evaluate(`Boolean(document.querySelector('.message-composer-flat-layout textarea'))`)))
    await ui.click('button[aria-label^="alice,"]', 'original lifecycle resumed lead chat');
  await ui.waitRead(`document.body.innerText.includes('TEST boot ready')`, 'original boot reply retained across cold Resume');
  const continuation = await send('TEST_UI_RESUME');
  const activeSession = async () => (await sessions()).find(row => record(row.binding).generation === selectedBinding.generation)!;
  await poll(activeSession, value => lifecycleRows(value.inputs).length === 1 && lifecycleRows(value.inputs)[0]!.terminal === 'succeeded', 'one resumed continuation completes');
  await ui.waitRead(`document.body.innerText.includes('TEST resumed history retained')`, 'original resumed continuation visible');
  const continuedHistory = await readFile(checkpoint.historyPath);
  assert.deepEqual(continuedHistory.subarray(0, checkpoint.history.length), checkpoint.history);
  assert.ok(continuedHistory.includes(Buffer.from('TEST_UI_RESUME')) && continuedHistory.includes(Buffer.from('TEST resumed history retained')));
  assert.equal(await fileDigest(checkpoint.path), checkpoint.payloadFileSha256);
  proof.resume = { status: 'PASS', sourceGeneration: sourceBinding.generation, selectedGeneration: selectedBinding.generation,
    reference: available.reference, nativeSession: checkpoint.nativeSession, originalPromptReplays: 0,
    peer: resumed[0], restoration, continuation, screenshot: await screenshot('resumed') };
  const held = await send('TEST_UI_HOLD');
  await ui.waitRead(`document.body.innerText.includes('TEST held partial')`, 'original active input held before Quit');
  await poll(activeSession, value => lifecycleRows(value.inputs).some(row => record(row.intent).inputId === held.inputId && ['claimed', 'consumed'].includes(String(row.phase))), 'original active input consumed');
  const queued = await send('TEST_UI_QUIT_QUEUED');
  const beforeQuit = await poll(activeSession, value => lifecycleRows(value.inputs).length === 3 &&
    lifecycleRows(value.inputs).some(row => record(row.intent).inputId === queued.inputId && row.phase === 'admitted'), 'second input queued behind original active turn');
  assert.equal((await effects()).some(row => row.event === 'input' && row.marker === 'TEST_UI_QUIT_QUEUED'), false);
  const heldInput = lifecycleRows(beforeQuit.inputs).find(row => record(row.intent).inputId === held.inputId)!;
  assert.ok(['claimed', 'consumed'].includes(String(heldInput.phase))); assert.equal(heldInput.terminal, undefined);
  proof.beforeQuit = { session: beforeQuit, product: await readEmulatedLifecycleProduct(fixture), held, queued,
    peerInputs: (await effects()).filter(row => row.event === 'input'), source,
    screenshot: await screenshot('active-queued-before-quit') };
  proof.fixturePins = await verifyDesktopEmulatedRuntimeFixture(fixture);
  proof.awaitingOriginalQuit = true;
}

/** Called after the common original app Quit and before any harness cleanup fallback. */
export async function verifyDesktopEmulatedLifecycleQuit(fixture: EmulatedLifecycleFixture, evidence: Row) {
  const proof = record(evidence.emulatedLifecycleUiProof), before = record(proof.beforeQuit);
  assert.equal(proof.awaitingOriginalQuit, true); assert.equal(record(proof.resume).status, 'PASS');
  const original = record(before.session), binding = record(original.binding);
  const sessions = await readEmulatedLifecycleSessions(fixture, binding.runId);
  assert.equal(sessions.length, 2);
  const closed = sessions.find(row => record(row.binding).generation === binding.generation)!;
  assert.equal(closed.phase, 'closed'); assert.equal(closed.custody, 'released');
  assert.equal(closed.sealed, true); assert.equal(closed.nativeReady, false);
  const inputs = lifecycleRows(closed.inputs), originalInputs = lifecycleRows(original.inputs);
  assert.equal(inputs.length, 3); assert.equal(originalInputs.length, 3);
  for (const input of inputs) {
    const retained = originalInputs.find(row => record(row.intent).inputId === record(input.intent).inputId)!;
    assert.deepEqual(input.intent, retained.intent); assert.equal(input.operationRef, retained.operationRef);
    assert.equal(input.fingerprint, retained.fingerprint);
  }
  const held = inputs.find(row => record(row.intent).inputId === record(before.held).inputId)!;
  const queued = inputs.find(row => record(row.intent).inputId === record(before.queued).inputId)!;
  assert.equal(held.phase, 'unknown'); assert.equal(held.terminal, undefined);
  assert.equal(queued.phase, 'cancelled'); assert.equal(queued.terminal, undefined);
  assert.equal(inputs[0]!.terminal, 'succeeded');
  assert.deepEqual(sessions.find(row => record(row.binding).generation === record(record(before.source).binding).generation), before.source);
  assert.deepEqual(await readEmulatedLifecycleProduct(fixture), before.product);
  const effects = await readDesktopEmulatedRuntimeEffects(fixture);
  assert.deepEqual(effects.filter(row => row.event === 'input'), before.peerInputs);
  assert.equal(effects.some(row => row.event === 'input' && row.marker === 'TEST_UI_QUIT_QUEUED'), false);
  assert.equal(effects.some(row => row.event === 'terminal' && row.marker === 'TEST_UI_HOLD'), false);
  const cleanup = await observeDesktopEmulatedRuntimeCleanup(fixture); assert.equal(cleanup.absent, true);
  const boundary = record(evidence.emulatedColdResumeBoundary);
  const epochs = [record(boundary.firstEpoch), record(boundary.secondEpoch)];
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && epochs.some(epoch => groupMembers(Number(record(epoch.app).processGroup)).length > 0))
    await new Promise<void>(resolve => setTimeout(resolve, 100));
  for (const epoch of epochs) {
    assert.deepEqual(groupMembers(Number(record(epoch.app).processGroup)), []);
    assert.equal(processTable().some(row => row.pid === record(epoch.host).pid), false);
  }
  await assert.rejects(lstat(join(fixture.root, 'hoststore/.legacy-agent-host-writer.lock')), { code: 'ENOENT' });
  const sourceCheckpoint = await readEmulatedClaudeCheckpoint(fixture, record(before.source));
  assert.equal(sourceCheckpoint.payloadFileSha256, record(proof.source).payloadFileSha256);
  assert.equal(sourceCheckpoint.history.includes(Buffer.from('TEST_UI_QUIT_QUEUED')), false);
  assert.equal(sourceCheckpoint.transcript.filter(row => row.type === 'user').length, 3);
  assert.equal(sourceCheckpoint.transcript.filter(row => row.type === 'assistant').length, 2);
  proof.afterQuit = { session: closed, activeOutcome: 'unknown', queuedOutcome: 'cancelled', queuedNativeDeliveries: 0,
    productUnchanged: true, bothAppGroupsAbsent: true, bothHostsAbsent: true, writerLockReleased: true, peerCleanup: cleanup };
  proof.effects = effects; proof.fixturePins = await verifyDesktopEmulatedRuntimeFixture(fixture);
  await writeFile(join(fixture.root, 'ui-emulated-runtime-effects.json'), JSON.stringify(effects, null, 2), { mode: 0o600, flag: 'wx' });
  proof.awaitingOriginalQuit = false; proof.status = 'PASS';
}
