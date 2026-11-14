import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostTeamSelectionKey } from '../../src/features/agent-backend/contracts/teamSelection.ts';
import { fileDigest } from './desktop-backend-fixture.ts';
import { processTable } from './desktop-backend-observations.ts';
import { openOriginalCreateForm } from './desktop-create-config-ui-smoke.ts';
import { readDesktopEmulatedRuntimeEffects, verifyDesktopEmulatedRuntimeFixture } from './desktop-emulated-runtime-fixture.ts';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';
import { json, jsonDigest, record, rows } from './desktop-resume-records.ts';
import { createDesktopUiControls, desktopJsLiteral as literal } from './desktop-ui-controls.ts';
import type { prepareDesktopEmulatedRuntimeFixture } from './desktop-emulated-runtime-fixture.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';

type Row = Record<string, unknown>;
const array = (value: unknown): Row[] => { assert.ok(Array.isArray(value)); return value.map(record); };

/** Original Create/Launch/Composer/Stop controls; two finite native threads retain their own selections. */
export async function runDesktopEmulatedSelectionUi(cdp: UiCdpPort, options: {
  fixture: Awaited<ReturnType<typeof prepareDesktopEmulatedRuntimeFixture>>;
  evidence: Row;
  assertOwnedRenderer(): void;
}) {
  const { fixture } = options, steps: Row[] = [], observations: Row[] = [];
  assert.equal(fixture.emulatedRuntime.provider, 'codex');
  assert.equal(fixture.emulatedRuntime.variant, 'selection');
  const proof: Row = { status: 'INCOMPLETE', steps, observations,
    scope: 'Original save-only model/effort selection, renderer reload, next launch and scoped Team Stop while the prior captured runtime remains alive',
    excluded: ['vendor model compatibility', 'native provider qualification', 'replacement of existing provider conversation journeys'] };
  options.evidence.emulatedSelectionUiProof = proof;
  const ui = createDesktopUiControls(cdp, { assertOwnedRenderer: options.assertOwnedRenderer, step: value => steps.push(value) });
  const effects = () => readDesktopEmulatedRuntimeEffects(fixture);
  const poll = async <T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string) => {
    const deadline = Date.now() + 75_000;
    for (;;) {
      await effects(); const value = await read(); if (accept(value)) return value;
      assert.ok(Date.now() < deadline, label + '; original action is never repeated');
      await new Promise<void>(resolve => setTimeout(resolve, 100));
    }
  };
  const visible = (text: string) => ui.waitRead(`document.body.innerText.includes(${literal(text)})`, 'original visible reply ' + text, 60_000);
  const screenshot = async (name: string) => {
    const image = record(await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }));
    assert.equal(typeof image.data, 'string'); const path = join(fixture.root, `ui-emulated-selection-${name}.png`);
    await writeFile(path, Buffer.from(String(image.data), 'base64'), { mode: 0o600, flag: 'wx' });
    return { path, sha256: await fileDigest(path) };
  };
  const fill = async (selector: string, value: string) => {
    await ui.scrollTo(selector, 'original input'); await ui.click(selector, 'focus original input');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA',
      modifiers: process.platform === 'darwin' ? 4 : 2, commands: ['selectAll'] });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' });
    await cdp.send('Input.insertText', { text: value });
    await ui.waitRead(`document.querySelector(${literal(selector)})?.value===${literal(value)}`, 'exact original input');
  };
  const team = (name: string, handleId: string, model: string, effort: 'low' | 'high') => {
    const root = join(fixture.root, 'hoststore/teams', name);
    return { name, handleId, model, effort, root, owner: () => json(join(root, '.host-owner/state.json')),
      commands: () => rows(join(root, '.host-owner/commands')) };
  };
  type Team = ReturnType<typeof team>;
  const a = team('test-desktop-backend', fixture.handleId, 'TEST-model', 'low');
  const openTeam = async (selected: Team) => {
    await ui.click('button[aria-label="More actions"]', 'open original application menu');
    await ui.click('button', 'open original Teams list', 'Teams');
    const key = hostTeamSelectionKey(selected.handleId), selector = `[data-team-name=${literal(key)}]`;
    await ui.scrollTo(selector, 'original captured Team card'); await ui.click(selector, 'open original captured Team');
    await ui.waitRead(`window.__agentTeamsDevStore?.getState().selectedTeamName===${literal(key)}`, 'original selected Team identity');
  };
  const openLaunch = async (selected: Team, chooseLow = false) => {
    await ui.click('button', 'open original saved Team Launch', 'Launch');
    const settings = record(await ui.waitRead(`(()=>{const rows=[...document.querySelectorAll('[role="dialog"] button[aria-controls]')]
      .filter(e=>e.textContent.includes('Optional launch settings')&&e.textContent.includes(${literal(selected.model)}));
      return rows.length===1?{id:rows[0].getAttribute('aria-controls'),expanded:rows[0].getAttribute('aria-expanded')}:null})()`, 'saved model hydrates original Launch'));
    if (settings.expanded !== 'true') await ui.click(`[role="dialog"] button[aria-controls=${literal(settings.id)}]`, 'expand original saved launch settings');
    if (chooseLow) {
      await ui.scrollTo('[role="dialog"] #dialog-effort', 'original captured effort');
      await ui.click('[role="dialog"] div:has(> #dialog-effort) > button', 'select original Low effort', 'Low');
    }
    await ui.waitRead(`document.querySelector('[role="dialog"] #dialog-effort')?.textContent.trim()===${literal(selected.effort === 'low' ? 'Low' : 'High')}`, 'saved effort hydrates original Launch');
    await fill('[role="dialog"] #dialog-prompt', 'TEST_UI_BOOT');
    assert.equal(await cdp.evaluate(`document.querySelector('[role="dialog"] #dialog-skip-permissions')?.getAttribute('data-state')`), 'unchecked');
    await ui.scrollTo('[role="dialog"] button', 'original Launch team', 'Launch team');
    await ui.waitRead(`[...document.querySelectorAll('[role="dialog"] button')].some(e=>e.textContent.trim()==='Launch team'&&!e.disabled)`, 'original selected model preflight', 90_000);
    assert.deepEqual((await selected.owner()).runtimeCaptures ?? [], []);
  };
  const launch = async (selected: Team) => {
    await ui.click('[role="dialog"] button', 'launch original selection once', 'Launch team');
    await ui.waitRead(`!document.querySelector('[role="dialog"] #dialog-prompt')`, 'original Launch closes', 60_000);
    const owner = await poll(selected.owner, value => array(value.runtimeCaptures ?? []).length === 1, 'one original Team launch capture');
    const capture = array(owner.runtimeCaptures)[0]!;
    const launched = await json(join(selected.root, '.host-owner/launches', jsonDigest(capture.launchId) + '.json'));
    const definition = structuredClone(record(launched.definition)); assert.equal(definition.launchId, capture.launchId);
    const source = record(definition.capture), settings = record(source.savedSettings), members = array(source.members);
    assert.equal(members.length, 1); assert.equal(members[0]!.role, 'lead');
    assert.equal(settings.providerId, 'codex'); assert.equal(settings.model, selected.model); assert.equal(settings.effort, selected.effort);
    const session = async () => {
      const all = (await readDesktopNativeStopSessions(fixture.root)).filter(row => record(row.binding).runId === capture.launchId);
      assert.equal(all.length, 1); assert.equal(record(all[0]!.binding).memberId, members[0]!.memberId); return all[0]!;
    };
    const initial = await poll(session, value => array(value.inputs).length === 1 && array(value.inputs)[0]!.terminal === 'succeeded', 'original BOOT completes once');
    const native = (await effects()).filter(row => row.event === 'thread-selection' && row.runtimeMcp === true && row.model === selected.model);
    assert.equal(native.length, 1); const thread = native[0]!;
    assert.equal(thread.effort, selected.effort); assert.equal(thread.role, 'runtime');
    assert.equal((await effects()).filter(row => row.pid === thread.pid && row.event === 'input' && row.marker === 'TEST_UI_BOOT').length, 1);
    return { ...selected, capture, definition, session, initial: structuredClone(initial), thread,
      memberName: String(members[0]!.name) };
  };
  type Live = Awaited<ReturnType<typeof launch>>;
  const openChat = async (live: Live) => {
    const name = live.memberName === 'team-lead' ? 'lead' : live.memberName;
    const selector = `button[aria-label^=${literal(name + ',')}]`;
    await ui.scrollTo(selector, 'original lead conversation'); await ui.click(selector, 'open original lead conversation');
  };
  const assertSameLive = async (live: Live, phase: string, originalInputs: boolean) => {
    assert.deepEqual(array((await live.owner()).runtimeCaptures), [live.capture]);
    const stored = await json(join(live.root, '.host-owner/launches', jsonDigest(live.capture.launchId) + '.json'));
    assert.deepEqual(record(stored.definition), live.definition);
    const current = await live.session();
    assert.deepEqual(current.binding, live.initial.binding); assert.deepEqual(current.config, live.initial.config);
    assert.equal(current.sessionRef, live.initial.sessionRef); assert.equal(current.hostIncarnation, live.initial.hostIncarnation);
    assert.equal(current.nativeReady, true); assert.equal(current.custody, 'owned'); assert.equal(current.sealed, false);
    if (originalInputs) assert.deepEqual(current.inputs, live.initial.inputs);
    assert.ok(processTable().some(row => row.pid === live.thread.pid));
    const journal = await effects();
    assert.deepEqual(journal.filter(row => row.event === 'thread-selection' && row.runtimeMcp === true && row.model === live.model), [live.thread]);
    assert.equal(journal.some(row => row.pid === live.thread.pid && row.event === 'exit'), false);
    observations.push({ phase, binding: current.binding, sessionRef: current.sessionRef,
      thread: live.thread, nativeReady: true, originalInputsUnchanged: originalInputs });
    return current;
  };
  const stop = async (live: Live) => {
    await ui.scrollTo('button[aria-label="Stop"]', 'original Team Stop');
    await ui.click('button[aria-label="Stop"]', 'stop original selected Team once', 'Stop');
    const stopped = await poll(live.session, value => value.phase === 'closed' && value.custody === 'released', 'original selected custody released');
    await poll(async () => processTable(), table => !table.some(row => row.pid === live.thread.pid), 'original selected peer absent');
    assert.deepEqual(stopped.binding, live.initial.binding);
    return { binding: stopped.binding, phase: stopped.phase, custody: stopped.custody, originalPid: live.thread.pid, absent: true };
  };

  await ui.observeInput(); await ui.clickSidebar(fixture.uiSeed.subject);
  await openLaunch(a, true); const liveA = await launch(a);
  await openChat(liveA); await visible('TEST boot ready');
  proof.aLaunchScreenshot = await screenshot('a-launch'); proof.a = { capture: liveA.capture, definition: liveA.definition, thread: liveA.thread };
  await assertSameLive(liveA, 'before-create', true);

  const bName = 'test-selection-next-team', page = '[data-testid="create-team-page"]';
  await openOriginalCreateForm(cdp, ui, join(fixture.root, 'workspace'), bName);
  await ui.scrollTo(`${page} #launch-team`, 'original immediate-launch checkbox');
  assert.equal(await cdp.evaluate(`document.querySelector('${page} #launch-team')?.getAttribute('data-state')`), 'checked');
  await ui.click(`${page} #launch-team`, 'select original save-only Create');
  await ui.waitRead(`document.querySelector('${page} #launch-team')?.getAttribute('data-state')==='unchecked'`, 'save-only selected');
  await ui.scrollTo(`${page} button[aria-label*=" provider,"]`, 'original lead model selector');
  await ui.click(`${page} button[aria-label*=" provider,"]`, 'open original lead model selector');
  await ui.scrollTo(`${page} [data-testid="team-model-selector-provider-nav-codex"]`, 'original Codex catalog');
  await ui.click(`${page} [data-testid="team-model-selector-provider-nav-codex"]`, 'select original Codex provider');
  const model = `${page} [data-testid="team-model-selector-model-option"][aria-label^="TEST next model"]`;
  await ui.waitRead(`(()=>{const rows=[...document.querySelectorAll(${literal(model)})];return rows.length===1&&rows[0].getAttribute('aria-disabled')!=='true'})()`, 'one selectable second TEST model');
  await ui.scrollTo(model, 'original second model'); await ui.click(model, 'select original second model');
  await ui.scrollTo(`${page} #lead-effort`, 'original effort choices');
  await ui.click(`${page} div:has(> #lead-effort) > button`, 'select original High effort', 'High');
  await ui.waitRead(`document.querySelector('${page} #lead-effort')?.textContent.trim()==='High'`, 'High remains selected');
  proof.selectedScreenshot = await screenshot('selected');
  await ui.scrollTo(`${page} button`, 'original save-only Create action', 'Create');
  await ui.click(`${page} button`, 'save original second selection once', 'Create');
  await ui.waitRead(`!document.querySelector('${page} #team-name')`, 'original Create closes', 60_000);
  const registry = await rows(join(fixture.root, 'hoststore/.host-team-registry/records'));
  assert.equal(registry.length, 1); assert.equal(registry[0]!.phase, 'published');
  const created = record(registry[0]!.record); assert.equal(created.teamName, bName);
  const b = team(bName, String(record(created.binding).handleId), 'TEST-model-next', 'high');
  const bSaved = await b.owner(), saved = record(bSaved.savedSettings);
  assert.equal(saved.providerId, 'codex'); assert.equal(saved.model, b.model); assert.equal(saved.effort, b.effort);
  assert.equal(saved.cwd, join(fixture.root, 'workspace')); assert.deepEqual(bSaved.runtimeCaptures ?? [], []);
  await assertSameLive(liveA, 'after-save-only', true); proof.creation = registry[0]; proof.savedSelection = saved;

  const origin = await cdp.evaluate('performance.timeOrigin'); await cdp.send('Page.reload', { ignoreCache: false });
  await ui.waitRead(`performance.timeOrigin!==${literal(origin)}&&Boolean(window.electronAPI)&&!document.getElementById('splash')`, 'fresh renderer after reload');
  await ui.observeInput(); await ui.waitRead(`Boolean(document.querySelector('button[aria-label="More actions"]'))`, 'reloaded original menu');
  await openTeam(b); await openLaunch(b);
  assert.deepEqual(await b.owner(), bSaved); await assertSameLive(liveA, 'after-reload-before-next-launch', true);
  proof.reloadedScreenshot = await screenshot('reloaded'); proof.selectionRetainedAfterReload = true;
  const liveB = await launch(b); assert.notEqual(liveB.thread.pid, liveA.thread.pid); assert.notEqual(liveB.thread.threadId, liveA.thread.threadId);
  await openChat(liveB); await visible('TEST boot ready');
  proof.bLaunchScreenshot = await screenshot('b-launch'); proof.b = { capture: liveB.capture, definition: liveB.definition, thread: liveB.thread };
  await assertSameLive(liveA, 'after-next-launch', true);

  await openTeam(a); await openChat(liveA);
  const before = new Set((await a.commands()).map(row => row.commandId));
  await fill('.message-composer-flat-layout textarea', 'TEST_UI_STREAM');
  await ui.click('button.message-composer-send-button', 'send original held stream once', 'Send');
  const sent = (await poll(a.commands, values => values.some(row => !before.has(row.commandId) &&
    record(row.command).operation === 'message.send' && record(record(row.command).payload).text === 'TEST_UI_STREAM' && row.phase === 'completed'), 'original stream receipt'))
    .filter(row => !before.has(row.commandId) && record(row.command).operation === 'message.send' && record(record(row.command).payload).text === 'TEST_UI_STREAM');
  assert.equal(sent.length, 1); const inputId = record(sent[0]!.effects).deliveryId;
  assert.equal(typeof inputId, 'string'); await visible('TEST stream partial');
  const pending = array((await liveA.session()).inputs).find(row => record(row.intent).inputId === inputId);
  assert.ok(pending); assert.notEqual(pending.phase, 'terminal');
  assert.equal((await effects()).filter(row => row.pid === liveA.thread.pid && row.event === 'input' && row.marker === 'TEST_UI_STREAM').length, 1);
  await openTeam(b); proof.bStop = await stop(liveB);
  const afterBStop = await assertSameLive(liveA, 'after-b-stop-during-a-input', false);
  assert.deepEqual(array(afterBStop.inputs).find(row => record(row.intent).inputId === inputId), pending);
  await openTeam(a); await openChat(liveA); await visible('TEST stream partial');
  assert.equal(await cdp.evaluate(`document.body.innerText.includes('TEST stream partial complete')`), false);
  proof.aSurvivedScreenshot = await screenshot('a-survived');
  await writeFile(join(fixture.emulatedRuntime.peers[0]!.root, 'release-stream'), 'TEST release once\n', { mode: 0o600, flag: 'wx' });
  const completed = await poll(liveA.session, value => array(value.inputs).some(row => record(row.intent).inputId === inputId && row.terminal === 'succeeded'), 'original A stream completes');
  assert.equal(array(completed.inputs).length, 2); await visible('TEST stream partial complete');
  proof.completedScreenshot = await screenshot('completed'); proof.stream = { commandId: sent[0]!.commandId, inputId, terminal: 'succeeded', survivedBStop: true };
  proof.aStop = await stop(liveA); proof.stoppedScreenshot = await screenshot('stopped');
  const journal = await effects();
  assert.equal(journal.filter(row => row.event === 'thread-selection' && row.runtimeMcp === true).length, 2);
  proof.effects = journal; proof.fixturePins = await verifyDesktopEmulatedRuntimeFixture(fixture);
  await writeFile(join(fixture.root, 'ui-emulated-selection-effects.json'), JSON.stringify(journal, null, 2), { mode: 0o600, flag: 'wx' });
  proof.status = 'PASS'; proof.visualReview = 'Original screenshots require independent inspection';
}
