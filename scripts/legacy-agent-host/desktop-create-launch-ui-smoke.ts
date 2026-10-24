import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileDigest } from './desktop-backend-fixture.ts';
import { createDesktopUiControls } from './desktop-ui-controls.ts';
import {
  openOriginalCreateForm,
  runDesktopCreateConfigUiSmoke,
} from './desktop-create-config-ui-smoke.ts';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';
import { command, processTable } from './desktop-backend-observations.ts';
import { readCreateDialogDiagnostics } from './desktop-create-diagnostics.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';
import type { prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import type { startNativeTeamModel } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts';

const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
export async function runDesktopCreateUiSmoke(
  cdp: UiCdpPort,
  options: {
    fixture: Awaited<ReturnType<typeof prepareDesktopBackendFixture>>;
    evidence: Record<string, unknown>;
    model?: Awaited<ReturnType<typeof startNativeTeamModel>> | undefined;
    assertOwnedRenderer(): void;
  }
): Promise<void> {
  if (!options.model) return runDesktopCreateConfigUiSmoke(cdp, options);
  const { fixture, model } = options;
  const steps: Record<string, unknown>[] = [];
  const proof: Record<string, unknown> = {
    status: 'INCOMPLETE',
    steps,
    scope:
      'Original CreateTeamDialog launch → scoped no-tool probe → one created Team/native session → SDK MCP/Bash/reply → original Stop/reload',
    excluded: ['real vendor access', 'Resume', 'mixed/advanced options', 'full Stage1'],
  };
  options.evidence.createLaunchDialogProof = proof;
  const ui = createDesktopUiControls(cdp, {
    assertOwnedRenderer: () => {
      options.assertOwnedRenderer();
      assert.deepEqual(model.failures, [], 'local native-model protocol remains valid');
    },
    step: (value) => steps.push({ monotonicMs: Math.round(performance.now()), ...value }),
  });
  const read = async (path: string) => record(JSON.parse(await readFile(path, 'utf8')));
  const poll = async <T>(read: () => Promise<T>, accepts: (value: T) => boolean, label: string) => {
    const end = performance.now() + 90_000;
    let value = await read();
    while (!accepts(value) && performance.now() < end) {
      assert.deepEqual(model.failures, []);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      value = await read();
    }
    assert.ok(accepts(value), label);
    return value;
  };
  await openOriginalCreateForm(cdp, ui, join(fixture.root, 'workspace'), 'test-created-native');
  const teamRoot = join(fixture.root, 'hoststore/teams/test-created-native');
  assert.ok(
    !(await readdir(join(fixture.root, 'hoststore/teams'))).includes('test-created-native'),
    'opening Create never creates Team'
  );
  await ui.scrollTo(
    '[role="dialog"] button[aria-label*=" provider,"]',
    'original Create lead model'
  );
  await ui.click(
    '[role="dialog"] button[aria-label*=" provider,"]',
    'expand original Create lead row'
  );
  await ui.scrollTo(
    '[role="dialog"] [data-testid="team-model-selector-model-option"][aria-label^="Opus 4.6"]',
    'original Create Opus4.6'
  );
  await ui.click(
    '[role="dialog"] [data-testid="team-model-selector-model-option"][aria-label^="Opus 4.6"]',
    'select original Create Opus4.6'
  );
  await ui.scrollTo('[role="dialog"] button', 'original Create Medium effort', 'Medium');
  await ui.click('[role="dialog"] button', 'select original Create Medium effort', 'Medium');
  const optional = record(
    await ui.waitRead(
      `(()=>{const b=[...document.querySelectorAll('[role="dialog"] button[aria-controls]')].find(e=>e.textContent.includes('Optional launch settings'));return b?{id:b.getAttribute('aria-controls'),expanded:b.getAttribute('aria-expanded')}:null})()`,
      'original optional Create launch settings'
    )
  );
  if (optional.expanded !== 'true') {
    const selector = `[role="dialog"] button[aria-controls=${JSON.stringify(optional.id)}]`;
    await ui.scrollTo(selector, 'original Create details control');
    await ui.click(selector, 'expand original Create details');
  }
  await ui.scrollTo('[role="dialog"] #team-prompt', 'original Create prompt');
  await ui.click('[role="dialog"] #team-prompt', 'focus original Create prompt');
  await cdp.send('Input.insertText', { text: 'NATIVE_TEAM_ONE' });
  await ui.waitRead(
    `document.querySelector('[role="dialog"] #team-prompt')?.value==='NATIVE_TEAM_ONE'`,
    'original Create prompt retained'
  );
  await ui.scrollTo('[role="dialog"] button', 'original Create launch submit', 'Create');
  try {
    await ui.click('[role="dialog"] button', 'submit original Create launch once', 'Create');
  } catch (error) {
    proof.submitDiagnostics = await readCreateDialogDiagnostics(cdp);
    throw error;
  }
  await ui.waitRead(
    `!document.querySelector('[role="dialog"] #team-name')`,
    'original Create closes',
    90_000
  );
  const state = await poll(
    () => read(join(teamRoot, '.host-owner/state.json')),
    (row) => Array.isArray(row.runtimeCaptures) && row.runtimeCaptures.length === 1,
    'one fresh created Team capture'
  );
  const capture = record((state.runtimeCaptures as unknown[])[0]);
  const saved = record(state.savedSettings);
  assert.equal(saved.model, 'claude-opus-4-6');
  assert.equal(saved.effort, 'medium');
  assert.equal(saved.prompt, 'NATIVE_TEAM_ONE');
  assert.equal(saved.limitContext, false);
  assert.equal(saved.skipPermissions, true);
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
      (rows[0]!.inputs as unknown[]).map(record).every((input) => input.phase === 'terminal' && input.terminal === 'succeeded'),
    'one native initial input'
  );
  assert.equal(model.observations.length, 8);
  assert.ok(model.probes.length >= 1 && model.probes.length <= 8);
  assert.ok(model.observations.every((row) => row.requestedModel === 'claude-opus-4-6' && row.requestedEffort === 'medium' && row.contextEffective));
  assert.ok(model.observations.some((row) => row.toolResultError), 'actual Bash exit7 observed');
  assert.deepEqual(model.failures, []);
  assert.equal(await readFile(join(fixture.root, 'workspace/native-effect.txt'), 'utf8'), 'ONE\n');
  const tasks = await Promise.all(
    (await readdir(join(fixture.root, 'hoststore/tasks/test-created-native')))
      .filter((name) => /^[A-Za-z0-9_-]+\.json$/.test(name))
      .map((name) => read(join(fixture.root, 'hoststore/tasks/test-created-native', name)))
  );
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.owner, 'team-lead');
  assert.equal(tasks[0]!.status, 'completed');
  await ui.click('button[aria-label^="lead,"]', 'open original created lead thread');
  await ui.waitRead(
    `document.body.innerText.includes('REPLY_NATIVE_ONE')`,
    'created native reply visible'
  );
  const shot = record(
    await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  );
  const screenshot = join(fixture.root, 'ui-original-create-native.png');
  await writeFile(screenshot, Buffer.from(String(shot.data), 'base64'), { mode: 0o600 });
  const hosts = processTable().filter(
    (row) => command(row.pid) === `${fixture.node} ${fixture.hostEntry}`
  );
  assert.equal(hosts.length, 1);
  const children = processTable().filter((row) => row.ppid === hosts[0]!.pid);
  assert.ok(children.length > 0);
  await ui.scrollTo('button[aria-label="Stop"]', 'original created Team Stop');
  await ui.click('button[aria-label="Stop"]', 'Stop original created Team once', 'Stop');
  await poll(
    sessions,
    (rows) => rows.length === 1 && rows[0]!.phase === 'closed' && rows[0]!.custody === 'released',
    'created native custody released'
  );
  await poll(
    async () => processTable(),
    (rows) => children.every((child) => !rows.some((row) => row.pid === child.pid)),
    'created native children absent'
  );
  const time = await cdp.evaluate('performance.timeOrigin');
  await cdp.send('Page.reload', { ignoreCache: false });
  await ui.waitRead(
    `performance.timeOrigin!==${JSON.stringify(time)}&&Boolean(window.electronAPI)&&!document.getElementById('splash')`,
    'real created Team renderer reload'
  );
  await ui.waitRead(
    `Boolean(document.querySelector('button[aria-label="More actions"]'))`,
    'reloaded existing menu',
    90_000
  );
  await ui.click('button[aria-label="More actions"]', 'open reloaded application menu');
  await ui.click('button', 'open reloaded Teams list', 'Teams');
  await ui.waitRead(
    `document.body.innerText.includes('test-created-native')`,
    'created Team retained after reload',
    90_000
  );
  const final = await read(join(teamRoot, '.host-owner/state.json'));
  assert.deepEqual(final.savedSettings, saved);
  assert.equal((final.runtimeCaptures as unknown[]).length, 1);
  assert.equal(model.observations.length, 8);
  Object.assign(proof, {
    status: 'PASS',
    capture,
    savedSettings: saved,
    nativeSessionBeforeStop: before[0],
    nativeTask: tasks[0],
    stop: { nativeChildren: children, releasedBeforeQuit: true },
    settingsRetainedAfterReload: true,
    screenshot: { path: screenshot, sha256: await fileDigest(screenshot) },
    probes: model.probes,
  });
}
