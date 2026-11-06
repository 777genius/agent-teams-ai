import assert from 'node:assert/strict';
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';
import { command, groupMembers, processTable } from './desktop-backend-observations.ts';
import { createDesktopUiControls } from './desktop-ui-controls.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';
import type { ProcessIdentity } from './desktop-backend-observations.ts';
import type { startNativeTeamModel } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts';

const record = (raw: unknown): Record<string, unknown> => {
  assert.ok(raw && typeof raw === 'object' && !Array.isArray(raw));
  return raw as Record<string, unknown>;
};
const json = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'));
const hash = (raw: unknown): string =>
  createHash('sha256').update(JSON.stringify(raw)).digest('hex');
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 100));
async function until(test: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await test()) return;
    await tick();
  }
  throw new Error(`${label}; no action retry`);
}
async function files(
  directory: string,
  allowAbsent = false
): Promise<{ name: string; value: Record<string, unknown> }[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    if (allowAbsent && (error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  assert.ok(
    entries.length <= 256 &&
      entries.every((entry) => entry.isFile() && /^[a-zA-Z0-9_-]+\.json$/.test(entry.name))
  );
  return Promise.all(
    entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (entry) => ({
        name: entry.name,
        value: record(await json(join(directory, entry.name))),
      }))
  );
}
async function originalSession(root: string): Promise<Record<string, unknown>> {
  const sessions = await readDesktopNativeStopSessions(root);
  assert.equal(sessions.length, 1, 'one exact configured native Runtime, never the latest default');
  return sessions[0]!;
}
function inputs(session: Record<string, unknown>): Record<string, unknown>[] {
  assert.ok(Array.isArray(session.inputs));
  return session.inputs.map(record);
}
async function productSnapshot(root: string) {
  const team = join(root, 'hoststore/teams/test-desktop-backend');
  const state = record(await json(join(team, '.host-owner/state.json')));
  const commands = await files(join(team, '.host-owner/commands'));
  const outbox = await files(join(team, '.host-owner/outbox'), true);
  const tasks = await files(join(root, 'hoststore/tasks/test-desktop-backend'));
  const directory = join(team, 'inboxes');
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  assert.ok(
    entries.length <= 16 &&
      entries.every((entry) => entry.isFile() && /^[a-zA-Z0-9_-]+\.json$/.test(entry.name))
  );
  const inboxes = await Promise.all(
    entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (entry) => {
        const raw = await json(join(directory, entry.name));
        assert.ok(Array.isArray(raw) && raw.length <= 512);
        const messages = raw.map((value) => {
          const { read: _read, readAt: _readAt, ...message } = record(value);
          return message;
        });
        return { name: entry.name, value: { messages } };
      })
  );
  return {
    captures: hash({
      runtimeCaptures: state.runtimeCaptures ?? null,
      members: state.members,
      rosterRevision: state.rosterRevision,
    }),
    commands: hash(commands),
    outbox: hash(outbox),
    tasks: hash(tasks),
    inboxes: hash(inboxes),
  };
}
async function absent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}
async function screenshot(cdp: UiCdpPort, root: string, name: string) {
  const image = record(
    await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
    })
  );
  assert.equal(typeof image.data, 'string');
  const path = join(root, name);
  const bytes = Buffer.from(String(image.data), 'base64');
  await writeFile(path, bytes, { mode: 0o600 });
  return { path, sha256: createHash('sha256').update(bytes).digest('hex') };
}
/** Existing TEST setup launch is followed by original Composer actions; never Stop before Quit. */
export async function runDesktopNativeQuitMode(
  cdp: UiCdpPort,
  options: {
    mode: string;
    root: string;
    seed?: { subject: string };
    evidence: Record<string, unknown>;
    model?: Awaited<ReturnType<typeof startNativeTeamModel>>;
    assertOwnedRenderer(): void;
  }
): Promise<boolean> {
  if (!['native-quit-ui', 'native-quit-readback-ui'].includes(options.mode)) return false;
  assert.ok(options.seed);
  const steps: Record<string, unknown>[] = [];
  const ui = createDesktopUiControls(cdp, {
    assertOwnedRenderer: options.assertOwnedRenderer,
    step: (value) => steps.push(value),
  });
  if (options.mode === 'native-quit-ui' && process.env.LEGACY_DESKTOP_QUIT_SCENARIO === 'pending-open') {
    assert.ok(options.model);
    assert.deepEqual(options.model.observations, []);
    assert.deepEqual(options.model.failures, []);
    options.evidence.nativeQuitUiProof = { status: 'INCOMPLETE', scenario: 'pending-open', steps,
      scope: 'Actual native provider open pending, zero inputs; existing guarded Quit semantic public UI API',
      excluded: ['active+queued input proof', 'automatic app.relaunch', 'vendor inference/authentication', 'Stage2'],
      screenshot: await screenshot(cdp, options.root, 'ui-native-pending-open-before-quit.png') };
    return true;
  }
  await ui.observeInput();
  await ui.clickSidebar(options.seed.subject);
  await ui.click('button[aria-label^="alice,"]', 'open original alice direct chat');
  await ui.waitRead(
    "Boolean(document.querySelector('.message-composer-flat-layout textarea'))",
    'original Composer visible'
  );
  if (options.mode === 'native-quit-readback-ui') {
    const source = record(await json(join(options.root, 'desktop-backend-receipt.json')));
    const prior = record(source.nativeQuitUiProof);
    const after = record(prior.afterQuit);
    assert.deepEqual(
      await originalSession(options.root),
      after.session,
      'cold startup preserves original sealed input outcomes'
    );
    if (prior.scenario === 'pending-open') assert.deepEqual(inputs(await originalSession(options.root)), []);
    else await ui.waitRead(
      "document.body.innerText.includes('NATIVE_TEAM_ONE')&&document.body.innerText.includes('NATIVE_TEAM_TWO')",
      'both original human messages visible after same-profile startup'
    );
    assert.deepEqual(
      await productSnapshot(options.root),
      after.product,
      'cold UI reads never replay original commands or delivery'
    );
    const table = processTable(),
      paths = record(options.evidence.paths);
    const hosts = table.filter(
      (row) =>
        row.pgid === Number(record(options.evidence.app).processGroup) &&
        command(row.pid) === `${String(paths.node)} ${String(paths.hostEntry)}`
    );
    assert.equal(hosts.length, 1, 'same-profile original Host transport present');
    assert.equal(
      table.filter((row) => row.ppid === hosts[0]!.pid).length,
      0,
      'no native child allocated during cold readback'
    );
    options.evidence.nativeQuitReadback = {
      status: 'INCOMPLETE',
      steps,
      sessionUnchanged: true,
      productUnchanged: true,
      screenshot: await screenshot(cdp, options.root, 'ui-native-quit-readback.png'),
      qualification: prior.scenario === 'pending-open'
        ? 'Pending-open Quit + same-profile next startup; automatic app.relaunch unqualified'
        : 'Active/queued Quit + same-profile next startup; automatic app.relaunch and pending provider-open unqualified',
    };
    return true;
  }
  assert.ok(options.model);
  const heldRequests = options.model.heldInitialRequests;
  assert.ok(heldRequests);
  options.evidence.nativeQuitUiProof = {
    status: 'INCOMPLETE',
    steps,
    scope:
      'Original Composer twice, real native first request held by localhost inference, original guarded Quit semantic public UI API; no human menu click',
    excluded: [
      'automatic app.relaunch',
      'pending provider-open',
      'vendor inference/authentication',
      'Stage2',
    ],
  };
  const ids: string[] = [];
  for (const turn of ['NATIVE_TEAM_ONE', 'NATIVE_TEAM_TWO']) {
    await ui.click('.message-composer-flat-layout textarea', 'focus original Composer');
    await cdp.send('Input.insertText', { text: turn });
    await ui.waitRead(
      `document.querySelector('.message-composer-flat-layout textarea')?.value===${JSON.stringify(turn)}`,
      'typed original message retained'
    );
    await ui.click('button.message-composer-send-button', 'original Send once', 'Send');
    await ui.waitRead(
      "document.querySelector('.message-composer-flat-layout textarea')?.value===''",
      'original Send admitted'
    );
    let id = '';
    await until(async () => {
      const commands = await files(
        join(options.root, 'hoststore/teams/test-desktop-backend/.host-owner/commands')
      );
      const matching = commands.filter(
        ({ value }) =>
          value.principalId === 'TEST-human' &&
          record(value.command).operation === 'message.send' &&
          record(record(value.command).payload).text === turn
      );
      if (!matching.length) return false;
      assert.equal(matching.length, 1);
      const receipt = matching[0]!.value;
      if (receipt.phase !== 'completed') return false;
      id = String(receipt.commandId);
      assert.match(id, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
      assert.equal(record(record(receipt.command).payload).messageId, id);
      const deliveryId = String(record(receipt.effects).deliveryId);
      const outbox = record(
        await json(
          join(
            options.root,
            'hoststore/teams/test-desktop-backend/.host-owner/outbox',
            deliveryId + '.json'
          )
        )
      );
      assert.equal(outbox.messageId, id);
      assert.equal(outbox.inputId, deliveryId);
      if (outbox.phase === 'pending') return false;
      assert.equal(outbox.phase, 'admitted');
      const session = await originalSession(options.root);
      const input = inputs(session).find((input) => record(input.intent).inputId === deliveryId);
      if (!input) return false;
      assert.equal(record(input.intent).messageId, id);
      assert.deepEqual(record(input.intent).binding, session.binding);
      return turn === 'NATIVE_TEAM_ONE'
        ? ['claimed', 'consumed'].includes(String(input.phase))
        : input.phase === 'admitted';
    }, `exact original ${turn} command/outbox/input persisted`);
    ids.push(id);
    if (turn === 'NATIVE_TEAM_ONE')
      await until(
        async () => heldRequests.length === 1,
        'actual first native request held before response'
      );
  }
  assert.equal(options.model.observations.length, 1);
  assert.deepEqual(options.model.failures, []);
  const session = await originalSession(options.root);
  const admitted = inputs(session);
  assert.equal(admitted.length, 2);
  assert.ok(['claimed', 'consumed'].includes(String(admitted[0]!.phase)));
  assert.equal(admitted[1]!.phase, 'admitted');
  const before = {
    session,
    product: await productSnapshot(options.root),
    messageIds: ids,
    observations: options.model.observations.length,
  };
  Object.assign(record(options.evidence.nativeQuitUiProof), {
    beforeQuit: before,
    screenshot: await screenshot(cdp, options.root, 'ui-native-before-quit.png'),
  });
  return true;
}
/** Last read immediately before the original common Quit, after screenshot and sentinel census. */
export async function capturePendingDesktopNativeQuit(root: string, evidence: Record<string, unknown>, model: Awaited<ReturnType<typeof startNativeTeamModel>> | undefined): Promise<void> {
  const proof = evidence.nativeQuitUiProof;
  if (!proof || record(proof).scenario !== 'pending-open') return;
  assert.ok(model);
  assert.deepEqual(model.observations, []);
  assert.deepEqual(model.failures, []);
  const product = await productSnapshot(root);
  const session = await originalSession(root);
  assert.equal(session.phase, 'opening', 'actual open must still be pending immediately before Quit');
  assert.equal(session.nativeReady, false);
  assert.equal(session.sealed, false);
  assert.deepEqual(inputs(session), []);
  assert.deepEqual(session.interactions, []);
  const setup = record(evidence.nativeSetup);
  assert.deepEqual(session.binding, record(setup.session).binding);
  assert.ok(Array.isArray(setup.nativeChildren) && setup.nativeChildren.length === 1);
  assert.ok(setup.nativeChildren.every(child => processTable().some(row => row.pid === Number(record(child).pid))));
  record(proof).beforeQuit = { session, product, observations: 0 };
}
/** Called only after common harness proves original Host absent, before fallback process cleanup. */
export async function verifyDesktopNativeQuitAfterShutdown(
  mode: string,
  root: string,
  evidence: Record<string, unknown>,
  nativeChildren: ProcessIdentity[],
  model: Awaited<ReturnType<typeof startNativeTeamModel>> | undefined,
  originalGroup: number
): Promise<void> {
  if (mode === 'native-quit-readback-ui') {
    await until(
      async () => groupMembers(originalGroup).length === 0,
      'readback app exits before harness cleanup'
    );
    const source = record(await json(join(root, 'desktop-backend-receipt.json')));
    const after = record(record(source.nativeQuitUiProof).afterQuit);
    assert.deepEqual(await originalSession(root), after.session);
    assert.deepEqual(await productSnapshot(root), after.product);
    assert.equal(await absent(join(root, 'hoststore/.legacy-agent-host-writer.lock')), true);
    Object.assign(record(evidence.nativeQuitReadback), {
      status: 'PASS',
      unchangedThroughSecondQuit: true,
    });
    return;
  }
  if (mode !== 'native-quit-ui') return;
  assert.ok(model && nativeChildren.length === 1);
  const heldRequests = model.heldInitialRequests;
  assert.ok(heldRequests);
  assert.ok(
    nativeChildren.every((child) => !processTable().some((row) => row.pid === child.pid)),
    'captured original native child absent after guarded Quit, before cleanup'
  );
  const pendingOpen = record(evidence.nativeQuitUiProof).scenario === 'pending-open';
  if (!pendingOpen) await until(
    async () => heldRequests.length === 1 && heldRequests[0]!.disconnected,
    'original native inference connection closed during Quit'
  );
  assert.equal(model.observations.length, pendingOpen ? 0 : 1, 'no unexpected native inference');
  if (pendingOpen) assert.deepEqual(heldRequests, []);
  assert.deepEqual(model.failures, []);
  assert.ok(Number.isSafeInteger(originalGroup) && originalGroup > 0);
  await until(
    async () => groupMembers(originalGroup).length === 0,
    'original app and captured process group exit without harness signals'
  );
  const proof = record(evidence.nativeQuitUiProof),
    before = record(proof.beforeQuit),
    session = await originalSession(root);
  assert.equal(session.sealed, true);
  const released = session.phase === 'closed' && session.custody === 'released';
  const heldOpen = pendingOpen && session.phase === 'held' && session.custody === 'unknown' &&
    session.diagnostic === 'open-unknown';
  assert.ok(released || heldOpen, 'confirmed close or explicitly retained pending-open uncertainty');
  assert.equal(session.nativeReady, false);
  if (pendingOpen) assert.deepEqual(session.interactions, []);
  const rows = inputs(session);
  const original = inputs(record(before.session));
  assert.equal(rows.length, pendingOpen ? 0 : 2);
  for (let index = 0; index < rows.length; index++) {
    assert.deepEqual(rows[index]!.intent, original[index]!.intent);
    assert.equal(rows[index]!.operationRef, original[index]!.operationRef);
    assert.equal(rows[index]!.fingerprint, original[index]!.fingerprint);
  }
  if (!pendingOpen) {
    assert.ok(
      rows[0]!.phase === 'unknown' ||
        (rows[0]!.phase === 'terminal' &&
          ['cancelled', 'failed'].includes(String(rows[0]!.terminal))),
      'held active input never fabricated as succeeded'
    );
    assert.equal(rows[1]!.phase, 'cancelled', 'queued original input cancelled without dispatch');
  }
  assert.deepEqual(
    await productSnapshot(root),
    before.product,
    'Quit does not replay or fabricate product effects'
  );
  assert.equal(
    await absent(join(root, 'workspace/native-effect.txt')),
    true,
    'held inference never ran a native tool'
  );
  assert.equal(
    await absent(join(root, 'hoststore/.legacy-agent-host-writer.lock')),
    true,
    'original writer lock released before next startup'
  );
  Object.assign(proof, {
    status: 'PASS',
    afterQuit: {
      session,
      runtimeOutcome: heldOpen ? 'held-unknown' : 'closed-released',
      debtRetained: heldOpen,
      qualification: heldOpen
        ? 'Safe pending-open shutdown retaining UNKNOWN; physical absence does not prove provider custody release'
        : 'Original Runtime close and captured physical cleanup confirmed',
      product: await productSnapshot(root),
      nativeChildrenAbsent: true,
      originalGroupAbsentBeforeHarnessCleanup: true,
      writerLockReleased: true,
      observations: model.observations.length,
    },
  });
}
/** Read-only prerequisite before a saved-profile app is spawned; never acquire/recover the old lock. */
export async function verifyDesktopNativeQuitReadbackSource(
  root: string,
  saved: Record<string, unknown>
): Promise<void> {
  assert.equal(await realpath(root), root);
  assert.match(basename(root), /^TEST-desktop-backend-[A-Za-z0-9]+$/);
  assert.equal(saved.mode, 'native-quit-ui');
  assert.equal(saved.status, 'PASS');
  const proof = record(saved.nativeQuitUiProof);
  assert.equal(proof.status, 'PASS');
  const cleanup = record(saved.cleanup);
  assert.deepEqual(cleanup.remaining, []);
  assert.equal(cleanup.appExitCode, 0);
  assert.equal(cleanup.capturedHostAbsent, true);
  const group = Number(record(saved.app).processGroup);
  assert.ok(Number.isSafeInteger(group) && group > 0);
  assert.equal(
    processTable().some((row) => row.pgid === group),
    false,
    'original captured app group absent before reopen'
  );
  assert.equal(await absent(join(root, 'hoststore/.legacy-agent-host-writer.lock')), true);
  const after = record(proof.afterQuit);
  assert.deepEqual(await originalSession(root), after.session);
  assert.deepEqual(await productSnapshot(root), after.product);
}
