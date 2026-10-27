import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { command, processTable } from './desktop-backend-observations.ts';
import { fileDigest } from './desktop-backend-fixture.ts';
import {
  startMixedProgressObservation,
  finishMixedProgressObservation,
} from './desktop-mixed-dialog-settings.ts';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';
import { revealDesktopReply } from './desktop-reply-visibility.ts';
import { stoppedImportSourceBytes } from './desktop-stopped-import-fixture.ts';
import { createDesktopUiControls, desktopJsLiteral } from './desktop-ui-controls.ts';
import type { StoppedImportUiSeed } from './desktop-stopped-import-fixture.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';
import type { prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import type { startNativeTeamModel } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts';

const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const read = async (path: string) => record(JSON.parse(await readFile(path, 'utf8')));

/** Continuation of the existing import smoke; all mutations use its original Launch/Stop controls. */
export async function runStoppedImportLaunchUi(
  cdp: UiCdpPort,
  options: {
    fixture: Awaited<ReturnType<typeof prepareDesktopBackendFixture>>;
    seed: StoppedImportUiSeed;
    selection: string;
    handleId: string;
    model: Awaited<ReturnType<typeof startNativeTeamModel>>;
    evidence: Record<string, unknown>;
    importedTask: Record<string, unknown>;
    openTeams(): Promise<void>;
    openSourceDialog(): Promise<void>;
    assertOwnedRenderer(): void;
    step(value: Record<string, unknown>): void;
  }
) {
  const { fixture, seed, model } = options;
  assert.equal(seed.sourceKind, 'captured-stopped-solo');
  assert.ok(seed.priorRun);
  assert.equal(await fileDigest(seed.priorRun.path), seed.priorRun.sha256);
  const source = await read(seed.priorRun.path);
  const proof: Record<string, unknown> = {
    status: 'INCOMPLETE',
    sourcePreparation: source,
    scope:
      'Synthetic stopped legacy solo product/run records plus actual captured source-owned TEST child Stop; original imported Launch dialog creates a fresh actual SDK/CLI conversation, task/Bash/reply, original Stop and reload',
    excluded: [
      'old provider inference/history qualification',
      'native resume/adoption',
      'vendor credentials/inference',
      'multi-member prior-run import',
      'full Stage1',
    ],
  };
  options.evidence.nativeLaunch = proof;
  const teamRoot = join(fixture.root, 'hoststore/teams', seed.teamName);
  const savedBefore = record((await read(join(teamRoot, '.host-owner/state.json'))).savedSettings);
  const ui = createDesktopUiControls(cdp, {
    assertOwnedRenderer: options.assertOwnedRenderer,
    step: options.step,
  });
  const poll = async <T>(
    observe: () => Promise<T>,
    accepts: (value: T) => boolean,
    label: string
  ) => {
    const deadline = Date.now() + 90_000;
    let value = await observe();
    while (!accepts(value) && Date.now() < deadline) {
      options.assertOwnedRenderer();
      assert.deepEqual(model.failures, []);
      await new Promise<void>((done) => setTimeout(done, 100));
      value = await observe();
    }
    assert.ok(accepts(value), label);
    return value;
  };
  await options.openSourceDialog();
  await ui.scrollTo('[role="dialog"] #dialog-prompt', 'original imported launch prompt');
  await ui.click('[role="dialog"] #dialog-prompt', 'edit original imported launch prompt');
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'a',
    code: 'KeyA',
    modifiers: 4,
    commands: ['selectAll'],
  });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4 });
  await cdp.send('Input.insertText', { text: 'NATIVE_TEAM_ONE' });
  await ui.waitRead(
    `document.querySelector('[role="dialog"] #dialog-prompt')?.value==='NATIVE_TEAM_ONE'`,
    'original imported prompt edited'
  );
  await ui.scrollTo(
    '[role="dialog"] #dialog-skip-permissions',
    'original explicit TEST tool approval choice'
  );
  await ui.click(
    '[role="dialog"] #dialog-skip-permissions',
    'allow TEST native tool execution through original checkbox'
  );
  await ui.waitRead(
    `document.querySelector('[role="dialog"] #dialog-skip-permissions')?.getAttribute('data-state')==='checked'`,
    'explicit original approval choice selected'
  );
  await startMixedProgressObservation(cdp);
  await ui.scrollTo('[role="dialog"] button', 'original imported Launch submit', 'Launch team');
  await ui.click(
    '[role="dialog"] button',
    'launch imported saved Team exactly once',
    'Launch team'
  );
  await ui.waitRead(
    `!document.querySelector('[role="dialog"] #dialog-prompt')`,
    'original imported Launch dialog closes',
    90_000
  );
  const state = await poll(
    () => read(join(teamRoot, '.host-owner/state.json')),
    (row) => Array.isArray(row.runtimeCaptures) && row.runtimeCaptures.length === 1,
    'one fresh imported runtime capture'
  );
  const capture = record((state.runtimeCaptures as unknown[])[0]);
  assert.notEqual(capture.launchId, source.sourceRunId);
  const members = (capture.members as unknown[]).map(record);
  assert.equal(members.length, 1);
  assert.equal(members[0]!.memberId, 'team-lead');
  assert.notEqual(members[0]!.principalId, source.sourceSessionId);
  const saved = record(state.savedSettings);
  assert.deepEqual(saved, {
    ...savedBefore,
    prompt: 'NATIVE_TEAM_ONE',
    skipPermissions: true,
    allowExperimentalLocalModels: false,
  });
  assert.equal(saved.allowExperimentalLocalModels, false);
  const sessions = () =>
    readDesktopNativeStopSessions(fixture.root).then((rows) =>
      rows.filter((row) => record(row.binding).runId === capture.launchId)
    );
  const before = await poll(
    sessions,
    (rows) =>
      rows.length === 1 &&
      Array.isArray(rows[0]!.inputs) &&
      (rows[0]!.inputs as unknown[]).length === 1 &&
      (rows[0]!.inputs as unknown[])
        .map(record)
        .every((input) => input.phase === 'terminal' && input.terminal === 'succeeded'),
    'one actual imported native input completes'
  );
  assert.equal(model.observations.length, 8);
  assert.ok(
    model.observations.every(
      (row) =>
        row.contextEffective &&
        row.requestedModel === seed.savedSettings.model &&
        row.requestedEffort === seed.savedSettings.effort
    )
  );
  assert.ok(model.observations.some((row) => row.toolResultError));
  assert.deepEqual(model.failures, []);
  assert.equal(await readFile(join(fixture.root, 'workspace/native-effect.txt'), 'utf8'), 'ONE\n');
  const taskDirectory = join(fixture.root, 'hoststore/tasks', seed.teamName);
  assert.deepEqual(
    await read(join(taskDirectory, seed.taskId + '.json')),
    options.importedTask,
    'native work never rewrites the retained imported Task'
  );
  const tasks = await Promise.all(
    (await readdir(taskDirectory))
      .filter((name) => /^[A-Za-z0-9_-]+\.json$/.test(name))
      .map((name) => read(join(taskDirectory, name)))
  );
  const nativeTasks = tasks.filter((task) => task.subject === 'Native TEST task');
  assert.equal(nativeTasks.length, 1);
  assert.equal(nativeTasks[0]!.owner, 'team-lead');
  assert.equal(nativeTasks[0]!.status, 'completed');
  const snapshot = record(
    await cdp.evaluate(
      `window.electronAPI.agentBackend.invoke(${desktopJsLiteral({ handle: { handleId: options.handleId }, commandId: randomUUID(), operation: 'team.snapshot', payload: {} })})`
    )
  );
  assert.equal(snapshot.ok, true);
  assert.equal(
    (record(snapshot.value).messages as unknown[])
      .map(record)
      .filter((row) => row.text === 'REPLY_NATIVE_ONE').length,
    1
  );
  await ui.click('button[aria-label^="lead,"]', 'open original imported lead chat');
  await ui.waitRead(
    `document.body.innerText.includes('REPLY_NATIVE_ONE')`,
    'imported native reply appears'
  );
  await revealDesktopReply(cdp, 'REPLY_NATIVE_ONE', options);
  proof.visibleProgress = await finishMixedProgressObservation(cdp);
  assert.ok(
    Array.isArray(proof.visibleProgress) && proof.visibleProgress.length >= 2,
    'original visible launch/progress UI changed during native work'
  );
  const hosts = processTable().filter(
    (row) => command(row.pid) === `${fixture.node} ${fixture.hostEntry}`
  );
  assert.equal(hosts.length, 1);
  const children = processTable().filter((row) => row.ppid === hosts[0]!.pid);
  assert.ok(children.length > 0, 'capture target provider children before Stop');
  await ui.scrollTo('button[aria-label="Stop"]', 'original imported Team Stop');
  await ui.click('button[aria-label="Stop"]', 'stop original imported runtime once', 'Stop');
  await poll(
    sessions,
    (rows) => rows.length === 1 && rows[0]!.phase === 'closed' && rows[0]!.custody === 'released',
    'imported native custody released'
  );
  await poll(
    async () => processTable(),
    (rows) => children.every((child) => !rows.some((row) => row.pid === child.pid)),
    'captured target children physically absent'
  );
  const origin = await cdp.evaluate('performance.timeOrigin');
  await cdp.send('Page.reload', { ignoreCache: false });
  await ui.waitRead(
    `performance.timeOrigin!==${desktopJsLiteral(origin)}&&Boolean(window.electronAPI)&&!document.getElementById('splash')`,
    'real renderer reload after imported Stop'
  );
  await ui.observeInput();
  await options.openTeams();
  const card = `.team-row-zebra-card[data-team-name=${JSON.stringify(options.selection)}]`;
  await ui.scrollTo(card, 'same canonical imported Team after reload');
  await ui.click(card, 'reopen original imported Team');
  await ui.scrollTo('button', 'original imported Launch after reload', 'Launch');
  await ui.click('button', 'reopen original imported Launch settings', 'Launch');
  const section = record(
    await ui.waitRead(
      `(()=>{const b=[...document.querySelectorAll('[role="dialog"] button[aria-controls]')].find(e=>e.textContent.includes('Optional launch settings'));return b?{id:b.getAttribute('aria-controls'),expanded:b.getAttribute('aria-expanded')}:null})()`,
      'original imported optional settings'
    )
  );
  if (section.expanded !== 'true')
    await ui.click(
      `[role="dialog"] button[aria-controls=${JSON.stringify(section.id)}]`,
      'expand original imported settings'
    );
  await ui.waitRead(
    `document.querySelector('[role="dialog"] #dialog-prompt')?.value==='NATIVE_TEAM_ONE'`,
    'saved imported prompt survives reload'
  );
  assert.equal(
    await cdp.evaluate(
      `document.querySelector('[role="dialog"] #dialog-skip-permissions')?.getAttribute('data-state')`
    ),
    'checked'
  );
  assert.deepEqual(
    record((await read(join(teamRoot, '.host-owner/state.json'))).savedSettings),
    saved
  );
  assert.deepEqual(
    await stoppedImportSourceBytes(fixture.root, seed.roots),
    seed.before,
    'source archive stays byte-identical through new target work'
  );
  assert.equal(model.observations.length, 8, 'reopen never replays imported or new input');
  Object.assign(proof, {
    status: 'PASS',
    capture,
    savedSettings: saved,
    nativeSessionBeforeStop: before[0],
    nativeTask: nativeTasks[0],
    stop: { nativeChildren: children, releasedBeforeQuit: true },
    settingsRetainedAfterReload: true,
    sourceAfter: seed.before,
  });
}
