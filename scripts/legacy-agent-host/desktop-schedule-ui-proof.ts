import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDesktopUiControls, desktopJsLiteral as literal } from './desktop-ui-controls.ts';
import { readDesktopNativeHostProcesses, readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';
import { processTable } from './desktop-backend-observations.ts';
import { EDITED_SCHEDULE_LABEL, LEGACY_SCHEDULE_ID, LEGACY_SCHEDULE_LABEL } from './desktop-schedule-fixture.ts';
import { SCHEDULE_SMART_LABEL, SCHEDULE_SMART_PROMPT } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-schedules/model.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';
import type { prepareDesktopProofFixture } from './desktop-proof-fixture.ts';
import type { startNativeTeamModel } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts';

const row = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;
};
const array = (value: unknown): Record<string, unknown>[] => { assert.ok(Array.isArray(value)); return value.map(row); };
const section = '[data-section-id="schedules"]';
const scheduleRow = (label: string) => `${section} div.rounded-md:has(>div>button[aria-label=${literal(label)}])`;

/** Existing controls own every write. Read-only API/file observations correlate the original effects. */
export async function runDesktopScheduleUiProof(cdp: UiCdpPort, options: {
  fixture: Awaited<ReturnType<typeof prepareDesktopProofFixture>>;
  model: Awaited<ReturnType<typeof startNativeTeamModel>>;
  evidence: Record<string, unknown>;
  assertOwnedRenderer(): void;
  capturedGroup(): number;
}) {
  const { fixture, model } = options;
  assert.ok(fixture.uiSeed);
  const scheduleRequests = model.scheduleRequests;
  assert.ok(scheduleRequests, 'the original schedule model variant is present');
  const steps: Record<string, unknown>[] = [];
  const proof: Record<string, unknown> = { status: 'INCOMPLETE', steps,
    scope: 'Original Schedule controls, finite native Claude and task-first saved Host launch, actual Bash/MCP, Stop and reload' };
  options.evidence.scheduleUi = proof;
  let ui = createDesktopUiControls(cdp, { assertOwnedRenderer: options.assertOwnedRenderer,
    step: value => { steps.push(value); } });
  const read = async (expression: string) => { options.assertOwnedRenderer(); return cdp.evaluate(expression); };
  const selected = async (id: string) => row(await read(`window.electronAPI.schedules.get(${literal(id)})`));
  const schedules = async () => array(await read('window.electronAPI.schedules.list()'));
  const runs = async (id: string) => array(await read(`window.electronAPI.schedules.getRuns(${literal(id)})`));
  const until = async <T>(readValue: () => Promise<T>, accept: (value: T) => boolean, label: string) => {
    const deadline = Date.now() + 75_000;
    for (;;) {
      assert.deepEqual(model.failures, [], 'the actual native model oracle must remain valid');
      const value = await readValue(); if (accept(value)) return value;
      assert.ok(Date.now() < deadline, label); await delay(100);
    }
  };
  const openSection = async () => {
    const expand = `${section} button[aria-label="Expand section"]`;
    if (await read(`Boolean(document.querySelector(${literal(expand)}))`)) {
      await ui.scrollTo(expand, 'show original Schedules section');
      await ui.click(expand, 'expand original Schedules section');
    }
    await ui.waitRead(`Boolean(document.querySelector(${literal(section)}))`, 'original Schedules section');
  };
  const menu = async (label: string, action: string) => {
    const button = scheduleRow(label) + ' button[aria-label="More actions"]';
    await ui.scrollTo(button, 'show original schedule menu');
    await ui.click(button, 'open original schedule menu');
    await ui.click('[data-radix-popper-content-wrapper] button', action + ' original schedule', action);
  };
  const fill = async (selector: string, value: string) => {
    await ui.scrollTo(selector, 'show original schedule input');
    await ui.click(selector, 'focus original schedule input');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA',
      modifiers: process.platform === 'darwin' ? 4 : 2, commands: ['selectAll'] });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' });
    await cdp.send('Input.insertText', { text: value });
    await ui.waitRead(`document.querySelector(${literal(selector)})?.value===${literal(value)}`, 'typed schedule value');
  };
  const closeDialog = async () => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await ui.waitRead(`!document.querySelector('[role="dialog"]')`, 'original dialog closed');
  };
  const taskDirectory = join(fixture.root, 'hoststore/tasks/test-desktop-backend');
  const tasks = async () => Promise.all((await readdir(taskDirectory)).filter(name => name.endsWith('.json'))
    .map(async name => row(JSON.parse(await readFile(join(taskDirectory, name), 'utf8')))));

  await ui.observeInput(); await ui.clickSidebar(fixture.uiSeed.subject); await openSection();
  assert.equal((await schedules()).length, 1);
  const original = await selected(LEGACY_SCHEDULE_ID);
  assert.equal(original.hostTarget, undefined); assert.equal(original.status, 'paused');
  assert.equal((await tasks()).length, 1, 'only the original navigation task exists');
  await menu(LEGACY_SCHEDULE_LABEL, 'Edit');
  await ui.waitRead(`document.querySelector('#schedule-label')?.value===${literal(LEGACY_SCHEDULE_LABEL)}`, 'old schedule hydrated');
  await fill('[role="dialog"] #schedule-label', EDITED_SCHEDULE_LABEL);
  await fill('[role="dialog"] #schedule-max-turns', '6');
  await fill('[role="dialog"] #schedule-max-budget', '0.25');
  await ui.scrollTo('[role="dialog"] button', 'show Save Changes', 'Save Changes');
  await ui.click('[role="dialog"] button', 'save and rebind original schedule', 'Save Changes');
  await ui.waitRead(`!document.querySelector('[role="dialog"]')`, 'schedule Save completed');
  const edited = await selected(LEGACY_SCHEDULE_ID);
  assert.equal(row(edited.hostTarget).handleId, fixture.handleId);
  assert.equal(edited.status, 'paused'); assert.equal(edited.maxTurns, 6); assert.equal(edited.maxBudgetUsd, 0.25);
  assert.equal(edited.executionMode, undefined, 'editing the old record preserves standalone semantics');
  for (const [action, expected] of [['Resume', 'active'], ['Pause', 'paused'], ['Resume', 'active']] as const) {
    await menu(EDITED_SCHEDULE_LABEL, action);
    await until(() => selected(LEGACY_SCHEDULE_ID), value => value.status === expected, 'original schedule status');
  }
  assert.ok(Date.parse(String((await selected(LEGACY_SCHEDULE_ID)).nextRunAt)) > Date.now());
  assert.equal(scheduleRequests.length, 0, 'editing and future cron state do not start an occurrence');
  const runButton = scheduleRow(EDITED_SCHEDULE_LABEL) + ' button[aria-label="Run now"]';
  await ui.scrollTo(runButton, 'show original standalone Run now');
  await ui.click(runButton, 'run original standalone schedule once');
  const finiteRuns = await until(() => runs(LEGACY_SCHEDULE_ID), value => value.length === 1 && value[0]!.status === 'completed', 'finite native run completed');
  assert.equal(finiteRuns[0]!.exitCode, 0);
  assert.equal(await readFile(join(fixture.root, 'workspace/schedule-finite.txt'), 'utf8'), 'TEST_SCHEDULE_NATIVE_EFFECT\n');
  assert.equal((await tasks()).length, 1, 'standalone execution creates no hidden Team task');
  assert.equal(scheduleRequests.filter(request => request.mode === 'finite').length, 2);
  await ui.click(scheduleRow(EDITED_SCHEDULE_LABEL) + ` button[aria-label=${literal(EDITED_SCHEDULE_LABEL)}]`, 'expand original run history');
  await ui.click(scheduleRow(EDITED_SCHEDULE_LABEL) + ' div[role="button"]', 'open original completed run log');
  await ui.waitRead(`document.querySelector('[role="dialog"]')?.textContent.includes('TEST_SCHEDULE_FINITE_DONE')`, 'actual native stdout in original run log');
  proof.finite = { runId: finiteRuns[0]!.id, limits: { maxTurns: 6, maxBudgetUsd: 0.25 }, actualTool: true, logVisible: true };
  await closeDialog(); await menu(EDITED_SCHEDULE_LABEL, 'Pause');

  await ui.scrollTo(section + ' button', 'show original Add Schedule', 'Add Schedule');
  await ui.click(section + ' button', 'open original Add Schedule', 'Add Schedule');
  await ui.waitRead(`Boolean(document.querySelector('#schedule-label'))`, 'new schedule form');
  await fill('[role="dialog"] #schedule-label', SCHEDULE_SMART_LABEL);
  await fill('[role="dialog"] input[placeholder="0 9 * * 1-5"]', '0 0 1 1 *');
  await fill('[role="dialog"] #dialog-prompt', SCHEDULE_SMART_PROMPT);
  await ui.scrollTo('[role="dialog"] button', 'show original Create Schedule', 'Create Schedule');
  await ui.click('[role="dialog"] button', 'create one original task-first schedule', 'Create Schedule');
  await ui.waitRead(`!document.querySelector('[role="dialog"]')`, 'original create finished');
  const created = (await schedules()).filter(value => value.label === SCHEDULE_SMART_LABEL);
  assert.equal(created.length, 1); const smart = created[0]!, smartId = String(smart.id);
  assert.equal(smart.taskFirst, true); assert.equal(smart.executionMode, 'agent');
  assert.equal(row(smart.hostTarget).handleId, fixture.handleId);
  assert.equal(row(smart.launchConfig).prompt, SCHEDULE_SMART_PROMPT);
  const smartButton = scheduleRow(SCHEDULE_SMART_LABEL) + ' button[aria-label="Run now"]';
  await ui.scrollTo(smartButton, 'show original task-first Run now');
  await ui.click(smartButton, 'run task-first schedule once');
  const smartRuns = await until(() => runs(smartId), value => value.length === 1 && value[0]!.status === 'dispatched', 'task-first dispatch');
  const taskId = String(smartRuns[0]!.linkedTaskId);
  const completed = await until(tasks, value => value.some(task => task.id === taskId && task.status === 'completed'), 'actual native MCP completed the linked task');
  assert.equal(completed.length, 2); assert.equal(completed.find(task => task.id === taskId)?.owner, 'alice');
  await until(async () => scheduleRequests, value => value.filter(request => request.mode === 'smart').length === 4, 'bounded native task-first completion');
  assert.equal(await readFile(join(fixture.root, 'workspace/schedule-smart.txt'), 'utf8'), 'TEST_SCHEDULE_NATIVE_EFFECT\n');
  await ui.scrollTo('button[aria-label^="alice,"]', 'show original agent chat');
  await ui.click('button[aria-label^="alice,"]', 'open scheduled agent reply');
  await ui.waitRead(`document.body.innerText.includes('TEST_SCHEDULE_SMART_DONE')`, 'native Team MCP reply visible');
  const originalProcesses = readDesktopNativeHostProcesses(fixture, options.capturedGroup());
  assert.ok(originalProcesses.children.length >= 1);
  await ui.scrollTo('button[aria-label="Stop"]', 'show original Stop');
  await ui.click('button[aria-label="Stop"]', 'stop the original launched team', 'Stop');
  await until(() => readDesktopNativeStopSessions(fixture.root), values => values.length >= 2 &&
    values.every(value => value.phase === 'closed' && value.custody === 'released'), 'all original native custody released');
  await until(async () => processTable(), values => originalProcesses.children.every(child =>
    !values.some(value => value.pid === child.pid)), 'original native children physically absent');
  proof.smart = { scheduleId: smartId, runId: smartRuns[0]!.id, taskId, actualTool: true, nativeReplyVisible: true, cleanup: 'confirmed' };
  const beforeReload = await read('performance.timeOrigin');
  await cdp.send('Page.reload', { ignoreCache: false });
  await ui.waitRead(`Boolean(window.electronAPI)&&performance.timeOrigin!==${literal(beforeReload)}&&!document.getElementById('splash')`, 'same application reload');
  ui = createDesktopUiControls(cdp, { assertOwnedRenderer: options.assertOwnedRenderer, step: value => { steps.push(value); } });
  await ui.observeInput(); await ui.clickSidebar(fixture.uiSeed.subject); await openSection();
  assert.equal((await runs(LEGACY_SCHEDULE_ID)).length, 1); assert.equal((await runs(smartId)).length, 1);
  assert.equal(scheduleRequests.length, 6, 'reload and history reads never replay original native work');
  assert.equal((await tasks()).length, 2);
  for (const label of [EDITED_SCHEDULE_LABEL, SCHEDULE_SMART_LABEL]) {
    await menu(label, 'Delete');
    await ui.click('[role="alertdialog"] button, [role="dialog"] button', 'confirm deletion of the original schedule', 'Delete');
    await ui.waitRead(`!document.querySelector('[role="alertdialog"], [role="dialog"]')`, 'original deletion confirmation closed');
  }
  await until(schedules, values => values.length === 0, 'only the explicit schedules were deleted');
  assert.equal((await tasks()).find(task => task.id === taskId)?.status, 'completed', 'schedule deletion preserves completed Team task');
  assert.deepEqual(model.failures, []); proof.nativeRequests = scheduleRequests;
  proof.reloadWithoutReplay = true; proof.status = 'PASS';
}
