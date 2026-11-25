import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileDigest } from './desktop-backend-fixture.ts';
import { processTable } from './desktop-backend-observations.ts';
import { openDesktopEmulatedBootChat } from './desktop-emulated-boot-chat.ts';
import { readDesktopEmulatedRuntimeEffects, verifyDesktopEmulatedRuntimeFixture } from './desktop-emulated-runtime-fixture.ts';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';
import { stoppedImportSourceBytes } from './desktop-stopped-import-fixture.ts';
import { createDesktopUiControls, desktopJsLiteral as literal, type UiCdpPort } from './desktop-ui-controls.ts';
import { FINITE_IMPORT_MODE, FINITE_SOURCE_TEAM, FINITE_HOST_PROMPT, FINITE_HOST_REPLY,
  assertFiniteImportInputCorrelation, assertFiniteImportConversationReadback, finiteImportJson as json, finiteImportRow as row,
  type FiniteImportFixture, type FiniteImportRow } from './desktop-finite-stopped-import-fixture.ts';
export { prepareDesktopFiniteStoppedImportFixture } from './desktop-finite-stopped-import-fixture.ts';
export { produceDesktopFiniteStoppedTeam } from './desktop-finite-stopped-import-producer.ts';

const array = (value: unknown) => { assert.ok(Array.isArray(value)); return value.map(row); };
export async function finiteImportRecords(directory: string, optional = false): Promise<FiniteImportRow[]> {
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) { if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  assert.ok(names.length <= 256);
  return Promise.all(names.filter(name => /^[a-f0-9]{64}\.json$/u.test(name)).map(name => json(join(directory, name))));
}

/** Original cold Main import and UI readback, then a fresh SDK/finite-peer Host generation. */
export async function runDesktopFiniteStoppedImportUi(cdp: UiCdpPort, options: {
  fixture: FiniteImportFixture; evidence: FiniteImportRow; electron: string;
  assertOwnedRenderer(): void; observeOwnedHost(): void;
}) {
  const { fixture } = options;
  assert.equal(process.env.LEGACY_DESKTOP_PROOF_MODE, FINITE_IMPORT_MODE);
  const seedPath = join(fixture.root, 'finite-stopped-import-seed.json'), seed = await json(seedPath);
  assert.equal(seed.sourceKind, 'actual-current-finite-solo'); assert.equal(seed.teamName, FINITE_SOURCE_TEAM);
  const producerRef = row(seed.producer), source = await json(String(producerRef.path));
  assert.equal(await fileDigest(String(producerRef.path)), producerRef.sha256);
  assert.equal(source.status, 'PASS'); assert.equal(source.inputsFrozen, true);
  assert.equal(row(source.ordinaryQuit).sourcePeerAbsent, true); assert.equal(source.sourcePeerAbsentAfterCleanup, true);
  const saved = row(seed.savedSettings), sourceTask = row(seed.sourceTask), roots = seed.roots as string[];
  const assertSource = async () => {
    assert.deepEqual(await stoppedImportSourceBytes(fixture.root, roots), seed.before);
    for (const path of seed.absentRoots as string[]) await assert.rejects(lstat(path), { code: 'ENOENT' });
  };
  await assertSource();
  const steps: FiniteImportRow[] = [], proof: FiniteImportRow = { status: 'INCOMPLETE', steps,
    sourceKind: seed.sourceKind, execution: 'finite-protocol-peer', seedSha256: await fileDigest(seedPath),
    sourceProducer: producerRef, sourceBefore: seed.before,
    scope: 'Original current frontend finite solo producer and Main Stop/release, cold Main import, saved Task/settings readback, distinct fresh Host SDK generation, reply, Stop and reload',
    excluded: ['genuine historical donor frontend', 'vendor CLI/inference/auth qualification', 'multi-member or Windows source release', 'native source session adoption'] };
  options.evidence.finiteStoppedImportUiProof = proof;
  const step = (value: FiniteImportRow) => steps.push(value);
  const ui = createDesktopUiControls(cdp, { assertOwnedRenderer: options.assertOwnedRenderer, step });
  const effects = () => readDesktopEmulatedRuntimeEffects(fixture);
  const business = async () => (await effects()).filter(value => value.event === 'input' && value.marker !== 'TEST_MODEL_PROBE');
  const poll = async <T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string) => {
    const deadline = Date.now() + 90_000;
    for (;;) { const value = await read(); if (accept(value)) return value;
      options.assertOwnedRenderer(); assert.ok(Date.now() < deadline, label + '; original action is never repeated');
      await new Promise<void>(done => setTimeout(done, 100)); }
  };
  const screenshot = async (name: string) => {
    const image = row(await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }));
    const path = join(fixture.root, name); await writeFile(path, Buffer.from(String(image.data), 'base64'), { mode: 0o600, flag: 'wx' });
    return { path, sha256: await fileDigest(path) };
  };
  const openTeam = async (selection: string) => {
    await ui.waitRead(`Boolean(document.querySelector('button[aria-label="More actions"]'))`, 'original menu', 90_000);
    await ui.click('button[aria-label="More actions"]', 'open original menu'); await ui.click('button', 'open original Teams', 'Teams');
    const card = '.team-row-zebra-card[data-team-name=' + literal(selection) + ']';
    await ui.scrollTo(card, 'captured source or imported Team card'); await ui.click(card, 'open captured original Team card');
    await ui.waitRead(`Boolean(document.querySelector('button[aria-label="Edit team"]'))`, 'original stopped Team Detail');
  };
  const openDialog = async (prompt: string) => {
    await ui.scrollTo('button', 'original Detail Launch', 'Launch'); await ui.click('button', 'original Detail Launch once', 'Launch');
    const section = row(await ui.waitRead(`(()=>{const e=[...document.querySelectorAll('[role="dialog"] button[aria-controls]')].find(e=>e.textContent.includes('Optional launch settings'));return e?{id:e.getAttribute('aria-controls'),expanded:e.getAttribute('aria-expanded')}:null})()`, 'original Launch dialog'));
    options.observeOwnedHost();
    if (section.expanded !== 'true') {
      const selector = '[role="dialog"] button[aria-controls=' + literal(section.id) + ']';
      await ui.scrollTo(selector, 'original saved launch options'); await ui.click(selector, 'expand original saved launch options');
    }
    await ui.waitRead(`document.querySelector('[role="dialog"] #dialog-prompt')?.value===${literal(prompt)}`, 'saved original prompt');
    await ui.waitRead(`document.querySelector('[role="dialog"] #dialog-skip-permissions')?.getAttribute('data-state')==='unchecked'`, 'ordinary saved permissions');
    await ui.waitRead(`[...document.querySelectorAll('[role="dialog"] button[aria-label*=" provider,"]')].some(e=>e.textContent.trim()==='Sonnet 4.6')`, 'original saved source model');
    await ui.waitRead(`document.querySelector('[role="dialog"]')?.innerText.includes('All selected providers are ready')`, 'original Host preflight ready', 90_000);
  };
  const closeDialog = async () => {
    await ui.scrollTo('[role="dialog"] button', 'original Close without Submit', 'Close');
    await ui.click('[role="dialog"] button', 'close original Launch without Submit', 'Close');
    await ui.waitRead(`!document.querySelector('[role="dialog"] #dialog-prompt')`, 'dialog closed');
  };
  const reload = async () => {
    const origin = await cdp.evaluate('performance.timeOrigin'); step({ action: 'Page.reload', ignoreCache: false });
    await cdp.send('Page.reload', { ignoreCache: false });
    await ui.waitRead(`performance.timeOrigin!==${literal(origin)}&&Boolean(window.electronAPI)&&!document.getElementById('splash')`, 'real renderer reload', 90_000);
    await ui.observeInput();
  };
  const lookup = async () => row(await cdp.evaluate(`window.electronAPI.agentBackend.stoppedImport(${literal({ teamName: FINITE_SOURCE_TEAM, action: 'lookup' })})`));
  const importsPath = join(fixture.root, 'hoststore/.host-team-registry/imports');
  const ownerPath = join(fixture.root, 'hoststore/teams', FINITE_SOURCE_TEAM, '.host-owner/state.json');
  await ui.observeInput(); await openTeam(FINITE_SOURCE_TEAM); await openDialog(String(saved.prompt));
  const originalLookup = await lookup(); assert.equal(originalLookup.ok, true); assert.match(String(originalLookup.selection), /^host-team:/u);
  const imported = await finiteImportRecords(importsPath); assert.equal(imported.length, 1); assert.equal(imported[0]!.phase, 'published');
  const importedRecord = row(imported[0]!.record); assert.equal(importedRecord.teamName, FINITE_SOURCE_TEAM);
  const handleId = row(importedRecord.binding).handleId;
  assert.equal(originalLookup.selection, 'host-team:' + encodeURIComponent(String(handleId)));
  const dialogTarget = () => cdp.evaluate(`(()=>{const e=document.querySelector('[role="dialog"]');if(!e)return null;const k=Object.keys(e).find(k=>k.startsWith('__reactFiber$'));let f=k?e[k]:null;for(let n=0;f&&n<128;n++,f=f.return){const name=f.type?.name??f.type?.displayName??f.elementType?.name;if(name==='LaunchTeamDialog')return {teamName:f.memoizedProps.teamName,mode:f.memoizedProps.mode,cwd:f.memoizedProps.defaultProjectPath,members:f.memoizedProps.members.map(m=>m.name)};}return null})()`);
  const target = { teamName: originalLookup.selection, mode: 'launch', cwd: saved.cwd, members: ['team-lead'] };
  assert.deepEqual(await dialogTarget(), target);
  const ownerBefore = await json(ownerPath); assert.deepEqual(ownerBefore.runtimeCaptures ?? [], []);
  for (const [key, value] of Object.entries(saved)) assert.deepEqual(row(ownerBefore.savedSettings)[key], value);
  const taskPath = join(fixture.root, 'hoststore/tasks', FINITE_SOURCE_TEAM, String(sourceTask.id) + '.json');
  assert.deepEqual(await json(taskPath), sourceTask);
  assert.deepEqual(await business(), [], 'cold import never replays the legacy source prompt');
  proof.importedDialogScreenshot = await screenshot('ui-finite-import-dialog.png');
  await closeDialog(); await reload(); await openTeam(FINITE_SOURCE_TEAM); await openDialog(String(saved.prompt));
  assert.deepEqual(await dialogTarget(), target); assert.deepEqual(await lookup(), originalLookup);
  assert.deepEqual(await finiteImportRecords(importsPath), imported); await assertSource();
  proof.reloadedDialogScreenshot = await screenshot('ui-finite-import-dialog-reloaded.png');
  await closeDialog(); await openTeam(String(originalLookup.selection));
  const taskCard = '.kanban-task-card[data-task-id=' + literal(sourceTask.id) + ']';
  await ui.scrollTo(taskCard, 'genuine imported source Task');
  await ui.waitRead(`document.querySelector(${literal(taskCard)})?.textContent.includes(${literal(sourceTask.subject)})`, 'source Task visible in original Host Detail');
  proof.taskScreenshot = await screenshot('ui-finite-import-task.png');
  await openDialog(String(saved.prompt));
  assert.deepEqual(await business(), []);
  const sessionsBefore = await readDesktopNativeStopSessions(fixture.root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []; throw error;
  });
  assert.deepEqual(sessionsBefore, [], 'import/readback has no Runtime session allocation');
  await ui.scrollTo('[role="dialog"] #dialog-prompt', 'fresh Host launch prompt'); await ui.click('[role="dialog"] #dialog-prompt', 'edit fresh Host launch prompt');
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: process.platform === 'darwin' ? 4 : 2, commands: ['selectAll'] });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' });
  await cdp.send('Input.insertText', { text: FINITE_HOST_PROMPT });
  await ui.waitRead(`document.querySelector('[role="dialog"] #dialog-prompt')?.value===${literal(FINITE_HOST_PROMPT)}`, 'distinct fresh Host prompt');
  await ui.scrollTo('[role="dialog"] button', 'original fresh Host Launch', 'Launch team');
  await ui.waitRead(`[...document.querySelectorAll('[role="dialog"] button')].some(e=>e.textContent.trim()==='Launch team'&&!e.disabled)`, 'original fresh Host preflight', 90_000);
  await ui.click('[role="dialog"] button', 'submit fresh Host generation exactly once', 'Launch team');
  await ui.waitRead(`!document.querySelector('[role="dialog"] #dialog-prompt')`, 'original fresh Host Launch closes', 90_000);
  const ownerAfter = await poll(() => json(ownerPath), value => array(value.runtimeCaptures ?? []).length === 1, 'one fresh Host capture');
  const capture = array(ownerAfter.runtimeCaptures)[0]!; assert.notEqual(capture.launchId, seed.sourceRunId);
  const members = array(capture.members); assert.equal(members.length, 1); assert.equal(members[0]!.memberId, 'team-lead');
  assert.notEqual(members[0]!.principalId, seed.sourceSessionId);
  const sessions = () => readDesktopNativeStopSessions(fixture.root).then(values => values.filter(value => row(value.binding).runId === capture.launchId));
  const started = await poll(sessions, values => values.length === 1 && array(values[0]!.inputs).length === 1 && array(values[0]!.inputs).every(input => input.phase === 'terminal' && input.terminal === 'succeeded'), 'fresh correlated Host reply');
  const inputEffects = await effects();
  const inputs = inputEffects.filter(value => value.event === 'input' && value.marker !== 'TEST_MODEL_PROBE');
  assert.equal(inputs.length, 1); assert.equal(inputs[0]!.marker, FINITE_HOST_PROMPT);
  assert.notEqual(inputs[0]!.sessionId, seed.sourceSessionId);
  const inputCorrelation = assertFiniteImportInputCorrelation({ capture, session: started[0]!, effects: inputEffects,
    host: row(options.evidence.hostChildAfterImport), sourceSessionId: seed.sourceSessionId });
  await openDesktopEmulatedBootChat(cdp, { selector: 'button[aria-label^="lead,"]', timeoutMs: 60_000,
    replyLabel: 'distinct fresh Host finite reply', assertOwnedRenderer: options.assertOwnedRenderer, step,
    open: controls => controls.click('button[aria-label^="lead,"]', 'open original imported lead conversation') });
  await ui.waitRead(`document.body.innerText.includes(${literal(FINITE_HOST_REPLY)})`, 'fresh Host reply visible');
  // The ordinary lead chat reads native replies through the original Owner message page.
  const conversation = row(await cdp.evaluate(`window.electronAPI.agentBackend.invoke(${literal({ handle: { handleId }, commandId: randomUUID(), operation: 'team.messages.page', payload: {} })})`));
  assert.equal(conversation.ok, true);
  const conversationReadback = assertFiniteImportConversationReadback(conversation.value, inputCorrelation);
  proof.conversationReadback = conversationReadback;
  proof.freshLaunchScreenshot = await screenshot('ui-finite-import-fresh-launch.png');
  const runtimePid = Number(inputs[0]!.pid); assert.ok(processTable().some(value => value.pid === runtimePid));
  await ui.scrollTo('button[aria-label="Stop"]', 'original fresh Host Stop');
  await ui.click('button[aria-label="Stop"]', 'stop fresh Host generation exactly once');
  const stopped = await poll(sessions, values => values.length === 1 && values[0]!.phase === 'closed' && values[0]!.custody === 'released', 'fresh Host custody released');
  assert.deepEqual(stopped[0]!.inputs, started[0]!.inputs, 'Stop retains the original correlated logical input');
  assert.deepEqual(stopped[0]!.binding, started[0]!.binding);
  await poll(async () => processTable(), values => !values.some(value => value.pid === runtimePid), 'fresh Host peer physically absent');
  await assertSource(); assert.deepEqual(await json(taskPath), sourceTask);
  await reload(); await openTeam(String(originalLookup.selection)); await openDialog(FINITE_HOST_PROMPT);
  assert.deepEqual(await lookup(), originalLookup); assert.deepEqual(await finiteImportRecords(importsPath), imported);
  assert.deepEqual(await sessions(), stopped); assert.equal((await business()).length, 1); await assertSource();
  assert.equal(row((await json(ownerPath)).savedSettings).prompt, FINITE_HOST_PROMPT);
  proof.stoppedReloadScreenshot = await screenshot('ui-finite-import-stopped-reloaded.png');
  await closeDialog();
  Object.assign(proof, { status: 'PASS', importRecord: imported[0], lookup: originalLookup, dialogTarget: target,
    importedTask: sourceTask, sourceAfter: seed.before, originalLookupRetained: true,
    runtimeSessionsBeforeLaunch: sessionsBefore, capture, sessionBeforeStop: started[0], sessionAfterStop: stopped[0],
    freshInput: inputs[0], inputCorrelation, sourcePromptReplays: 0, freshInputCount: 1,
    stop: { runtimePid, releasedBeforeQuit: true, peerAbsent: true },
    fixturePins: await verifyDesktopEmulatedRuntimeFixture(fixture) });
}
