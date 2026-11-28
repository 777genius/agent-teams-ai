import assert from 'node:assert/strict';
import { record } from './desktop-resume-records.ts';
import type { createDesktopUiControls, UiCdpPort } from './desktop-ui-controls.ts';

type Row = Record<string, unknown>;

/** Physical Composer opt-in and Stop on the existing gated TEST stream; no injected product writes. */
export async function startDesktopAutonomousGoalStream(cdp: UiCdpPort, options: {
  ui: ReturnType<typeof createDesktopUiControls>;
  send(text: string): Promise<{ receipt: Row; inputId: unknown }>;
  session(): Promise<Row>;
  ownerState(): Promise<Row>;
  screenshot(name: string): Promise<{ path: string; sha256: string }>;
  proof: Row;
}) {
  const { ui, proof } = options;
  await ui.click('.message-composer-flat-layout button[role="radio"]', 'select original Do mode', 'Do');
  await ui.click('button', 'open original continuation option', 'Continue until done');
  await ui.click('[role="dialog"] [role="checkbox"]', 'opt in once to original objective');
  await ui.waitRead(`document.querySelector('[role="dialog"] [role="checkbox"]')?.getAttribute('data-state')==='checked'`,
    'original continuation selection is visible');
  for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent',
    { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  const stream = await options.send('TEST_UI_STREAM');
  assert.deepEqual(record(record(stream.receipt.command).payload).autonomousGoal, { durationHours: 12, maxAttempts: 100 });
  assert.equal(record(record(stream.receipt.command).payload).actionMode, 'do');
  await ui.waitRead('document.body.innerText.includes("TEST stream partial")', 'original visible partial stream');
  assert.equal(await cdp.evaluate('document.body.innerText.includes("TEST stream partial complete")'), false);
  const input = async () => {
    const inputs = (await options.session()).inputs; assert.ok(Array.isArray(inputs));
    const matches = inputs.map(record).filter(row => record(row.intent).inputId === stream.inputId);
    assert.equal(matches.length, 1); return matches[0]!;
  };
  const originalInput = await input();
  assert.ok(['claimed', 'consumed'].includes(String(originalInput.phase)),
    'The gated original stream is still an active native input');
  assert.equal(typeof originalInput.operationRef, 'string');
  const active = record((await options.ownerState()).autonomousGoal);
  assert.equal(active.rootCommandId, stream.receipt.commandId);
  assert.equal(active.goalId, record(stream.receipt.goal).goalId);
  assert.equal(active.disposition, 'active'); assert.equal(active.attemptLimit, 100);
  assert.equal(Object.keys(record(active.debits)).length, 0, 'Original human input is unbilled');
  await ui.waitRead('document.body.innerText.includes("Continuing work")', 'original active objective status');
  proof.partialScreenshot = await options.screenshot('partial');
  await ui.click('button', 'stop original continuation once while its original turn runs', 'Stop continuation');
  await ui.waitRead('document.body.innerText.includes("Continuation stopped")', 'original stopped objective status');
  const stopped = record((await options.ownerState()).autonomousGoal);
  assert.equal(stopped.goalId, active.goalId); assert.equal(stopped.disposition, 'stopped');
  assert.equal(stopped.reason, 'stopped-by-user');
  assert.equal(Object.keys(record(stopped.controls)).length, 1, 'Exactly one original Stop receipt');
  assert.equal(Object.keys(record(stopped.debits)).length, 0);
  const stoppedInput = await input();
  assert.equal(record(stoppedInput.intent).inputId, record(originalInput.intent).inputId);
  assert.equal(stoppedInput.operationRef, originalInput.operationRef);
  assert.ok(['claimed', 'consumed'].includes(String(stoppedInput.phase)),
    'Stop continuation preserves the same running original turn without cancellation or an unknown outcome');
  proof.autonomousGoal = { status: 'PASS', goalId: stopped.goalId, rootCommandId: stopped.rootCommandId,
    inputId: stream.inputId, operationRef: stoppedInput.operationRef,
    phaseBeforeStop: originalInput.phase, phaseAfterStop: stoppedInput.phase,
    attemptsUsed: 0, controlReceipts: 1, screenshot: await options.screenshot('goal-stopped'),
    scope: 'Actual Composer opt-in, original Host intake/readback and Stop; existing stream then finishes normally',
    excluded: ['productive automatic completion', 'real model competence', 'overnight reliability'] };
  return stream;
}
