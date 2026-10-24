import assert from 'node:assert/strict';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileDigest } from './desktop-backend-fixture.ts';
import { command, processTable } from './desktop-backend-observations.ts';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';
import { createDesktopUiControls } from './desktop-ui-controls.ts';
import { revealDesktopReply } from './desktop-reply-visibility.ts';
import { checkpoint, digest, json, jsonDigest, originalHistoryMarker, record, rows } from './desktop-resume-records.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';
import type { prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import type { startNativeTeamModel } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts';

/** Starts only after the real Launch/Stop/reload/reopen-prefill proof. No setup effect APIs. */
export async function runDesktopResumeUiSmoke(cdp: UiCdpPort, options: {
  fixture: Awaited<ReturnType<typeof prepareDesktopBackendFixture>>;
  evidence: Record<string, unknown>;
  model: Awaited<ReturnType<typeof startNativeTeamModel>>;
  firstCapture: Record<string, unknown>;
  firstSession: Record<string, unknown>;
  savedSettings: Record<string, unknown>;
  nativeTask: Record<string, unknown>;
  assertOwnedRenderer(): void;
}): Promise<void> {
  const { fixture, evidence, model, firstCapture } = options;
  assert.equal(evidence.mode, 'native-resume-ui');
  const steps: Record<string, unknown>[] = [];
  const proof: Record<string, unknown> = { status: 'INCOMPLETE', phase: 'source-released', steps,
    scope: 'Original Launch/Stop/reload/Resume checkpoint controls; same product launch, exact native history, ordinary Composer/Send and second Stop',
    excluded: ['vendor inference/authentication', 'multi-member Resume', 'legacy namespace import', 'full Stage1'] };
  evidence.resumeDialogProof = proof;
  const step = (value: Record<string, unknown>) => steps.push({ monotonicMs: Math.round(performance.now()), ...value });
  const ui = createDesktopUiControls(cdp, { assertOwnedRenderer: options.assertOwnedRenderer, step });
  const teamRoot = join(fixture.root, 'hoststore/teams/test-desktop-backend');
  const ownerRoot = join(teamRoot, '.host-owner');
  const state = () => json(join(ownerRoot, 'state.json'));
  const allSessions = () => readDesktopNativeStopSessions(fixture.root);
  const sessions = async () => (await allSessions()).filter(row => record(row.binding).runId === firstCapture.launchId);
  const poll = async <T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string): Promise<T> => {
    const deadline = Date.now() + 60000;
    let value = await read();
    while (!accept(value) && Date.now() < deadline) {
      options.assertOwnedRenderer();
      assert.deepEqual(model.failures, [], 'native oracle failure cannot be hidden by a poll');
      await new Promise<void>(resolve => setTimeout(resolve, 100));
      value = await read();
    }
    assert.ok(accept(value), label);
    return value;
  };
  // This helper only permits queries. All mutation/effect commands come from original UI input.
  const query = async (operation: 'team.launch.read' | 'team.launch.restorations.read' | 'runtime.checkpoints.read', payload: Record<string, unknown>) => {
    options.assertOwnedRenderer();
    const request = { handle: { handleId: fixture.handleId }, commandId: `TEST-resume-query-${steps.length}`, operation, payload };
    const result = record(await cdp.evaluate(`window.electronAPI.agentBackend.invoke(${JSON.stringify(request)})`));
    assert.equal(result.ok, true, `read-only ${operation}`);
    assert.equal(JSON.stringify(result).includes(fixture.root), false);
    step({ observation: operation, payload, result });
    return record(result.value);
  };
  assert.equal(model.observations.length, 8);
  assert.equal(record(evidence.launchDialogProof).status, 'PASS');
  const before = await sessions();
  assert.equal(before.length, 1);
  const source = before[0]!;
  assert.deepEqual(source.binding, options.firstSession.binding);
  assert.equal(source.phase, 'closed');
  assert.equal(source.custody, 'released');
  const originalCheckpoint = await checkpoint(fixture.root, source);
  assert.ok(originalCheckpoint.history.includes(Buffer.from('NATIVE_TEAM_ONE')));
  assert.ok(originalCheckpoint.history.includes(Buffer.from('REPLY_NATIVE_ONE')));
  const marker = originalHistoryMarker(model.observations[7]!.priorNativeToolIds ?? []);
  const sourceBinding = record(source.binding);
  const staticPredecessors = (await allSessions()).filter(row => record(row.binding).runId !== firstCapture.launchId);
  assert.ok(staticPredecessors.length <= 1);
  for (const row of staticPredecessors) {
    assert.equal(row.phase, 'closed'); assert.equal(row.custody, 'released');
    assert.deepEqual(row.inputs, []); assert.equal(row.config, null);
  }
  const profile = await json(fixture.profilePath);
  const definition = record((profile.teams as unknown[])[0]);
  const originalProfileMember = record((definition.members as unknown[]).find(member => record(member).memberId === 'alice-id'));
  const { teamName: _teamName, ...descriptorBinding } = record(originalProfileMember.delivery);
  for (const row of staticPredecessors) assert.deepEqual(row.binding, descriptorBinding, 'only the captured descriptor predecessor may remain');
  const sourceLaunch = await query('team.launch.read', {});
  assert.equal(sourceLaunch.launchId, firstCapture.launchId);
  assert.ok(Array.isArray(sourceLaunch.members) && sourceLaunch.members.length === 1);
  const sourceMember = record(sourceLaunch.members[0]);
  assert.equal(sourceMember.memberId, 'alice-id');
  assert.equal(sourceMember.generation, sourceBinding.generation);
  const availability = await query('runtime.checkpoints.read', { memberId: 'alice-id', expectedGeneration: sourceBinding.generation });
  assert.equal(availability.status, 'owner-eligible');
  assert.equal(availability.sourceGeneration, sourceBinding.generation);
  assert.ok(Array.isArray(availability.checkpoints) && availability.checkpoints.length === 1);
  const available = record(availability.checkpoints[0]);
  assert.equal(available.reference, originalCheckpoint.payload.reference);
  assert.equal(available.status, 'owner-eligible');
  const initialRestorations = await query('team.launch.restorations.read', { launchId: firstCapture.launchId });
  assert.deepEqual(initialRestorations.preparations, []); assert.deepEqual(initialRestorations.restorations, []);
  proof.source = { session: source, checkpoint: originalCheckpoint.attempt, payloadPath: originalCheckpoint.path,
    payloadFileSha256: originalCheckpoint.payloadFileSha256, nativeSession: originalCheckpoint.nativeSession,
    nativeHistoryPath: originalCheckpoint.historyPath, nativeHistoryBytes: originalCheckpoint.history.length,
    nativeHistorySha256: originalCheckpoint.historySha256, priorRequestHistoryMarker: marker, launch: sourceLaunch, availability };
  proof.staticPredecessors = staticPredecessors;
  await ui.scrollTo('[role="dialog"] #launch-continuation-mode', 'visible original Launch mode');
  await ui.click('[role="dialog"] #launch-continuation-mode', 'open original Launch mode Combobox');
  await ui.click('[role="option"][data-value="resume"][aria-disabled="false"]', 'select original Resume checkpoint');
  await ui.waitRead(`document.querySelector('#launch-continuation-mode')?.textContent.trim()==='Resume checkpoint'`, 'Resume mode selected');
  await ui.scrollTo('#resume-checkpoint-alice-id', 'visible explicit alice checkpoint');
  await ui.click('#resume-checkpoint-alice-id', 'open original checkpoint Combobox');
  const option = `[role="option"][data-value=${JSON.stringify(available.reference)}][aria-disabled="false"]`;
  await ui.click(option, 'explicitly select the exact available original checkpoint');
  await ui.waitRead(`document.querySelector('#resume-checkpoint-alice-id')?.textContent.trim()==='Saved checkpoint 1'`, 'explicit checkpoint retained');
  await ui.scrollTo('[role="dialog"] button', 'visible original Resume submit', 'Resume selected checkpoints');
  proof.recoveryReferences = { launchId: firstCapture.launchId, rosterRevision: sourceLaunch.rosterRevision,
    members: [{ memberId: 'alice-id', sourceGeneration: sourceBinding.generation, reference: available.reference }] };
  proof.phase = 'resume-submit-attempted';
  try {
  await ui.click('[role="dialog"] button', 'original Resume submit exactly once', 'Resume selected checkpoints');
  await ui.waitRead(`!document.querySelector('[role="dialog"] #launch-continuation-mode')`, 'Resume dialog closes after ready', 60000);
  const restored = await poll(sessions, values => values.length === 2 && values.some(row => row.phase === 'allocated' && row.custody === 'owned'), 'one new technical Runtime generation');
  const old = restored.find(row => record(row.binding).generation === sourceBinding.generation)!;
  const active = restored.find(row => record(row.binding).generation !== sourceBinding.generation)!;
  assert.ok(old && active); assert.deepEqual(old, source, 'original source including checkpoint remains immutable');
  const selectedBinding = record(active.binding);
  assert.deepEqual({ ...selectedBinding, generation: sourceBinding.generation }, sourceBinding, 'same product launch/member, technical generation only');
  assert.deepEqual(active.restoredFrom, { reference: available.reference, sourceBinding });
  assert.equal(record(active.config).checkpointRef, available.reference);
  assert.equal(active.nativeReady, true); assert.deepEqual(active.inputs, [], 'Resume cannot dispatch a fresh launch prompt');
  assert.equal(model.observations.length, 8, 'Resume opens history without another model input');
  const resumedState = await state();
  assert.deepEqual(resumedState.runtimeCaptures, [firstCapture], 'Resume never captures or replaces the product roster');
  assert.deepEqual(resumedState.savedSettings, options.savedSettings);
  const restoration = await query('team.launch.restorations.read', { launchId: firstCapture.launchId });
  assert.equal(restoration.launchId, firstCapture.launchId);
  assert.ok(Array.isArray(restoration.preparations) && restoration.preparations.length === 1);
  const preparation = record(restoration.preparations[0]);
  assert.ok(Array.isArray(preparation.members) && preparation.members.length === 1);
  const choice = record(preparation.members[0]);
  assert.deepEqual({ memberId: choice.memberId, reference: choice.reference, sourceGeneration: choice.sourceGeneration },
    { memberId: 'alice-id', reference: available.reference, sourceGeneration: sourceBinding.generation });
  assert.equal(choice.requested, true); assert.equal(choice.refused, undefined);
  assert.match(String(preparation.resumeId), /^resume-[a-f0-9]{64}$/); assert.match(String(choice.commandId), /^restore-[a-f0-9]{64}$/);
  assert.ok(Array.isArray(restoration.restorations) && restoration.restorations.length === 1);
  assert.deepEqual(restoration.restorations[0], { commandId: choice.commandId, memberId: 'alice-id', reference: available.reference,
    sourceGeneration: sourceBinding.generation, selectedGeneration: selectedBinding.generation, current: true, phase: 'allocated', custody: 'owned', attached: true });
  const readyLaunch = await query('team.launch.read', {});
  assert.equal(readyLaunch.launchId, sourceLaunch.launchId); assert.equal(readyLaunch.status, 'ready');
  assert.equal(record((readyLaunch.members as unknown[])[0]).generation, selectedBinding.generation);
  const launchPath = join(ownerRoot, 'launches', `${jsonDigest(firstCapture.launchId)}.json`);
  const journal = await json(launchPath);
  const journalPreparation = record((journal.resumePreparations as unknown[])[0]);
  const immutableMembers = (journalPreparation.members as unknown[]).map(record).map(({ requested: _requested, refused: _refused, ...member }) => member);
  assert.equal(journalPreparation.fingerprint, jsonDigest({ resumeId: preparation.resumeId, rosterRevision: preparation.rosterRevision, members: immutableMembers }));
  proof.phase = 'restored-ready'; proof.preparedResumeMap = restoration; proof.launchJournal = { path: launchPath, sha256: await fileDigest(launchPath), record: journal }; proof.readyLaunch = readyLaunch;
  if (!(await cdp.evaluate(`Boolean(document.querySelector('.message-composer-flat-layout textarea'))`)))
    await ui.click('button[aria-label^="alice,"]', 'open original alice chat after Resume');
  await ui.waitRead(`document.body.innerText.includes('REPLY_NATIVE_ONE')`, 'original native reply retained after Resume');
  await ui.click('.message-composer-flat-layout textarea', 'focus existing MessageComposer');
  await cdp.send('Input.insertText', { text: 'NATIVE_TEAM_TWO' });
  await ui.waitRead(`document.querySelector('.message-composer-flat-layout textarea')?.value==='NATIVE_TEAM_TWO'`, 'deliberate second message retained');
  proof.phase = 'second-send-attempted';
  await ui.click('button.message-composer-send-button', 'ordinary Send exactly once after Resume', 'Send');
  await ui.waitRead(`document.querySelector('.message-composer-flat-layout textarea')?.value===''`, 'Composer clears after admitted Send');
  await ui.waitRead(`document.body.innerText.includes('REPLY_NATIVE_TWO')`, 'resumed native reply visible', 60000);
  await revealDesktopReply(cdp, 'REPLY_NATIVE_TWO', { assertOwnedRenderer: options.assertOwnedRenderer, step });
  const terminal = await poll(sessions, values => values.length === 2 && values.some(row => record(row.binding).generation === selectedBinding.generation &&
    Array.isArray(row.inputs) && row.inputs.length === 1 && record(row.inputs[0]).phase === 'terminal'), 'one resumed input terminal');
  const finished = terminal.find(row => record(row.binding).generation === selectedBinding.generation)!;
  const input = record((finished.inputs as unknown[])[0]); assert.equal(input.terminal, 'succeeded');
  const sent = (await rows(join(ownerRoot, 'commands'))).filter(row => row.principalId === 'TEST-human' &&
    record(row.command).operation === 'message.send' && record(record(row.command).payload).text === 'NATIVE_TEAM_TWO');
  assert.equal(sent.length, 1); const receipt = sent[0]!; assert.equal(receipt.phase, 'completed');
  const messageId = String(receipt.commandId); assert.match(messageId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.equal(record(record(receipt.command).payload).messageId, messageId); assert.equal(record(receipt.effects).messageId, messageId);
  const outbox = await json(join(ownerRoot, 'outbox', `${record(receipt.effects).deliveryId}.json`));
  assert.equal(outbox.phase, 'admitted'); assert.equal(outbox.messageId, messageId);
  assert.equal(outbox.inputId, record(input.intent).inputId);
  const { teamName: outboxTeamName, ...outboxBinding } = record(outbox.binding);
  assert.equal(outboxTeamName, 'test-desktop-backend'); assert.deepEqual(outboxBinding, selectedBinding);
  assert.equal(model.observations.length, 11);
  const second = model.observations.filter(row => row.turn === 'NATIVE_TEAM_TWO'); assert.equal(second.length, 3);
  assert.deepEqual(second.map(row => row.step), [0, 1, 2]);
  for (const observation of second) {
    assert.ok(observation.priorTurn && observation.visibleReplyContract && observation.contextEffective && !observation.toolResultError);
    assert.equal(originalHistoryMarker(observation.priorNativeToolIds ?? []), marker, 'actual resumed native request contains the original native history marker');
    assert.equal(observation.incomingMessageId, messageId); assert.equal(observation.requestedModel, 'claude-opus-4-6'); assert.equal(observation.requestedEffort, 'medium');
  }
  assert.equal(await readFile(join(fixture.root, 'workspace/native-effect.txt'), 'utf8'), 'ONE\nTWO\n');
  assert.deepEqual(await json(join(fixture.root, 'hoststore/tasks/test-desktop-backend', `${options.nativeTask.id}.json`)), options.nativeTask);
  const inbox = JSON.parse(await readFile(join(teamRoot, 'inboxes/user.json'), 'utf8')) as unknown;
  assert.ok(Array.isArray(inbox));
  for (const reply of ['REPLY_NATIVE_ONE', 'REPLY_NATIVE_TWO']) assert.equal(inbox.map(record).filter(row => row.text === reply && row.from === 'alice').length, 1);
  await revealDesktopReply(cdp, 'REPLY_NATIVE_ONE', { assertOwnedRenderer: options.assertOwnedRenderer, step });
  const hosts = processTable().filter(row => command(row.pid) === `${fixture.node} ${fixture.hostEntry}`);
  assert.equal(hosts.length, 1); const children = processTable().filter(row => row.ppid === hosts[0]!.pid); assert.ok(children.length >= 1);
  const screenshot = record(await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })); assert.equal(typeof screenshot.data, 'string');
  const screenshotPath = join(fixture.root, 'ui-original-resume-native.png'); await writeFile(screenshotPath, Buffer.from(String(screenshot.data), 'base64'), { mode: 0o600 });
  const stopObservations: Record<string, unknown>[] = [];
  proof.secondStopObservations = stopObservations;
  let observedPhases = '';
  const observeStop = (values: Record<string, unknown>[]) => {
    if (stopObservations.length >= 8) return;
    const phases = values.map(value => ({ generation: record(value.binding).generation, phase: value.phase, custody: value.custody }));
    const key = JSON.stringify(phases);
    if (key === observedPhases) return;
    observedPhases = key;
    try {
      const numeric = processTable().filter(row => children.some(child => row.pid === child.pid || row.pgid === child.pid));
      stopObservations.push({ at: new Date().toISOString(), phases, originalNativeRoots: children,
        numericProcesses: numeric.slice(0, 64), truncated: numeric.length > 64,
        scope: 'Read-only numeric census only; matching a reused PID/PGID proves no identity, ownership or custody and authorizes no signal.' });
    } catch { stopObservations.push({ phases, observation: 'unavailable' }); }
  };
  observeStop(terminal);
  proof.phase = 'second-stop-attempted';
  await ui.scrollTo('button[aria-label="Stop"]', 'visible original Stop after Resume');
  await ui.click('button[aria-label="Stop"]', 'second original Stop exactly once', 'Stop');
  const stopped = await poll(async () => { const values = await sessions(); observeStop(values); return values; }, values => values.length === 2 && values.every(row => row.phase === 'closed' && row.custody === 'released'), 'source and resumed custody released before Quit');
  await poll(async () => processTable(), values => children.every(child => !values.some(row => row.pid === child.pid)), 'resumed native children physically absent before Quit');
  assert.deepEqual(stopped.find(row => record(row.binding).generation === sourceBinding.generation), source);
  assert.deepEqual((await allSessions()).filter(row => record(row.binding).runId !== firstCapture.launchId), staticPredecessors);
  const finalSession = stopped.find(row => record(row.binding).generation === selectedBinding.generation)!;
  const secondCheckpoint = await checkpoint(fixture.root, finalSession);
  assert.notEqual(secondCheckpoint.payload.reference, available.reference); assert.equal(secondCheckpoint.nativeSession, originalCheckpoint.nativeSession);
  assert.ok(secondCheckpoint.history.includes(Buffer.from('NATIVE_TEAM_TWO')) && secondCheckpoint.history.includes(Buffer.from('REPLY_NATIVE_TWO')));
  assert.equal(digest(secondCheckpoint.history.subarray(0, originalCheckpoint.history.length)), originalCheckpoint.historySha256, 'original native JSONL history prefix remains unchanged');
  assert.equal((await lstat(originalCheckpoint.historyPath)).isSymbolicLink(), false);
  assert.equal(await fileDigest(originalCheckpoint.path), originalCheckpoint.payloadFileSha256);
  assert.deepEqual((await state()).runtimeCaptures, [firstCapture]); assert.deepEqual((await state()).savedSettings, options.savedSettings);
  assert.equal(model.observations.length, 11); assert.deepEqual(model.failures, []);
  proof.phase = 'second-checkpoint-released'; proof.sessionsBeforeSecondStop = terminal; proof.sessionsAfterSecondStop = stopped;
  proof.secondMessage = { receipt, outbox, observations: second }; proof.secondStop = { nativeChildren: children, releasedBeforeQuit: true,
    checkpoint: secondCheckpoint.attempt, payloadPath: secondCheckpoint.path, payloadFileSha256: secondCheckpoint.payloadFileSha256,
    nativeHistoryPath: secondCheckpoint.historyPath, nativeHistorySha256: secondCheckpoint.historySha256, nativeHistoryBytes: secondCheckpoint.history.length, originalHistoryPrefixRetained: true };
  proof.finalRestorations = await query('team.launch.restorations.read', { launchId: firstCapture.launchId });
  const finalRestorations = record(proof.finalRestorations);
  assert.deepEqual(finalRestorations.preparations, restoration.preparations);
  assert.deepEqual(finalRestorations.restorations, [{ ...record((restoration.restorations as unknown[])[0]), phase: 'closed', custody: 'released', attached: false }]);
  proof.nativeTaskRetained = options.nativeTask.id; proof.screenshot = { path: screenshotPath, sha256: await fileDigest(screenshotPath) };
  proof.status = 'PASS';
  } finally {
    // Preserve original durable intent even after an uncertain UI response. No retry/fallback/effect.
    try {
      const recovery = await query('team.launch.restorations.read', { launchId: firstCapture.launchId });
      const launchPath = join(ownerRoot, 'launches', `${jsonDigest(firstCapture.launchId)}.json`);
      proof.recoverySnapshot = { restorations: recovery, launch: await query('team.launch.read', {}),
        launchJournal: await json(launchPath), launchJournalSha256: await fileDigest(launchPath), sessions: await sessions() };
    } catch (error) {
      proof.recoverySnapshotFailure = String(error); proof.status = 'INCOMPLETE';
      throw error;
    }
  }
}
