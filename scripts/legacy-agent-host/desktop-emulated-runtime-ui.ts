import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeDigest } from '../../packages/legacy-agent-host/dist/runtime/identity.js';
import { readNativeHostCostProof } from '../../packages/legacy-agent-host/tests/fixtures/native-host-cost.ts';
import { fileDigest } from './desktop-backend-fixture.ts';
import { processTable } from './desktop-backend-observations.ts';
import { openDesktopEmulatedBootChat } from './desktop-emulated-boot-chat.ts';
import { readDesktopEmulatedRuntimeEffects, verifyDesktopEmulatedRuntimeFixture, type prepareDesktopEmulatedRuntimeFixture } from './desktop-emulated-runtime-fixture.ts';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';
import { sendDesktopNativeCommandFromComposer } from './desktop-native-commands-ui-proof.ts';
import { json, record, rows } from './desktop-resume-records.ts';
import { revealDesktopReply } from './desktop-reply-visibility.ts';
import { EDITED_SCHEDULE_LABEL, LEGACY_SCHEDULE_ID, LEGACY_SCHEDULE_LABEL } from './desktop-schedule-fixture.ts';
import { createDesktopScheduleHistoryObservation } from './desktop-schedule-history-observation.ts';
import { createDesktopUiControls, desktopJsLiteral as literal, type UiCdpPort } from './desktop-ui-controls.ts';
import { runDesktopEmulatedSelectionUi } from './desktop-emulated-selection-ui.ts';
import { runDesktopEmulatedLifecycleUi } from './desktop-emulated-lifecycle-ui.ts';
import { runDesktopEmulatedCollaborationUi } from './desktop-emulated-collaboration-ui.ts';
import { isDesktopEmulatedCollaborationFixture } from './desktop-emulated-collaboration-fixture.ts';

type Row = Record<string, unknown>;
const array = (value: unknown): Row[] => { assert.ok(Array.isArray(value)); return value.map(record); };

/** Original renderer controls create all business writes; only the TEST peer stream gate is external. */
export async function runDesktopEmulatedRuntimeUi(cdp: UiCdpPort, options: {
  fixture: Awaited<ReturnType<typeof prepareDesktopEmulatedRuntimeFixture>>;
  evidence: Row;
  assertOwnedRenderer(): void;
  restartSameProfile?(): Promise<UiCdpPort>;
}) {
  if (isDesktopEmulatedCollaborationFixture(options.fixture))
    return runDesktopEmulatedCollaborationUi(cdp, { ...options, fixture: options.fixture });
  if (options.fixture.emulatedRuntime.variant === 'selection' || options.fixture.emulatedRuntime.variant === 'installer') return runDesktopEmulatedSelectionUi(cdp, options);
  if (options.fixture.emulatedRuntime.variant === 'lifecycle') {
    assert.ok(options.restartSameProfile);
    return runDesktopEmulatedLifecycleUi(cdp, { ...options, restartSameProfile: options.restartSameProfile });
  }
  const { fixture } = options, steps: Row[] = [], commands: Row[] = [], provider = fixture.emulatedRuntime.provider;
  const proof: Row = { status: 'INCOMPLETE', provider, steps, commands,
    scope: 'Original Launch, Composer stream, permission/question controls, cost/Stats, schedules, Task Activity/detail/Stream, renderer reload and Team Stop through original Host/D and finite TEST protocol peers',
    excluded: ['vendor inference/authentication', 'per-turn interrupt UI (no original control)', 'native provider qualification'] };
  options.evidence.emulatedRuntimeUiProof = proof;
  const ui = createDesktopUiControls(cdp, { assertOwnedRenderer: options.assertOwnedRenderer, step: value => steps.push(value) });
  const effects = () => readDesktopEmulatedRuntimeEffects(fixture);
  const poll = async <T>(read: () => Promise<T>, accept: (value: T, observedEffects: Row[]) => boolean, label: string,
    canRead?: (observedEffects: Row[]) => boolean) => {
    const deadline = Date.now() + 75_000;
    for (;;) {
      const observedEffects = await effects();
      if (!canRead || canRead(observedEffects)) {
        const value = await read(); if (accept(value, observedEffects)) return value;
      }
      assert.ok(Date.now() < deadline, label + '; original action is never repeated');
      await new Promise<void>(resolve => setTimeout(resolve, 100));
    }
  };
  const screenshot = async (name: string) => {
    const image = record(await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }));
    assert.equal(typeof image.data, 'string'); const path = join(fixture.root, `ui-emulated-runtime-${name}.png`);
    await writeFile(path, Buffer.from(String(image.data), 'base64'), { mode: 0o600, flag: 'wx' });
    return { path, sha256: await fileDigest(path) };
  };
  const visible = async (text: string) => {
    await ui.waitRead(`document.body.innerText.includes(${literal(text)})`, 'original visible reply ' + text, 60_000);
  };
  const escape = async () => {
    for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent',
      { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  };
  const fill = async (selector: string, value: string) => {
    await ui.scrollTo(selector, 'original input'); await ui.click(selector, 'focus original input');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA',
      modifiers: process.platform === 'darwin' ? 4 : 2, commands: ['selectAll'] });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' });
    await cdp.send('Input.insertText', { text: value });
    await ui.waitRead(`document.querySelector(${literal(selector)})?.value===${literal(value)}`, 'exact original input');
  };
  const teamRoot = join(fixture.root, 'hoststore/teams/test-desktop-backend');
  const commandRows = () => rows(join(teamRoot, '.host-owner/commands'));
  const ownerState = () => json(join(teamRoot, '.host-owner/state.json'));
  await ui.observeInput(); await ui.clickSidebar(fixture.uiSeed.subject);
  await ui.click('button', 'open original saved Team Launch', 'Launch');
  const settings = record(await ui.waitRead(`(()=>{const rows=[...document.querySelectorAll('[role="dialog"] button[aria-controls]')]
    .filter(e=>e.textContent.includes('Optional launch settings')&&e.textContent.includes(${literal(fixture.emulatedRuntime.savedModel)}));
    return rows.length===1?{id:rows[0].getAttribute('aria-controls'),expanded:rows[0].getAttribute('aria-expanded')}:null})()`, 'saved TEST launch settings hydrate'));
  if (settings.expanded !== 'true') await ui.click(`[role="dialog"] button[aria-controls=${literal(settings.id)}]`, 'expand original saved launch settings');
  await fill('[role="dialog"] #dialog-prompt', 'TEST_UI_BOOT');
  assert.equal(await cdp.evaluate(`document.querySelector('[role="dialog"] #dialog-skip-permissions')?.getAttribute('data-state')`), 'unchecked');
  await ui.scrollTo('[role="dialog"] button', 'original Launch team', 'Launch team');
  await ui.waitRead(`[...document.querySelectorAll('[role="dialog"] button')].some(e=>e.textContent.trim()==='Launch team'&&!e.disabled)`, 'original preflight completes', 90_000);
  assert.equal(array((await ownerState()).runtimeCaptures ?? []).length, 0);
  await ui.click('[role="dialog"] button', 'launch saved TEST selection once', 'Launch team');
  await ui.waitRead(`!document.querySelector('[role="dialog"] #dialog-prompt')`, 'original Launch closes', 60_000);
  const saved = await poll(ownerState, value => array(value.runtimeCaptures ?? []).length === 1, 'one original launch capture');
  const capture = array(saved.runtimeCaptures)[0]!;
  assert.equal(record(saved.savedSettings).prompt, 'TEST_UI_BOOT');
  assert.equal(record(saved.savedSettings).model, fixture.emulatedRuntime.savedModel);
  assert.equal(record(saved.savedSettings).skipPermissions, false);
  const pendingSession = async () => {
    const all = (await readDesktopNativeStopSessions(fixture.root).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    })).filter(row => record(row.binding).runId === capture.launchId);
    assert.ok(all.length <= 1, 'At most one original Runtime session per launch capture');
    return all[0];
  };
  await poll(pendingSession, value => Boolean(value && array(value.inputs).length === 1 && array(value.inputs)[0]!.terminal === 'succeeded'), 'original boot prompt completes once');
  const session = async () => {
    const value = await pendingSession();
    assert.ok(value, 'Previously observed original Runtime session remains present');
    return value;
  };
  await openDesktopEmulatedBootChat(cdp, { selector: 'button[aria-label^="alice,"]', timeoutMs: 60_000,
    replyLabel: 'original visible reply TEST boot ready', assertOwnedRenderer: options.assertOwnedRenderer, step: value => steps.push(value),
    open: controls => controls.click('button[aria-label^="alice,"]', 'open original lead conversation') });
  proof.launchScreenshot = await screenshot('launch'); proof.capture = capture;
  const observeSent = async (before: Set<unknown>, text: string) => {
    const entries = await poll(commandRows, values => values.some(row => !before.has(row.commandId) &&
      record(row.command).operation === 'message.send' && record(record(row.command).payload).text === text && row.phase === 'completed'), 'original message receipt');
    const matches = entries.filter(row => !before.has(row.commandId) && record(row.command).operation === 'message.send' && record(record(row.command).payload).text === text);
    assert.equal(matches.length, 1); const receipt = matches[0]!, inputId = record(receipt.effects).deliveryId;
    assert.equal(typeof inputId, 'string'); commands.push({ text, commandId: receipt.commandId, inputId });
    return { receipt, inputId };
  };
  const send = async (text: string) => {
    const before = new Set((await commandRows()).map(row => row.commandId));
    await fill('.message-composer-flat-layout textarea', text);
    await ui.click('button.message-composer-send-button', 'original Composer Send once', 'Send');
    return observeSent(before, text);
  };
  const terminal = async (inputId: unknown, outcome = 'succeeded') => {
    const value = await poll(session, value => array(value.inputs).some(row => record(row.intent).inputId === inputId && row.phase === 'terminal'), 'original correlated input terminal');
    const matches = array(value.inputs).filter(row => record(row.intent).inputId === inputId);
    assert.equal(matches.length, 1); assert.equal(matches[0]!.terminal, outcome); return value;
  };
  const leadLogs = '[data-section-id="claude-logs"]';
  const openLeadLogs = async () => {
    const expand = leadLogs + ' button[aria-label="Expand section"]';
    if (await cdp.evaluate(`Boolean(document.querySelector(${literal(expand)}))`)) {
      await ui.scrollTo(expand, 'original Lead Logs section'); await ui.click(expand, 'expand original Lead Logs');
    }
    await ui.waitRead(`document.querySelector(${literal(leadLogs)})?.textContent.includes('alice · Captured runtime activity')`,
      'default actual Lead uses the typed Host log route');
  };
  const logFactSelector = (scope: string, event: Row) => `${scope} [data-host-log-event-id=${literal(event.eventId)}]`;
  const visibleLogFact = async (scope: string, event: Row, sourceTitle?: string) => {
    const selector = logFactSelector(scope, event), data = record(event.data), text = String(data.text);
    assert.ok(['text', 'thinking', 'process-output'].includes(String(data.kind)));
    const identity = data.kind === 'process-output' ? event.eventId
      : JSON.stringify([event.inputId ?? null, null, data.kind, data.messageRef, data.block]);
    const anchor = JSON.stringify(['host-activity-' + leadSourceId, identity]);
    await ui.waitRead(`(()=>{const rows=[...document.querySelectorAll(${literal(selector)})];return rows.length===1&&
      rows[0].dataset.hostLogSequence===${literal(String(event.sequence))}&&rows[0].dataset.hostLogKind===${literal(data.kind)}&&
      rows[0].dataset.hostLogAnchor===${literal(anchor)}})()`,
      'exact original retained Logs event identity');
    if (!await cdp.evaluate(`Boolean(document.querySelector(${literal(selector + ' [data-host-log-content]')}))`)) {
      await ui.scrollTo(selector + ' [role="button"]', 'original output disclosure');
      await ui.click(selector + ' [role="button"]', 'expand original output');
    }
    await ui.scrollTo(selector + ' [data-host-log-content] p', 'actual rich output', text, 12, { requireCenterHit: true });
    return record(await ui.waitRead(`(()=>{const e=document.querySelector(${literal(selector)});
      if(!e)return null;
      const sourceTitle=${literal(sourceTitle ?? null)};
      const sources=sourceTitle===null?[]:[...document.querySelectorAll(${literal(scope + ' button[aria-expanded="true"]')})]
        .filter(button=>button.textContent.trim()===sourceTitle);
      if(sourceTitle!==null&&(sources.length!==1||!sources[0].getClientRects().length||
        document.querySelectorAll(${literal(selector)}).length!==1||e.dataset.hostLogEventId!==${literal(event.eventId)}||
        e.dataset.hostLogSequence!==${literal(String(event.sequence))}||e.dataset.hostLogKind!==${literal(record(event.data).kind)}))return null;
      const bodies=[...e.querySelectorAll('[data-host-log-content] p')].filter(p=>p.textContent.trim()===${literal(text)});
      if(bodies.length!==1||!bodies[0].getClientRects().length)return null;
      return {eventId:e.dataset.hostLogEventId,sequence:Number(e.dataset.hostLogSequence),text:bodies[0].textContent.trim(),
        ...(sourceTitle===null?{}:{source:sources[0].textContent.trim()})}})()`,
      'actual retained output is visible inside Logs'));
  };
  const leadBinding = record((await session()).binding), leadSourceId = runtimeDigest(leadBinding);
  const leadActivityPath = join(fixture.root, 'hoststore/runtime-events', leadSourceId + '.json');
  const stream = await send('TEST_UI_STREAM');
  await visible('TEST stream partial');
  assert.equal(await cdp.evaluate('document.body.innerText.includes("TEST stream partial complete")'), false);
  assert.notEqual(array((await session()).inputs).find(row => record(row.intent).inputId === stream.inputId)?.phase, 'terminal');
  proof.partialScreenshot = await screenshot('partial');
  const streamEvent = async (text: string, kind: 'text' | 'thinking' = 'text') => {
    const event = await poll(async () => {
      const retained = await json(leadActivityPath), { digest, ...body } = retained;
      assert.equal(runtimeDigest(body), digest); assert.deepEqual(retained.binding, leadBinding);
      return array(retained.events).filter(row => row.inputId === stream.inputId &&
        record(row.data).kind === kind && record(row.data).text === text).at(-1);
    },
    value => value !== undefined, 'original stream fact retained before Logs observation');
    assert.ok(event);
    const input = array((await session()).inputs).find(row => record(row.intent).inputId === stream.inputId);
    assert.ok(input); assert.equal(event.operationRef, input.operationRef); return event;
  };
  await openLeadLogs();
  const partialEvent = await streamEvent('TEST stream partial');
  const partialLog = await visibleLogFact(leadLogs, partialEvent);
  const partialThought = provider === 'codex' ? null : await streamEvent('TEST stream thought partial', 'thinking');
  if (partialThought) {
    assert.equal(record(partialThought.data).phase, 'snapshot');
    assert.equal(record(partialThought.data).block, 1);
    assert.equal(record(partialThought.data).messageRef, record(partialEvent.data).messageRef);
    await visibleLogFact(leadLogs, partialThought);
  }
  assert.notEqual(array((await session()).inputs).find(row => record(row.intent).inputId === stream.inputId)?.phase, 'terminal');
  await writeFile(join(fixture.emulatedRuntime.peers[0]!.root, 'release-stream'), 'TEST release once\n', { mode: 0o600, flag: 'wx' });
  await terminal(stream.inputId); await visible('TEST stream partial complete');
  proof.completedScreenshot = await screenshot('completed');
  const completeEvent = await streamEvent('TEST stream partial complete');
  const completeLog = await visibleLogFact(leadLogs, completeEvent);
  const completeThought = partialThought ? await streamEvent('TEST stream thought complete', 'thinking') : null;
  if (completeThought && partialThought) {
    assert.equal(record(completeThought.data).phase, 'complete');
    for (const key of ['messageRef', 'block'])
      assert.equal(record(completeThought.data)[key], record(partialThought.data)[key]);
    await visibleLogFact(leadLogs, completeThought);
    await ui.waitRead(`!document.querySelector(${literal(logFactSelector(leadLogs, partialThought))})`,
      'completed Thinking replaces only the original partial block');
    for (const key of ['messageRef', 'block'])
      assert.equal(record(completeEvent.data)[key], record(partialEvent.data)[key]);
    await ui.waitRead(`!document.querySelector(${literal(logFactSelector(leadLogs, partialEvent))})`,
      'completed output replaces the original partial block');
  }
  const stderrText = 'TEST selected member stderr';
  const stderrEvent = provider === 'opencode' ? null : await poll(async () =>
    array((await json(leadActivityPath)).events).find(event => record(event.data).kind === 'process-output' &&
      record(event.data).stream === 'stderr' && record(event.data).text === stderrText),
  value => value !== undefined, 'original selected process stderr is retained');
  if (stderrEvent) {
    assert.equal(stderrEvent.inputId, undefined); assert.equal(stderrEvent.operationRef, undefined);
    await visibleLogFact(leadLogs, stderrEvent);
  }
  const beforeLogControls = { inputs: structuredClone((await session()).inputs), commands: await commandRows(),
    inputEffects: (await effects()).filter(row => row.event === 'input').length };
  const logSearch = leadLogs + ' input[placeholder="Search logs..."]';
  await fill(logSearch, 'TEST no such retained Logs fact');
  await ui.waitRead(`!document.querySelector(${literal(leadLogs + ' [data-host-log-kind="text"]')})`, 'Logs search excludes nonmatching output');
  if (stderrEvent) await ui.waitRead(`!document.querySelector(${literal(logFactSelector(leadLogs, stderrEvent))})`,
    'Logs search also excludes nonmatching captured stderr');
  if (completeThought) await ui.waitRead(`!document.querySelector(${literal(logFactSelector(leadLogs, completeThought))})`,
    'Logs search excludes nonmatching Thinking');
  await ui.click(leadLogs + ' button[aria-label="Clear search"]', 'clear original Logs search');
  await visibleLogFact(leadLogs, completeEvent);
  if (completeThought) await visibleLogFact(leadLogs, completeThought);
  if (stderrEvent) await visibleLogFact(leadLogs, stderrEvent);
  const filterLogs = async () => {
    await ui.scrollTo(leadLogs + ' button[aria-label="Filter logs"]', 'original Logs filters');
    await ui.click(leadLogs + ' button[aria-label="Filter logs"]', 'open original Logs filters');
  };
  await filterLogs();
  for (const id of ['filter-stream-stdout', 'filter-stream-stderr', 'filter-kind-output', 'filter-kind-thinking', 'filter-kind-tool'])
    assert.equal(await cdp.evaluate(`document.getElementById(${literal(id)})?.getAttribute('data-state')`), 'checked');
  await ui.click('#filter-stream-stdout', 'select stderr while native protocol facts remain unmarked');
  await ui.click('[data-radix-popper-content-wrapper] button', 'save original stream filter', 'Save');
  await visibleLogFact(leadLogs, completeEvent);
  if (completeThought) await visibleLogFact(leadLogs, completeThought);
  if (stderrEvent) await visibleLogFact(leadLogs, stderrEvent);
  await filterLogs(); await ui.click('#filter-stream-stdout', 'restore stdout');
  await ui.click('#filter-stream-stderr', 'select stdout while native protocol facts remain unmarked');
  await ui.click('[data-radix-popper-content-wrapper] button', 'save original stdout filter', 'Save');
  await visibleLogFact(leadLogs, completeEvent);
  if (completeThought) await visibleLogFact(leadLogs, completeThought);
  if (stderrEvent) await ui.waitRead(`!document.querySelector(${literal(logFactSelector(leadLogs, stderrEvent))})`,
    'actual stderr provenance is excluded by stdout-only filter');
  await filterLogs(); await ui.click('#filter-kind-output', 'exclude Output');
  await ui.click('[data-radix-popper-content-wrapper] button', 'save original content filter', 'Save');
  await ui.waitRead(`!document.querySelector(${literal(leadLogs + ' [data-host-log-kind="text"]')})`, 'Output filter applies to actual facts');
  if (completeThought) await visibleLogFact(leadLogs, completeThought);
  await filterLogs(); await ui.click('#filter-kind-thinking', 'exclude Thinking independently');
  await ui.click('[data-radix-popper-content-wrapper] button', 'save original Thinking filter', 'Save');
  if (completeThought) await ui.waitRead(`!document.querySelector(${literal(logFactSelector(leadLogs, completeThought))})`,
    'Thinking filter excludes actual retained thought');
  await filterLogs(); await ui.click('[data-radix-popper-content-wrapper] button', 'reset original Logs filters', 'Reset');
  await ui.click('[data-radix-popper-content-wrapper] button', 'close restored Logs filters', 'Save');
  const fullscreenEvent = stderrEvent ?? completeEvent, fullscreenText = String(record(fullscreenEvent.data).text);
  await fill(logSearch, fullscreenText); await visibleLogFact(leadLogs, fullscreenEvent);
  const fullscreen = leadLogs + ' button[aria-label="Open fullscreen logs"]';
  await ui.scrollTo(fullscreen, 'original fullscreen Logs'); await ui.click(fullscreen, 'open original fullscreen Logs');
  const logsDialog = '[role="dialog"]:has(input[placeholder="Search logs..."])';
  await ui.waitRead(`document.querySelector(${literal(logsDialog + ' input')})?.value===${literal(fullscreenText)}&&
    !document.querySelector(${literal(logFactSelector(leadLogs, fullscreenEvent))})`, 'one fullscreen read owner retains query');
  await ui.waitRead(`Boolean(document.querySelector(${literal(logFactSelector(logsDialog, fullscreenEvent) + ' [data-host-log-content]')}))`,
    'original expanded output survives fullscreen remount');
  const fullscreenLog = await visibleLogFact(logsDialog, fullscreenEvent);
  const copy = logFactSelector(logsDialog, fullscreenEvent) + ' button[title="Copy to clipboard"]';
  await ui.scrollTo(copy, 'original rich output copy'); await ui.click(copy, 'copy actual retained output');
  await ui.waitRead(`Boolean(document.querySelector(${literal(copy + ' svg.lucide-check')}))`, 'original clipboard write acknowledged');
  assert.equal(await cdp.evaluate('navigator.clipboard.readText()'), fullscreenText);
  const disclosure = logFactSelector(logsDialog, fullscreenEvent) + ' [role="button"]';
  await ui.click(disclosure, 'collapse original output');
  await ui.waitRead(`!document.querySelector(${literal(logFactSelector(logsDialog, fullscreenEvent) + ' [data-host-log-content]')})`, 'rich content collapses');
  await ui.click(disclosure, 'restore original expanded output');
  if (completeThought) {
    const thoughtText = String(record(completeThought.data).text), thoughtRow = logFactSelector(logsDialog, completeThought);
    await fill(logsDialog + ' input', thoughtText); await visibleLogFact(logsDialog, completeThought);
    const thoughtCopy = thoughtRow + ' button[title="Copy to clipboard"]';
    await ui.scrollTo(thoughtCopy, 'original Thinking copy'); await ui.click(thoughtCopy, 'copy actual retained Thinking');
    await ui.waitRead(`Boolean(document.querySelector(${literal(thoughtCopy + ' svg.lucide-check')}))`, 'Thinking clipboard write acknowledged');
    options.assertOwnedRenderer();
    assert.equal(await cdp.evaluate('navigator.clipboard.readText()'), thoughtText);
    await ui.click(thoughtRow + ' [role="button"]', 'collapse original Thinking');
    await ui.waitRead(`!document.querySelector(${literal(thoughtRow + ' [data-host-log-content]')})`, 'Thinking rich content collapses');
    await ui.click(thoughtRow + ' [role="button"]', 'restore original expanded Thinking');
    await fill(logsDialog + ' input', fullscreenText); await visibleLogFact(logsDialog, fullscreenEvent);
  }
  proof.leadLogsScreenshot = await screenshot('lead-logs');
  await escape(); await visibleLogFact(leadLogs, fullscreenEvent);
  await ui.click(leadLogs + ' button[aria-label="Clear search"]', 'restore unfiltered Lead Logs');
  assert.deepEqual((await session()).inputs, beforeLogControls.inputs);
  assert.deepEqual(await commandRows(), beforeLogControls.commands);
  assert.equal((await effects()).filter(row => row.event === 'input').length, beforeLogControls.inputEffects);
  proof.leadLogs = { partial: partialLog, complete: completeLog, fullscreen: fullscreenLog, actualClipboard: true,
    thinking: completeThought ? { partialEventId: partialThought!.eventId, completeEventId: completeThought.eventId,
      messageRef: record(completeThought.data).messageRef, block: record(completeThought.data).block } : null,
    stderr: stderrEvent ? { eventId: stderrEvent.eventId, sequence: stderrEvent.sequence, text: stderrText, inputId: null } : null,
    defaultLeadRoute: true, filtersAndSearch: true, addedInputs: 0, addedBusinessCommands: 0 };
  const sheet = 'div.fixed.bottom-4';
  for (const [marker, allowed] of [['TEST_UI_APPROVAL_DENY', false], ['TEST_UI_APPROVAL_ALLOW', true]] as const) {
    const sent = await send(marker);
    await ui.waitRead(`document.querySelector(${literal(sheet)})?.textContent.includes('approved-effect.txt')`, 'original permission sheet');
    const pending = array((await session()).interactions).filter(row => row.phase === 'pending');
    assert.equal(pending.length, 1); assert.equal(pending[0]!.kind, 'permission');
    assert.equal((await effects()).some(row => ['interaction-reply', 'decision'].includes(String(row.event)) && row.marker === marker), false);
    proof[allowed ? 'allowScreenshot' : 'denyScreenshot'] = await screenshot(allowed ? 'allow-pending' : 'deny-pending');
    await ui.click(`${sheet} button`, 'original permission decision once', allowed ? 'Allow' : 'Deny');
    await terminal(sent.inputId); await visible(allowed ? 'TEST approval allowed' : 'TEST approval denied');
    const path = join(fixture.emulatedRuntime.peers[0]!.root, 'approved-effect.txt');
    if (allowed) assert.equal(await readFile(path, 'utf8'), provider === 'claude' ? 'TEST approved effect\n' : 'TEST approved once\n');
    else await assert.rejects(readFile(path), { code: 'ENOENT' });
  }
  if (provider !== 'codex') {
    const allowed = commands.find(row => row.text === 'TEST_UI_APPROVAL_ALLOW'); assert.ok(allowed);
    const retained = await json(leadActivityPath), { digest, ...body } = retained;
    assert.equal(runtimeDigest(body), digest); assert.deepEqual(retained.binding, leadBinding);
    const source = array((await session()).inputs).find(row => record(row.intent).inputId === allowed.inputId); assert.ok(source);
    const events = array(retained.events).filter(row => row.inputId === allowed.inputId && row.operationRef === source.operationRef);
    const result = events.filter(row => record(row.data).kind === 'tool-result').at(-1); assert.ok(result);
    const toolRef = record(result.data).toolRef;
    const tool = events.filter(row => record(row.data).kind === 'tool' && record(row.data).toolRef === toolRef).at(-1); assert.ok(tool);
    const before = { inputs: structuredClone((await session()).inputs), commands: await commandRows(), effects: await effects() };
    await openLeadLogs(); await filterLogs();
    await ui.click('#filter-kind-output', 'show Tools without Output'); await ui.click('#filter-kind-thinking', 'show Tools without Thinking');
    await ui.click('[data-radix-popper-content-wrapper] button', 'save original Tools-only filter', 'Save');
    for (const event of [tool, result]) {
      const anchor = JSON.stringify(['host-activity-' + leadSourceId,
        JSON.stringify([allowed.inputId, null, record(event.data).kind, toolRef])]);
      await ui.scrollTo(logFactSelector(leadLogs, event) + ' [role="button"]', 'original approval tool fact');
      await ui.waitRead(`(()=>{const e=document.querySelector(${literal(logFactSelector(leadLogs, event))});return e&&
        e.dataset.hostLogAnchor===${literal(anchor)}&&e.dataset.hostLogSequence===${literal(String(event.sequence))}&&
        e.innerText.includes(${literal(record(tool.data).name)})&&e.getClientRects().length})()`, 'original tool/result identity and name are visible');
    }
    await ui.waitRead(`!document.querySelector(${literal(leadLogs + ' [data-host-log-kind="text"]')})&&
      !document.querySelector(${literal(leadLogs + ' [data-host-log-kind="thinking"]')})`, 'Tools-only excludes Output and Thinking');
    await filterLogs(); await ui.click('#filter-kind-output', 'restore Output before excluding Tools');
    await ui.click('#filter-kind-tool', 'exclude actual Tools');
    await ui.click('[data-radix-popper-content-wrapper] button', 'save original Tools exclusion', 'Save');
    await ui.waitRead(`!document.querySelector(${literal(logFactSelector(leadLogs, tool))})&&
      !document.querySelector(${literal(logFactSelector(leadLogs, result))})`, 'Tools exclusion hides the actual call and result');
    await filterLogs(); await ui.click('[data-radix-popper-content-wrapper] button', 'restore original Logs controls', 'Reset');
    await ui.click('[data-radix-popper-content-wrapper] button', 'close original restored filters', 'Save');
    assert.deepEqual((await session()).inputs, before.inputs); assert.deepEqual(await commandRows(), before.commands);
    assert.deepEqual(await effects(), before.effects);
    proof.leadLogTools = { inputId: allowed.inputId, toolRef, eventIds: [tool.eventId, result.eventId],
      addedInputs: 0, addedBusinessCommands: 0, addedProviderActions: 0 };
  }
  if (provider !== 'opencode') for (const [marker, allow] of [['TEST_UI_QUESTION', true], ['TEST_UI_QUESTION_DECLINE', false]] as const) {
    const sent = await send(marker);
    await ui.waitRead(`document.querySelector(${literal(sheet)})?.textContent.includes('Choose the TEST route')`, 'original finite Question Sheet');
    const pending = array((await session()).interactions).filter(row => row.phase === 'pending');
    assert.equal(pending.length, 1); assert.equal(pending[0]!.kind, 'question');
    proof[allow ? 'questionScreenshot' : 'questionDeclineScreenshot'] = await screenshot(allow ? 'question-pending' : 'question-decline-pending');
    if (allow) {
      await ui.clickExpression(`(()=>{const rows=[...document.querySelectorAll(${literal(sheet + ' button')})].filter(e=>e.textContent.includes('Alpha'));
        if(rows.length!==1)return null;const e=rows[0],r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);
        return r.width&&r.height&&hit&&(hit===e||e.contains(hit))?{x,y,tag:e.tagName}:null})()`, 'choose original Alpha option');
      await ui.click(`${sheet} button`, 'submit original finite answer once', 'Submit');
    } else { await ui.click(`${sheet} .text-sm.font-semibold`, 'focus original Question Sheet'); await escape(); }
    await terminal(sent.inputId); await visible(allow ? 'TEST question Alpha' : 'TEST question declined');
  }

  const readStats = async () => {
    options.assertOwnedRenderer();
    const read = record(await cdp.evaluate(`window.electronAPI.agentBackend.invoke(${literal({ handle: { handleId: fixture.handleId }, operation: 'team.activity.stats.read', commandId: 'TEST-emulated-stats', payload: { memberName: 'alice' } })})`));
    assert.equal(read.ok, true); return record(record(read.value).stats);
  };
  if (provider === 'codex') {
    const inputsBeforeCost = structuredClone((await session()).inputs), turnsBeforeCost = (await effects()).filter(row => row.event === 'input').length;
    const stats = await readStats();
    assert.equal(stats.inputTokens, array(inputsBeforeCost).length * 120); assert.equal(stats.outputTokens, array(inputsBeforeCost).length * 7);
    const beforeCost = new Set((await commandRows()).map(row => row.commandId));
    await sendDesktopNativeCommandFromComposer(cdp, ui, 'cost', '', catalog => { assert.deepEqual(catalog, ['/cost']); proof.catalog = catalog; });
    const costRows = await poll(commandRows, values => values.some(row => !beforeCost.has(row.commandId) && record(record(row.command).payload).text === '/cost' && row.phase === 'completed'), 'one original local /cost receipt');
    const costs = costRows.filter(row => !beforeCost.has(row.commandId) && record(record(row.command).payload).text === '/cost');
    assert.equal(costs.length, 1);
    const cost = await readNativeHostCostProof({ teamRoot, commandId: String(costs[0]!.commandId), memberName: 'alice', principalId: 'TEST-human', binding: record((await session()).binding), stats });
    assert.deepEqual((await session()).inputs, inputsBeforeCost);
    assert.equal((await effects()).filter(row => row.event === 'input').length, turnsBeforeCost);
    assert.ok(typeof cost.reply.messageId === 'string' && cost.reply.messageId.length > 0);
    const costCard = `[data-timeline-row-key=${literal(cost.reply.messageId)}] article.activity-timeline-card`;
    const expanded = await ui.waitRead(`(()=>{const rows=document.querySelectorAll(${literal(costCard)});return rows.length===1?rows[0].getAttribute('data-expanded'):null})()`, 'one original Codex /cost report card');
    assert.ok(expanded === 'true' || expanded === 'false');
    if (expanded === 'false') {
      const header = `${costCard} > div[role="button"]`;
      await ui.scrollTo(header, 'original Codex /cost report header');
      await ui.click(header, 'expand original Codex /cost report once');
      await ui.waitRead(`document.querySelector(${literal(costCard)})?.getAttribute('data-expanded')==='true'`, 'original Codex /cost report expanded');
    }
    await revealDesktopReply(cdp, String(cost.reply.text), { messageId: cost.reply.messageId,
      assertOwnedRenderer: options.assertOwnedRenderer, step: value => steps.push(value) });
    proof.costScreenshot = await screenshot('cost'); proof.cost = cost;
  } else if (provider === 'claude') {
    const expectedCatalog = ['/compact', '/cost', '/review', '/test-desktop-skill'], commandProofs: Row[] = [];
    for (const [name, args, expected] of [
      ['compact', '', 'TEST context compacted'], ['test-desktop-skill', '', 'TEST skill complete'],
      ['review', 'TEST_UI_REVIEW', 'TEST review complete'], ['cost', '', null],
    ] as const) {
      const before = new Set((await commandRows()).map(row => row.commandId)), beforeStats = await readStats();
      const text = await sendDesktopNativeCommandFromComposer(cdp, ui, name, args, catalog => {
        assert.deepEqual([...catalog].sort(), [...expectedCatalog].sort()); proof.catalog = catalog;
      });
      const sent = await observeSent(before, text);
      assert.equal(record(record(sent.receipt.command).payload).nativeCommand, true);
      await terminal(sent.inputId);
      const expectedText = expected ?? `TEST cost input=${beforeStats.inputTokens} output=${beforeStats.outputTokens} total=$${Number(beforeStats.costUsd).toFixed(4)}`;
      await visible(expectedText);
      const image = await screenshot(name);
      proof[name === 'cost' ? 'costScreenshot' : name === 'test-desktop-skill' ? 'skillScreenshot' : name + 'Screenshot'] = image;
      if (name === 'cost') {
        const after = await readStats();
        for (const key of ['inputTokens', 'outputTokens', 'costUsd']) assert.equal(after[key], beforeStats[key]);
      }
      commandProofs.push({ text, commandId: sent.receipt.commandId, inputId: sent.inputId, reply: expectedText, screenshot: image });
    }
    proof.nativeCommands = commandProofs;
  } else {
    await fill('.message-composer-flat-layout textarea', '/');
    assert.equal(await cdp.evaluate('document.querySelectorAll(\'[role="listbox"] [role="option"] .font-medium\').length'), 0);
    await fill('.message-composer-flat-layout textarea', '');
    proof.catalog = []; proof.unsupportedBaseline = ['structured questions', 'native slash commands', 'native usage counters'];
  }
  const stats = await readStats();
  if (provider === 'opencode') for (const key of ['inputTokens', 'outputTokens', 'costUsd']) assert.equal(stats[key], null);
  if (provider === 'claude') {
    const journal = await effects();
    const teamPids = [...new Set(journal.filter(row => row.role === 'runtime' && row.event === 'mcp-connected').map(row => row.pid))];
    assert.equal(teamPids.length, 1, 'Only the original MCP-connected Team runtime contributes Team usage');
    const actual = journal.filter(row => row.pid === teamPids[0] && row.event === 'terminal');
    assert.ok(actual.length > 0);
    assert.equal(stats.inputTokens, actual.reduce((total, row) => total + Number(record(row.usage).input_tokens), 0));
    assert.equal(stats.outputTokens, actual.reduce((total, row) => total + Number(record(row.usage).output_tokens), 0));
    assert.equal(Number(Number(stats.costUsd).toFixed(4)), Number(Number(actual.at(-1)!.cumulativeCostUsd).toFixed(4)));
    assert.equal(stats.compactions, 1);
  }
  proof.stats = stats;
  await ui.scrollTo(
    'div[role="button"][tabindex="0"][class~="group/member"] span',
    'reveal original member detail name', 'alice', 12, { requireCenterHit: true }
  );
  await ui.clickExpression(`(()=>{const rows=[...document.querySelectorAll('div[role="button"][tabindex="0"][class~="group/member"]')].filter(e=>[...e.querySelectorAll('span')].some(n=>n.textContent.trim()==='alice'));
    if(rows.length!==1)return null;const e=rows[0],names=[...e.querySelectorAll('span')].filter(n=>n.textContent.trim()==='alice');if(names.length!==1)return null;
    const n=names[0],r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);
    return r.width&&r.height&&hit&&!hit.closest('button')&&(hit===e||e.contains(hit))?{x,y,tag:e.tagName}:null})()`, 'open original member detail');
  await ui.click('[role="dialog"] [role="tab"]', 'original Member Logs', 'Logs');
  await ui.waitRead(`document.querySelector('[role="dialog"] [role="tabpanel"][data-state="active"]')?.textContent.includes('Captured runtime activity')`, 'original Host Logs');
  proof.logsScreenshot = await screenshot('logs');
  await ui.click('[role="dialog"] [role="tab"]', 'original Member Stats', 'Stats');
  const tokenText = (value: unknown) => value === null ? 'Unknown' : Number(value).toLocaleString();
  for (const [label, value] of [['Reported input tokens', tokenText(stats.inputTokens)], ['Reported output tokens', tokenText(stats.outputTokens)],
    ['Reported cost (USD)', stats.costUsd === null ? 'Unknown' : Number(stats.costUsd).toFixed(6)]])
    await ui.waitRead(`(()=>{const e=document.querySelector('[role="dialog"] [role="tabpanel"][data-state="active"]');const row=[...e.querySelectorAll('div')].find(n=>n.textContent===${literal(label)});return row?.parentElement?.firstElementChild?.textContent===${literal(value)}})()`, 'original exact Stats ' + label);
  proof.statsScreenshot = await screenshot('stats');
  await ui.click('[role="dialog"] button', 'close original member detail', 'Close');
  const reloadInputs = structuredClone((await session()).inputs), reloadEffects = (await effects()).filter(row => row.event === 'input').length;
  const epoch = await cdp.evaluate('performance.timeOrigin'); await cdp.send('Page.reload', { ignoreCache: false });
  await ui.waitRead(`performance.timeOrigin!==${literal(epoch)}&&Boolean(window.electronAPI)&&!document.getElementById('splash')`, 'new renderer epoch');
  await ui.observeInput(); await ui.clickSidebar(fixture.uiSeed.subject);
  await ui.click('button[aria-label^="alice,"]', 'reopen original lead conversation');
  await visible('TEST stream partial complete');
  await openLeadLogs();
  proof.leadLogsAfterReload = await visibleLogFact(leadLogs, completeEvent);
  if (stderrEvent) proof.stderrLogsAfterReload = await visibleLogFact(leadLogs, stderrEvent);
  if (completeThought) proof.thinkingLogsAfterReload = await visibleLogFact(leadLogs, completeThought);
  if (partialThought) await ui.waitRead(`!document.querySelector(${literal(logFactSelector(leadLogs, partialThought))})`,
    'cold Thinking read retains complete precedence');
  assert.deepEqual((await session()).inputs, reloadInputs); assert.equal((await effects()).filter(row => row.event === 'input').length, reloadEffects);
  proof.reloadedScreenshot = await screenshot('reloaded'); proof.reloadWithoutReplay = true;

  const section = '[data-section-id="schedules"]', label = 'TEST UI scheduled task', edited = 'TEST UI edited schedule';
  const scheduleRow = (label: string) => `${section} div.rounded-md:has(>div>button[aria-label=${literal(label)}])`;
  const schedules = async () => array(await cdp.evaluate('window.electronAPI.schedules.list()'));
  const history = async (id: string) => array(await cdp.evaluate(`window.electronAPI.schedules.getRuns(${literal(id)})`));
  const openSection = async () => {
    const expand = `${section} button[aria-label="Expand section"]`;
    if (await cdp.evaluate(`Boolean(document.querySelector(${literal(expand)}))`)) {
      await ui.scrollTo(expand, 'original Schedules section'); await ui.click(expand, 'expand original Schedules section');
    }
  };
  const menu = async (label: string, action: string) => {
    const button = `${scheduleRow(label)} button[aria-label="More actions"]`;
    await ui.scrollTo(button, 'original schedule menu'); await ui.click(button, 'open original schedule menu');
    await ui.click('[data-radix-popper-content-wrapper] button', 'original schedule ' + action, action);
  };
  await openSection();
  if (provider === 'claude') {
    const original = await schedules(); assert.equal(original.length, 1); assert.equal(original[0]!.id, LEGACY_SCHEDULE_ID);
    assert.equal(original[0]!.hostTarget, undefined); assert.equal(original[0]!.status, 'paused');
    const taskDirectory = join(fixture.root, 'hoststore/tasks/test-desktop-backend'), beforeStandaloneTasks = await rows(taskDirectory);
    const save = async () => {
      await ui.scrollTo('[role="dialog"] button', 'original legacy Save Changes', 'Save Changes');
      await ui.click('[role="dialog"] button', 'save and rebind original legacy schedule once', 'Save Changes');
      await ui.waitRead(`!document.querySelector('[role="dialog"]')`, 'legacy schedule Save completed');
    };
    await menu(LEGACY_SCHEDULE_LABEL, 'Edit');
    await fill('[role="dialog"] #schedule-label', EDITED_SCHEDULE_LABEL);
    await fill('[role="dialog"] #schedule-max-turns', '6'); await fill('[role="dialog"] #schedule-max-budget', '0.25');
    await save();
    const editedLegacy = (await schedules())[0]!;
    assert.equal(record(editedLegacy.hostTarget).handleId, fixture.handleId);
    assert.equal(editedLegacy.executionMode, undefined); assert.notEqual(editedLegacy.taskFirst, true);
    assert.equal(editedLegacy.maxTurns, 6); assert.equal(editedLegacy.maxBudgetUsd, 0.25);
    assert.equal(record(editedLegacy.launchConfig).prompt, 'TEST_UI_STANDALONE_DONE');
    assert.equal(record(editedLegacy.launchConfig).skipPermissions, true);
    for (const [action, status] of [['Resume', 'active'], ['Pause', 'paused'], ['Resume', 'active']] as const) {
      await menu(EDITED_SCHEDULE_LABEL, action);
      await poll(schedules, values => values[0]?.id === LEGACY_SCHEDULE_ID && values[0]?.status === status, 'legacy original schedule status ' + status);
    }
    assert.ok(Date.parse(String((await schedules())[0]!.nextRunAt)) > Date.now());
    assert.equal((await history(LEGACY_SCHEDULE_ID)).length, 0);
    const runLegacy = `${scheduleRow(EDITED_SCHEDULE_LABEL)} button[aria-label="Run now"]`;
    await ui.scrollTo(runLegacy, 'original standalone Run now'); await ui.click(runLegacy, 'run original standalone once');
    const completedRuns = await poll(() => history(LEGACY_SCHEDULE_ID), values => values.length === 1 && values[0]!.status === 'completed', 'original standalone completion');
    const completedRunId = String(completedRuns[0]!.id); assert.equal(completedRuns[0]!.exitCode, 0);
    const captures = await rows(join(teamRoot, '.host-owner/scheduled-runs'));
    const selected = captures.filter(row => record(row.input).runId === completedRunId);
    assert.equal(selected.length, 1);
    const input = record(selected[0]!.input);
    assert.equal(input.scheduleId, LEGACY_SCHEDULE_ID); assert.equal(input.maxTurns, 6); assert.equal(input.maxBudgetUsd, 0.25);
    assert.equal(record(input.config).prompt, 'TEST_UI_STANDALONE_DONE');
    assert.deepEqual(await rows(taskDirectory), beforeStandaloneTasks, 'standalone creates no hidden Team task');
    const completedSession = (await readDesktopNativeStopSessions(fixture.root)).find(row =>
      record(row.binding).runId === 'scheduled-standalone' && record(row.binding).generation === completedRunId);
    assert.ok(completedSession);
    const standaloneBinding = record(completedSession.binding);
    const retained = await json(join(fixture.root, 'hoststore/runtime-events', runtimeDigest(standaloneBinding) + '.json'));
    const { digest, ...body } = retained;
    assert.equal(runtimeDigest(body), digest); assert.deepEqual(retained.binding, standaloneBinding);
    const thought = array(retained.events).find(row => record(row.data).kind === 'thinking');
    const output = array(retained.events).find(row => record(row.data).kind === 'text' && record(row.data).text === 'TEST standalone complete');
    const diagnostic = array(retained.events).find(row => record(row.data).kind === 'process-output');
    assert.ok(thought && output && diagnostic);
    assert.deepEqual(record(thought.data), { kind: 'thinking', messageRef: record(output.data).messageRef,
      block: 1, text: 'TEST standalone thought complete', phase: 'complete' });
    assert.equal(thought.inputId, completedRunId);
    assert.equal(array(completedSession.inputs).length, 1);
    assert.equal(thought.operationRef, array(completedSession.inputs)[0]!.operationRef);
    assert.deepEqual(diagnostic.data, { kind: 'process-output', stream: 'stderr', text: 'TEST standalone stderr' });
    assert.equal(diagnostic.inputId, undefined); assert.equal(diagnostic.operationRef, undefined);
    options.assertOwnedRenderer();
    const savedLogs = record(await cdp.evaluate(`window.electronAPI.schedules.getRunLogs(${literal(LEGACY_SCHEDULE_ID)},${literal(completedRunId)})`));
    const savedThought = String(savedLogs.stdout).split('\n').map(line => record(JSON.parse(line))).filter(row => row.uuid === thought.eventId);
    assert.equal(savedThought.length, 1);
    assert.deepEqual(record(savedThought[0]!.message).content, [{ type: 'thinking', thinking: record(thought.data).text }]);
    assert.ok(String(savedLogs.stderr).split('\n').includes(String(record(diagnostic.data).text)));
    assert.equal(completedRuns[0]!.summary, 'TEST standalone complete');
    await ui.scrollTo(`${scheduleRow(EDITED_SCHEDULE_LABEL)} button[aria-label=${literal(EDITED_SCHEDULE_LABEL)}]`, 'original standalone history');
    await ui.click(`${scheduleRow(EDITED_SCHEDULE_LABEL)} button[aria-label=${literal(EDITED_SCHEDULE_LABEL)}]`, 'expand original standalone history');
    await ui.scrollTo(`${scheduleRow(EDITED_SCHEDULE_LABEL)} div[role="button"]`, 'reveal original completed standalone log');
    await ui.click(`${scheduleRow(EDITED_SCHEDULE_LABEL)} div[role="button"]`, 'open original completed standalone log');
    await ui.waitRead(`document.querySelector('[role="dialog"]')?.textContent.includes('TEST standalone complete')`, 'original completed standalone stdout');
    const thoughtRow = '[role="dialog"] div.rounded:has(> [role="button"] svg.lucide-brain)';
    await ui.scrollTo(thoughtRow + ' [role="button"]', 'original scheduled Thinking');
    await ui.click(thoughtRow + ' [role="button"]', 'expand original scheduled Thinking');
    await ui.scrollTo(thoughtRow + ' p', 'actual scheduled Thinking Markdown', String(record(thought.data).text), 12, { requireCenterHit: true });
    const thoughtCopy = thoughtRow + ' button[title="Copy to clipboard"]';
    await ui.scrollTo(thoughtCopy, 'original scheduled Thinking copy'); await ui.click(thoughtCopy, 'copy scheduled Thinking');
    await ui.waitRead(`Boolean(document.querySelector(${literal(thoughtCopy + ' svg.lucide-check')}))`, 'scheduled Thinking clipboard acknowledged');
    options.assertOwnedRenderer();
    assert.equal(await cdp.evaluate('navigator.clipboard.readText()'), record(thought.data).text);
    await ui.scrollTo('[role="dialog"] pre', 'original scheduled stderr', String(savedLogs.stderr).trim(), 12, { requireCenterHit: true });
    await ui.waitRead(`document.querySelector('[role="dialog"] pre')?.textContent===${literal(savedLogs.stderr)}`, 'saved stderr renders unchanged');
    proof.standaloneCompletedScreenshot = await screenshot('standalone-completed');
    await escape(); await ui.waitRead(`!document.querySelector('[role="dialog"]')`, 'original standalone log closed');
    await menu(EDITED_SCHEDULE_LABEL, 'Edit'); await fill('[role="dialog"] #dialog-prompt', 'TEST_UI_STANDALONE_HOLD'); await save();
    await ui.scrollTo(runLegacy, 'original held standalone Run now'); await ui.click(runLegacy, 'run original held standalone once');
    const heldRuns = await poll(() => history(LEGACY_SCHEDULE_ID), values => values.length === 2 && values.some(row => row.status === 'running'), 'one original active standalone run');
    const heldRunId = String(heldRuns.find(row => row.status === 'running')!.id);
    await poll(effects, values => values.some(row => row.event === 'partial' && row.marker === 'TEST_UI_STANDALONE_HOLD'), 'original standalone held peer');
    await ui.waitRead(`document.querySelector(${literal(scheduleRow(EDITED_SCHEDULE_LABEL))})?.textContent.includes('Running')`, 'original active standalone row');
    proof.standaloneHeldScreenshot = await screenshot('standalone-held');
    await menu(EDITED_SCHEDULE_LABEL, 'Delete');
    await ui.click('[role="alertdialog"] button, [role="dialog"] button', 'delete original active standalone schedule once', 'Delete');
    await poll(schedules, values => values.length === 0, 'original active standalone schedule deleted');
    const stopped = await poll(() => readDesktopNativeStopSessions(fixture.root), values => values.some(row =>
      record(row.binding).runId === 'scheduled-standalone' && record(row.binding).generation === heldRunId &&
      row.phase === 'closed' && row.custody === 'released'), 'original standalone owner releases custody');
    const heldRecord = stopped.find(row => record(row.binding).runId === 'scheduled-standalone' && record(row.binding).generation === heldRunId)!;
    assert.equal(array(heldRecord.inputs).some(row => row.terminal === 'succeeded'), false);
    const standaloneInputs = (await effects()).filter(row => row.event === 'input' && ['TEST_UI_STANDALONE_DONE', 'TEST_UI_STANDALONE_HOLD'].includes(String(row.marker)));
    assert.equal(standaloneInputs.length, 2);
    const originalPids = [...new Set(standaloneInputs.map(row => Number(row.pid)))]; assert.equal(originalPids.length, 2);
    await poll(async () => processTable(), values => originalPids.every(pid => !values.some(row => row.pid === pid)), 'original standalone peer PIDs absent after deletion');
    assert.equal((await effects()).some(row => row.event === 'terminal' && row.marker === 'TEST_UI_STANDALONE_HOLD' && row.outcome === 'succeeded'), false);
    assert.deepEqual(await rows(taskDirectory), beforeStandaloneTasks);
    proof.standaloneDeletedScreenshot = await screenshot('standalone-deleted');
    proof.standalone = { scheduleId: LEGACY_SCHEDULE_ID, completedRunId, heldRunId, logVisible: true,
      thinkingEventId: thought.eventId, stderrEventId: diagnostic.eventId, activityDigest: digest, actualThinkingClipboard: true,
      limits: { maxTurns: 6, maxBudgetUsd: 0.25 }, originalPids, deletedWhileActive: true, cleanup: 'confirmed',
      releasedRecord: heldRecord, capture: selected[0], taskWrites: 0 };
  }
  assert.equal((await schedules()).length, 0);
  await ui.scrollTo(`${section} button`, 'original Add Schedule', 'Add Schedule');
  await ui.click(`${section} button`, 'open original Add Schedule', 'Add Schedule');
  await fill('[role="dialog"] #schedule-label', label);
  await fill('[role="dialog"] input[placeholder="0 9 * * 1-5"]', '0 0 1 1 *');
  await fill('[role="dialog"] #dialog-prompt', 'TEST_UI_SCHEDULE_DONE');
  const historicalPrompt = '[role="dialog"] #schedule-saved-prompt-reviewed';
  await ui.waitRead(`document.querySelector(${literal(historicalPrompt)})?.closest('section')?.querySelector('pre')?.textContent==='TEST_UI_BOOT'`, 'original saved prompt review');
  assert.equal(await cdp.evaluate(`document.querySelector(${literal(historicalPrompt)})?.getAttribute('data-state')`), 'unchecked');
  await ui.scrollTo(historicalPrompt, 'original historical prompt acknowledgement');
  await ui.click(historicalPrompt, 'acknowledge original saved prompt without replay once');
  await ui.waitRead(`document.querySelector(${literal(historicalPrompt)})?.getAttribute('data-state')==='checked'`, 'original saved prompt acknowledged');
  await ui.scrollTo('[role="dialog"] button', 'original Create Schedule', 'Create Schedule');
  await ui.click('[role="dialog"] button', 'create original future schedule once', 'Create Schedule');
  await ui.waitRead(`!document.querySelector('[role="dialog"]')`, 'schedule create closes');
  const created = (await schedules()).filter(row => row.label === label); assert.equal(created.length, 1);
  const scheduleId = String(created[0]!.id); assert.equal(created[0]!.taskFirst, true); assert.equal(created[0]!.executionMode, 'agent');
  assert.equal(created[0]!.reviewedSavedPrompt, true);
  await menu(label, 'Edit'); await fill('[role="dialog"] #schedule-label', edited);
  await ui.scrollTo('[role="dialog"] button', 'original Save Changes', 'Save Changes');
  await ui.click('[role="dialog"] button', 'save original schedule edit once', 'Save Changes');
  await ui.waitRead(`!document.querySelector('[role="dialog"]')`, 'schedule edit closes');
  for (const [action, status] of [['Pause', 'paused'], ['Resume', 'active']] as const) {
    await menu(edited, action); await poll(schedules, rows => rows.find(row => row.id === scheduleId)?.status === status, 'original schedule status ' + status);
  }
  assert.equal((await history(scheduleId)).length, 0);
  const beforeTasks = await rows(join(fixture.root, 'hoststore/tasks/test-desktop-backend'));
  const run = `${scheduleRow(edited)} button[aria-label="Run now"]`;
  await ui.scrollTo(run, 'original Run now'); await ui.click(run, 'dispatch scheduled task once');
  const runs = await poll(() => history(scheduleId), rows => rows.length === 1 && rows[0]!.status === 'dispatched', 'one original task-first dispatch');
  const taskId = String(runs[0]!.linkedTaskId);
  const tasks = await poll(() => rows(join(fixture.root, 'hoststore/tasks/test-desktop-backend')),
    rows => rows.some(row => row.id === taskId && row.status === 'completed'), 'scheduled original MCP task completion',
    observedEffects => observedEffects.some(row => row.event === (provider === 'claude' ? 'scheduled' : 'scheduled-effect') &&
      row.taskId === taskId));
  assert.equal(tasks.length, beforeTasks.length + 1); assert.equal(tasks.find(row => row.id === taskId)?.owner, 'alice');
  await ui.scrollTo('button[aria-label="Back to chats"]', 'original scheduled conversation list');
  await ui.click('button[aria-label="Back to chats"]', 'return to original chats before scheduled reply');
  await ui.scrollTo('button[aria-label^="alice,"]', 'original scheduled lead chat');
  await ui.click('button[aria-label^="alice,"]', 'show original scheduled reply', undefined, 'TEST scheduled '); await visible('TEST scheduled reply');
  await openSection();
  await ui.scrollTo(`${scheduleRow(edited)} button[aria-label=${literal(edited)}]`, 'original schedule history');
  await ui.click(`${scheduleRow(edited)} button[aria-label=${literal(edited)}]`, 'expand original schedule history');
  assert.equal(record((await ownerState()).savedSettings).prompt, 'TEST_UI_BOOT');
  assert.equal((await effects()).filter(row => row.event === 'input' && row.marker === 'TEST_UI_BOOT').length, 1);
  proof.scheduleScreenshot = await screenshot('schedule'); proof.schedule = { scheduleId, runId: runs[0]!.id, taskId, status: runs[0]!.status,
    savedPromptAcknowledged: true, savedPromptNotReplayed: true };
  // A real wall-clock occurrence, selected through the original Edit dialog. No
  // private tick, clock replacement or second Run now can satisfy this witness.
  const scheduledAt = Math.ceil((Date.now() + 60_000) / 1000) * 1000;
  const timezone = String(created[0]!.timezone);
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hourCycle: 'h23',
    month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(scheduledAt);
  const part = (name: string) => {
    const selected = parts.filter(row => row.type === name); assert.equal(selected.length, 1);
    return String(Number(selected[0]!.value));
  };
  const cronExpression = `${part('second')} ${part('minute')} ${part('hour')} ${part('day')} ${part('month')} *`;
  await menu(edited, 'Edit');
  await fill('[role="dialog"] input[placeholder="0 9 * * 1-5"]', cronExpression);
  await ui.scrollTo('[role="dialog"] button', 'original automatic schedule Save Changes', 'Save Changes');
  await ui.click('[role="dialog"] button', 'save original real cron occurrence once', 'Save Changes');
  await ui.waitRead(`!document.querySelector('[role="dialog"]')`, 'automatic schedule edit closes');
  const armed = (await schedules()).find(row => row.id === scheduleId)!;
  assert.equal(armed.status, 'active'); assert.equal(armed.cronExpression, cronExpression);
  assert.equal(armed.timezone, timezone); assert.equal(Date.parse(String(armed.nextRunAt)), scheduledAt);
  assert.ok(scheduledAt - Date.now() >= 10_000, 'the real cron occurrence is armed before its wall-clock deadline');
  assert.deepEqual(await history(scheduleId), runs, 'editing the cron does not create an occurrence');
  const historyObservation = createDesktopScheduleHistoryObservation(proof, armed, runs[0]!.id);
  const automaticRuns = await poll(async () => historyObservation.observe(await history(scheduleId)), values => values.length === 2 &&
    values.some(row => row.id !== runs[0]!.id && row.status === 'dispatched'), 'real automatic cron dispatch without Run now');
  const automaticRun = automaticRuns.find(row => row.id !== runs[0]!.id)!;
  assert.equal(automaticRun.scheduleId, scheduleId);
  const occurrenceTime = Date.parse(String(automaticRun.scheduledFor));
  assert.ok(occurrenceTime >= scheduledAt && occurrenceTime < scheduledAt + 15_000);
  assert.equal(automaticRun.startedAt, automaticRun.scheduledFor);
  assert.notEqual(automaticRun.linkedTaskId, taskId);
  const automaticTaskId = String(automaticRun.linkedTaskId);
  const automaticTasks = await poll(() => rows(join(fixture.root, 'hoststore/tasks/test-desktop-backend')),
    (values, observedEffects) => values.some(row => row.id === automaticTaskId && row.status === 'completed') &&
      observedEffects.some(row => row.event === (provider === 'claude' ? 'scheduled' : 'scheduled-effect') &&
        row.taskId === automaticTaskId), 'automatic original MCP task completion',
    observedEffects => observedEffects.some(row => row.event === (provider === 'claude' ? 'scheduled' : 'scheduled-effect') &&
      row.taskId === automaticTaskId));
  assert.equal(automaticTasks.length, beforeTasks.length + 2);
  assert.equal(automaticTasks.find(row => row.id === automaticTaskId)?.owner, 'alice');
  assert.equal((await effects()).filter(row => row.event === 'input' && row.marker === 'TEST_UI_SCHEDULE_DONE').length, 2);
  const automaticEffects = (await effects()).filter(row => ['scheduled', 'scheduled-effect'].includes(String(row.event)) && row.taskId === automaticTaskId);
  assert.equal(automaticEffects.length, 1, 'one peer effect joined to the automatic occurrence task');
  assert.equal((await effects()).filter(row => row.event === 'input' && row.marker === 'TEST_UI_BOOT').length, 1);
  assert.equal(record((await ownerState()).savedSettings).prompt, 'TEST_UI_BOOT');
  await menu(edited, 'Pause');
  await poll(schedules, values => values.find(row => row.id === scheduleId)?.status === 'paused', 'pause after automatic occurrence');
  assert.equal((await history(scheduleId)).length, 2);
  proof.automaticSchedule = { scheduleId, runId: automaticRun.id, taskId: automaticTaskId,
    cronExpression, timezone, armedAt: historyObservation.armedAt, selectedNextRunAt: armed.nextRunAt,
    scheduledFor: automaticRun.scheduledFor, startedAt: automaticRun.startedAt,
    status: automaticRun.status, trigger: 'real-cron-tick', runNowClicks: 0, taskCompleted: true,
    savedPromptNotReplayed: true, peerEffect: automaticEffects[0], paused: true,
    screenshot: await screenshot('schedule-automatic') };
  await menu(edited, 'Delete');
  await ui.click('[role="alertdialog"] button, [role="dialog"] button', 'confirm original schedule deletion', 'Delete');
  await poll(schedules, rows => rows.length === 0, 'schedule removed');
  assert.equal((await rows(join(fixture.root, 'hoststore/tasks/test-desktop-backend'))).find(row => row.id === taskId)?.status, 'completed');
  assert.equal((await rows(join(fixture.root, 'hoststore/tasks/test-desktop-backend'))).find(row => row.id === automaticTaskId)?.status, 'completed');

  // The original cron Task supplies real retained input facts; these UI reads never start work.
  const activityCommands = await commandRows();
  const starts = activityCommands.filter(row => record(row.command).operation === 'task.start' &&
    record(record(row.command).payload).taskId === automaticTaskId);
  assert.equal(starts.length, 1); const taskStart = starts[0]!; assert.equal(taskStart.phase, 'completed');
  const deliveries = (await rows(join(teamRoot, '.host-owner/outbox'))).filter(row => row.commandId === taskStart.commandId);
  assert.equal(deliveries.length, 1); const delivery = deliveries[0]!;
  assert.equal(delivery.inputId, delivery.deliveryId); assert.equal(delivery.phase, 'admitted');
  const activityRuntime = await terminal(delivery.inputId);
  const taskInputs = array(activityRuntime.inputs).filter(row => record(row.intent).inputId === delivery.inputId);
  assert.equal(taskInputs.length, 1); const taskInput = taskInputs[0]!, intent = record(taskInput.intent);
  const { teamName: deliveryTeam, ...deliveryBinding } = record(delivery.binding);
  assert.equal(deliveryTeam, 'test-desktop-backend');
  assert.deepEqual(intent.binding, activityRuntime.binding); assert.deepEqual(intent.binding, deliveryBinding);
  for (const field of ['inputId', 'deliveryId', 'messageId', 'content']) assert.equal(intent[field], delivery[field]);
  const binding = record(activityRuntime.binding);
  for (const field of ['backendId', 'teamId']) assert.equal(record(taskStart.binding)[field], binding[field]);
  assert.equal(binding.runId, capture.launchId); assert.equal(binding.memberId, 'alice-id');
  const activityPath = join(fixture.root, 'hoststore/runtime-events', runtimeDigest(binding) + '.json');
  const retained = await json(activityPath), { digest: activityDigest, ...activityBody } = retained;
  assert.equal(runtimeDigest(activityBody), activityDigest); assert.deepEqual(retained.binding, binding);
  const inputEvents = array(retained.events).filter(row => row.inputId === delivery.inputId);
  assert.ok(inputEvents.length > 0 && inputEvents.every(row => row.operationRef === taskInput.operationRef));
  const completion = inputEvents.filter(row => record(row.data).kind === 'text' &&
    record(row.data).text === 'TEST scheduled complete').at(-1);
  assert.ok(completion, 'the original provider protocol result is retained for this Task input');
  const beforeActivity = { inputs: activityRuntime.inputs, effects: await effects(),
    tasks: await rows(join(fixture.root, 'hoststore/tasks/test-desktop-backend')) };
  const completedTask = beforeActivity.tasks.find(row => row.id === automaticTaskId)!;
  assert.equal(completedTask.status, 'completed'); assert.equal(completedTask.owner, 'alice');
  const card = `.kanban-task-card[data-task-id=${literal(automaticTaskId)}] h5`;
  await ui.scrollTo(card, 'original completed cron Task card');
  await ui.click(card, 'open original completed Task detail');
  await ui.waitRead(`document.querySelector('[role="dialog"]')?.textContent.includes(${literal(completedTask.subject)})`, 'original completed Task detail');
  const logs = '[role="dialog"] section:has([role="tab"][aria-controls$="-content-stream"])';
  await ui.waitRead(`document.querySelectorAll(${literal(logs)}).length===1&&[...document.querySelector(${literal(logs)}).querySelectorAll('span')].some(e=>e.textContent==='Task Logs')`, 'one original Task Logs section');
  await ui.scrollTo(`${logs} > div > button[aria-label="Expand section"]`, 'original Task Logs header');
  await ui.click(`${logs} > div > button[aria-label="Expand section"]`, 'expand original Task Logs');
  const activityViews: Row[] = [];
  for (const [tab, marker] of [['Task Activity', 'Captured Task input'], ['Task Log Stream', 'Captured runtime activity']] as const) {
    await ui.scrollTo(`${logs} [role="tab"]`, 'original ' + tab, tab);
    await ui.click(`${logs} [role="tab"]`, 'select original ' + tab, tab);
    const panel = `${logs} [role="tabpanel"][data-state="active"]`;
    const title = await ui.waitRead(`(()=>{const rows=[...document.querySelectorAll(${literal(panel + ' button[aria-expanded="false"]')})]
      .filter(e=>e.textContent.includes(${literal('alice · ' + marker)})&&e.textContent.includes(${literal('generation ' + binding.generation)}));
      return rows.length===1?rows[0].textContent.trim():null})()`, 'one original Task input in ' + tab);
    assert.ok(typeof title === 'string');
    await ui.scrollTo(`${panel} button[aria-expanded="false"]`, 'original ' + tab + ' disclosure', title);
    await ui.click(`${panel} button[aria-expanded="false"]`, 'open original ' + tab + ' facts', title);
    const rendered = await visibleLogFact(panel, completion, title);
    assert.equal(await cdp.evaluate(`document.querySelector(${literal(panel)})?.textContent.includes(${literal(stderrText)})`), false,
      'unattributed member stderr cannot enter exact Task logs');
    activityViews.push({ tab, rendered, screenshot: await screenshot(tab === 'Task Activity' ? 'task-activity' : 'task-log-stream') });
  }
  await ui.click('[role="dialog"] button', 'close original Task detail', 'Close');
  await ui.waitRead(`!document.querySelector('[role="dialog"]')`, 'original Task detail closed');
  assert.deepEqual((await session()).inputs, beforeActivity.inputs, 'Task reads add no Runtime input');
  assert.deepEqual(await commandRows(), activityCommands, 'Task reads add no business command');
  assert.deepEqual(await effects(), beforeActivity.effects, 'Task reads add no provider action');
  assert.deepEqual(await rows(join(fixture.root, 'hoststore/tasks/test-desktop-backend')), beforeActivity.tasks);
  assert.equal((await json(activityPath)).digest, activityDigest, 'Task reads do not rewrite retained events');
  proof.taskActivity = { taskId: automaticTaskId, taskStartCommandId: taskStart.commandId,
    deliveryId: delivery.deliveryId, inputId: delivery.inputId, binding, operationRef: taskInput.operationRef,
    eventId: completion.eventId, sequence: completion.sequence, activityDigest, views: activityViews,
    addedInputs: 0, addedBusinessCommands: 0, addedProviderActions: 0 };

  await ui.scrollTo('button[aria-label="Back to chats"]', 'original Back to chats before held input');
  await ui.click('button[aria-label="Back to chats"]', 'return to original chat list before held input');
  await ui.scrollTo('button[aria-label^="alice,"]', 'original lead chat before stop');
  await ui.click('button[aria-label^="alice,"]', 'open original lead chat before stop');
  const held = await send('TEST_UI_HOLD'); await visible('TEST held partial');
  const originalPids = (await effects()).filter(row => ['connected', 'mcp-connected'].includes(String(row.event))).map(row => Number(row.pid));
  assert.ok(originalPids.length > 0);
  proof.heldScreenshot = await screenshot('held');
  await ui.scrollTo('button[aria-label="Stop"]', 'original Team Stop'); await ui.click('button[aria-label="Stop"]', 'stop original Team once', 'Stop');
  await poll(session, value => value.phase === 'closed' && value.custody === 'released', 'original Host released custody');
  const stoppedInput = array((await session()).inputs).find(row => record(row.intent).inputId === held.inputId);
  assert.ok(stoppedInput); assert.equal(stoppedInput.phase, 'unknown'); assert.equal(stoppedInput.terminal, undefined);
  proof.stoppedInput = { inputId: held.inputId, phase: stoppedInput.phase, terminalConfirmed: false };
  await poll(async () => processTable(), rows => originalPids.every(pid => !rows.some(row => row.pid === pid)), 'original peer PIDs absent after Team Stop');
  proof.stoppedScreenshot = await screenshot('stopped'); proof.originalRuntimePids = originalPids; proof.stopReleased = true;
  proof.effects = await effects(); proof.fixturePins = await verifyDesktopEmulatedRuntimeFixture(fixture);
  await writeFile(join(fixture.root, 'ui-emulated-runtime-effects.json'), JSON.stringify(proof.effects, null, 2), { mode: 0o600, flag: 'wx' });
  proof.status = 'PASS'; proof.visualReview = 'Original screenshot files require independent inspection';
}
