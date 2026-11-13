import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readNativeHostCostProof } from '../../packages/legacy-agent-host/tests/fixtures/native-host-cost.ts';
import { fileDigest } from './desktop-backend-fixture.ts';
import { processTable } from './desktop-backend-observations.ts';
import { readDesktopEmulatedRuntimeEffects, verifyDesktopEmulatedRuntimeFixture } from './desktop-emulated-runtime-fixture.ts';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';
import { sendDesktopNativeCommandFromComposer } from './desktop-native-commands-ui-proof.ts';
import { json, record, rows } from './desktop-resume-records.ts';
import { revealDesktopReply } from './desktop-reply-visibility.ts';
import { createDesktopUiControls, desktopJsLiteral as literal } from './desktop-ui-controls.ts';
import type { prepareDesktopEmulatedRuntimeFixture } from './desktop-emulated-runtime-fixture.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';

type Row = Record<string, unknown>;
const array = (value: unknown): Row[] => { assert.ok(Array.isArray(value)); return value.map(record); };

/** Original renderer controls create all business writes; only the TEST peer stream gate is external. */
export async function runDesktopEmulatedRuntimeUi(cdp: UiCdpPort, options: {
  fixture: Awaited<ReturnType<typeof prepareDesktopEmulatedRuntimeFixture>>;
  evidence: Row;
  assertOwnedRenderer(): void;
}) {
  const { fixture } = options, steps: Row[] = [], commands: Row[] = [];
  const proof: Row = { status: 'INCOMPLETE', provider: fixture.emulatedRuntime.provider, steps, commands,
    scope: 'Original Launch, Composer stream, permission/question controls, cost/Stats, schedules, renderer reload and Team Stop through original Host/D and finite TEST protocol peers',
    excluded: ['vendor inference/authentication', 'per-turn interrupt UI (no original control)', 'native provider qualification'] };
  options.evidence.emulatedRuntimeUiProof = proof;
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
    .filter(e=>e.textContent.includes('Optional launch settings')&&e.textContent.includes('TEST'));
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
  assert.equal(record(saved.savedSettings).model, 'TEST-model');
  assert.equal(record(saved.savedSettings).skipPermissions, false);
  const session = async () => {
    const all = (await readDesktopNativeStopSessions(fixture.root)).filter(row => record(row.binding).runId === capture.launchId);
    assert.equal(all.length, 1); return all[0]!;
  };
  await poll(session, value => array(value.inputs).length === 1 && array(value.inputs)[0]!.terminal === 'succeeded', 'original boot prompt completes once');
  await ui.click('button[aria-label^="alice,"]', 'open original lead conversation');
  await visible('TEST boot ready'); proof.launchScreenshot = await screenshot('launch'); proof.capture = capture;
  const send = async (text: string) => {
    const before = new Set((await commandRows()).map(row => row.commandId));
    await fill('.message-composer-flat-layout textarea', text);
    await ui.click('button.message-composer-send-button', 'original Composer Send once', 'Send');
    const entries = await poll(commandRows, values => values.some(row => !before.has(row.commandId) &&
      record(row.command).operation === 'message.send' && record(record(row.command).payload).text === text && row.phase === 'completed'), 'original message receipt');
    const matches = entries.filter(row => !before.has(row.commandId) && record(row.command).operation === 'message.send' && record(record(row.command).payload).text === text);
    assert.equal(matches.length, 1); const receipt = matches[0]!, inputId = record(receipt.effects).deliveryId;
    assert.equal(typeof inputId, 'string'); commands.push({ text, commandId: receipt.commandId, inputId });
    return { receipt, inputId };
  };
  const terminal = async (inputId: unknown, outcome = 'succeeded') => {
    const value = await poll(session, value => array(value.inputs).some(row => record(row.intent).inputId === inputId && row.phase === 'terminal'), 'original correlated input terminal');
    const matches = array(value.inputs).filter(row => record(row.intent).inputId === inputId);
    assert.equal(matches.length, 1); assert.equal(matches[0]!.terminal, outcome); return value;
  };
  const stream = await send('TEST_UI_STREAM');
  await visible('TEST stream partial');
  assert.equal(await cdp.evaluate('document.body.innerText.includes("TEST stream partial complete")'), false);
  assert.notEqual(array((await session()).inputs).find(row => record(row.intent).inputId === stream.inputId)?.phase, 'terminal');
  proof.partialScreenshot = await screenshot('partial');
  await writeFile(join(fixture.emulatedRuntime.peers[0]!.root, 'release-stream'), 'TEST release once\n', { mode: 0o600, flag: 'wx' });
  await terminal(stream.inputId); await visible('TEST stream partial complete');
  proof.completedScreenshot = await screenshot('completed');
  const sheet = 'div.fixed.bottom-4';
  for (const [marker, allowed] of [['TEST_UI_APPROVAL_DENY', false], ['TEST_UI_APPROVAL_ALLOW', true]] as const) {
    const sent = await send(marker);
    await ui.waitRead(`document.querySelector(${literal(sheet)})?.textContent.includes('TEST write approved-effect.txt')`, 'original permission sheet');
    const pending = array((await session()).interactions).filter(row => row.phase === 'pending');
    assert.equal(pending.length, 1); assert.equal(pending[0]!.kind, 'permission');
    assert.equal((await effects()).some(row => row.event === 'interaction-reply' && row.marker === marker), false);
    proof[allowed ? 'allowScreenshot' : 'denyScreenshot'] = await screenshot(allowed ? 'allow-pending' : 'deny-pending');
    await ui.click(`${sheet} button`, 'original permission decision once', allowed ? 'Allow' : 'Deny');
    await terminal(sent.inputId); await visible(allowed ? 'TEST approval allowed' : 'TEST approval denied');
    const path = join(fixture.emulatedRuntime.peers[0]!.root, 'approved-effect.txt');
    if (allowed) assert.equal(await readFile(path, 'utf8'), 'TEST approved once\n');
    else await assert.rejects(readFile(path), { code: 'ENOENT' });
  }
  for (const [marker, allow] of [['TEST_UI_QUESTION', true], ['TEST_UI_QUESTION_DECLINE', false]] as const) {
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

  const inputsBeforeCost = structuredClone((await session()).inputs), turnsBeforeCost = (await effects()).filter(row => row.event === 'input').length;
  options.assertOwnedRenderer();
  const read = record(await cdp.evaluate(`window.electronAPI.agentBackend.invoke(${literal({ handle: { handleId: fixture.handleId }, operation: 'team.activity.stats.read', commandId: 'TEST-emulated-stats', payload: { memberName: 'alice' } })})`));
  assert.equal(read.ok, true); const stats = record(record(read.value).stats);
  assert.equal(stats.inputTokens, array(inputsBeforeCost).length * 120); assert.equal(stats.outputTokens, array(inputsBeforeCost).length * 7);
  const beforeCost = new Set((await commandRows()).map(row => row.commandId));
  await sendDesktopNativeCommandFromComposer(cdp, ui, 'cost', '', catalog => { assert.deepEqual(catalog, ['/cost']); proof.catalog = catalog; });
  const costRows = await poll(commandRows, values => values.some(row => !beforeCost.has(row.commandId) && record(record(row.command).payload).text === '/cost' && row.phase === 'completed'), 'one original local /cost receipt');
  const costs = costRows.filter(row => !beforeCost.has(row.commandId) && record(record(row.command).payload).text === '/cost');
  assert.equal(costs.length, 1);
  const cost = await readNativeHostCostProof({ teamRoot, commandId: String(costs[0]!.commandId), memberName: 'alice', principalId: 'TEST-human', binding: record((await session()).binding), stats });
  assert.deepEqual((await session()).inputs, inputsBeforeCost);
  assert.equal((await effects()).filter(row => row.event === 'input').length, turnsBeforeCost);
  await revealDesktopReply(cdp, String(cost.reply.text), { assertOwnedRenderer: options.assertOwnedRenderer, step: value => steps.push(value) });
  proof.costScreenshot = await screenshot('cost'); proof.cost = cost; proof.stats = stats;
  await ui.clickExpression(`(()=>{const rows=[...document.querySelectorAll('div[role="button"][tabindex="0"]')].filter(e=>[...e.querySelectorAll('span')].some(n=>n.textContent.trim()==='alice'));
    if(rows.length!==1)return null;const e=rows[0],n=[...e.querySelectorAll('span')].find(n=>n.textContent.trim()==='alice'),r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);
    return r.width&&r.height&&hit&&!hit.closest('button')&&(hit===e||e.contains(hit))?{x,y,tag:e.tagName}:null})()`, 'open original member detail');
  await ui.click('[role="dialog"] [role="tab"]', 'original Member Logs', 'Logs');
  await ui.waitRead(`document.querySelector('[role="dialog"] [role="tabpanel"][data-state="active"]')?.textContent.includes('Captured runtime activity')`, 'original Host Logs');
  proof.logsScreenshot = await screenshot('logs');
  await ui.click('[role="dialog"] [role="tab"]', 'original Member Stats', 'Stats');
  for (const [label, value] of [['Reported input tokens', Number(stats.inputTokens).toLocaleString()], ['Reported output tokens', Number(stats.outputTokens).toLocaleString()]])
    await ui.waitRead(`(()=>{const e=document.querySelector('[role="dialog"] [role="tabpanel"][data-state="active"]');const row=[...e.querySelectorAll('div')].find(n=>n.textContent===${literal(label)});return row?.parentElement?.firstElementChild?.textContent===${literal(value)}})()`, 'original exact Stats ' + label);
  proof.statsScreenshot = await screenshot('stats');
  await ui.click('[role="dialog"] button', 'close original member detail', 'Close');
  const reloadInputs = structuredClone((await session()).inputs), reloadEffects = (await effects()).filter(row => row.event === 'input').length;
  const epoch = await cdp.evaluate('performance.timeOrigin'); await cdp.send('Page.reload', { ignoreCache: false });
  await ui.waitRead(`performance.timeOrigin!==${literal(epoch)}&&Boolean(window.electronAPI)&&!document.getElementById('splash')`, 'new renderer epoch');
  await ui.observeInput(); await ui.clickSidebar(fixture.uiSeed.subject);
  await ui.click('button[aria-label^="alice,"]', 'reopen original lead conversation');
  await visible('TEST stream partial complete');
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
  await openSection(); assert.equal((await schedules()).length, 0);
  await ui.scrollTo(`${section} button`, 'original Add Schedule', 'Add Schedule');
  await ui.click(`${section} button`, 'open original Add Schedule', 'Add Schedule');
  await fill('[role="dialog"] #schedule-label', label);
  await fill('[role="dialog"] input[placeholder="0 9 * * 1-5"]', '0 0 1 1 *');
  await fill('[role="dialog"] #dialog-prompt', 'TEST_UI_SCHEDULE_DONE');
  await ui.scrollTo('[role="dialog"] button', 'original Create Schedule', 'Create Schedule');
  await ui.click('[role="dialog"] button', 'create original future schedule once', 'Create Schedule');
  await ui.waitRead(`!document.querySelector('[role="dialog"]')`, 'schedule create closes');
  const created = (await schedules()).filter(row => row.label === label); assert.equal(created.length, 1);
  const scheduleId = String(created[0]!.id); assert.equal(created[0]!.taskFirst, true); assert.equal(created[0]!.executionMode, 'agent');
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
    rows => rows.some(row => row.id === taskId && row.status === 'completed'), 'scheduled original MCP task completion');
  assert.equal(tasks.length, beforeTasks.length + 1); assert.equal(tasks.find(row => row.id === taskId)?.owner, 'alice');
  await ui.scrollTo('button[aria-label^="alice,"]', 'original scheduled lead chat');
  await ui.click('button[aria-label^="alice,"]', 'show original scheduled reply'); await visible('TEST scheduled reply');
  await openSection();
  await ui.scrollTo(`${scheduleRow(edited)} button[aria-label=${literal(edited)}]`, 'original schedule history');
  await ui.click(`${scheduleRow(edited)} button[aria-label=${literal(edited)}]`, 'expand original schedule history');
  proof.scheduleScreenshot = await screenshot('schedule'); proof.schedule = { scheduleId, runId: runs[0]!.id, taskId, status: runs[0]!.status };
  await menu(edited, 'Delete');
  await ui.click('[role="alertdialog"] button, [role="dialog"] button', 'confirm original schedule deletion', 'Delete');
  await poll(schedules, rows => rows.length === 0, 'schedule removed');
  assert.equal((await rows(join(fixture.root, 'hoststore/tasks/test-desktop-backend'))).find(row => row.id === taskId)?.status, 'completed');

  await ui.scrollTo('button[aria-label^="alice,"]', 'original lead chat before stop');
  await ui.click('button[aria-label^="alice,"]', 'open original lead chat before stop');
  const held = await send('TEST_UI_HOLD'); await visible('TEST held partial');
  const originalPids = (await effects()).filter(row => row.event === 'connected').map(row => Number(row.pid));
  assert.ok(originalPids.length > 0);
  proof.heldScreenshot = await screenshot('held');
  await ui.scrollTo('button[aria-label="Stop"]', 'original Team Stop'); await ui.click('button[aria-label="Stop"]', 'stop original Team once', 'Stop');
  await poll(session, value => value.phase === 'closed' && value.custody === 'released', 'original Host released custody');
  assert.equal(array((await session()).inputs).find(row => record(row.intent).inputId === held.inputId)?.terminal, 'cancelled');
  await poll(async () => processTable(), rows => originalPids.every(pid => !rows.some(row => row.pid === pid)), 'original peer PIDs absent after Team Stop');
  proof.stoppedScreenshot = await screenshot('stopped'); proof.originalRuntimePids = originalPids; proof.stopReleased = true;
  proof.effects = await effects(); proof.fixturePins = await verifyDesktopEmulatedRuntimeFixture(fixture);
  await writeFile(join(fixture.root, 'ui-emulated-runtime-effects.json'), JSON.stringify(proof.effects, null, 2), { mode: 0o600, flag: 'wx' });
  proof.status = 'PASS'; proof.visualReview = 'Original screenshot files require independent inspection';
}
