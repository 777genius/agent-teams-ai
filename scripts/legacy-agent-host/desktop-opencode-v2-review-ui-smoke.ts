import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TaskChangeLedgerReader } from '@agent-teams/task-change-ledger';
import { digest } from '../../packages/legacy-agent-host/dist/team/identity.js';
import { fileDigest } from './desktop-backend-fixture.ts';
import { captureReadiness } from './desktop-launch-ui-smoke.ts';
import { readNativeReviewSeed } from './desktop-native-review-fixture.ts';
import { readDesktopNativeHostProcesses, readDesktopNativeStopSessions, separateDesktopOpenCodeRuntimeChildren } from './desktop-native-stop-fixture.ts';
import { createDesktopUiControls, desktopJsLiteral } from './desktop-ui-controls.ts';
import { createDesktopReviewHunkControls, readDesktopReviewDecisions } from './desktop-review-hunk-controls.ts';
import { V2_REVIEW_BOOTSTRAP, V2_REVIEW_SUBJECT, V2_REVIEW_TOOL_PREFIX } from './desktop-opencode-v2-review-model.ts';
import type { startOpenCodeV2ReviewModel } from './desktop-opencode-v2-review-model.ts';
import type { prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';

type Row = Record<string, unknown>;
const record = (value: unknown): Row => { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Row; };
const json = async (path: string) => record(JSON.parse(await readFile(path, 'utf8')));
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
async function rows(path: string): Promise<Row[]> {
  try { return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => record(JSON.parse(line))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
async function files(path: string): Promise<Row[]> {
  const names = (await readdir(path)).filter(name => /^[A-Za-z0-9_-]+\.json$/.test(name));
  assert.ok(names.length <= 128); return Promise.all(names.map(name => json(join(path, name))));
}

/** Original UI + native V2 edits + existing Host journal and Review writer; no synthetic events. */
export async function runDesktopOpenCodeV2ReviewUiSmoke(cdp: UiCdpPort, options: {
  fixture: Awaited<ReturnType<typeof prepareDesktopBackendFixture>>;
  model: Awaited<ReturnType<typeof startOpenCodeV2ReviewModel>>;
  evidence: Row;
  group: number;
  observeOwnedHost(): void;
  assertOwnedRenderer(): void;
}) {
  const { fixture, model } = options; assert.ok(fixture.uiSeed);
  const seed = await readNativeReviewSeed(fixture.root);
  assert.equal(seed.partialCoverage, undefined, 'V2 does not claim Claude hook evidence');
  const steps: Row[] = [], step = (value: Row) => { steps.push(value); };
  const proof: Row = { status: 'INCOMPLETE', provider: 'opencode-v2', version: '2.1.4', steps,
    scope: 'Original Launch and Task Start, exact native read/two edits, targeted Stop, Changes Keep/Reject/Undo/Redo/history and renderer reload',
    seedSha256: await fileDigest(join(fixture.root, 'native-review-ui-seed.json')),
    sourceSha256: await fileDigest(import.meta.filename),
    modelSourceSha256: await fileDigest(join(import.meta.dirname, 'desktop-opencode-v2-review-model.ts')),
    intervalCoverage: 'partial; only the exact native edit byte chain is qualified' };
  options.evidence.nativeReviewUiProof = proof;
  const ui = createDesktopUiControls(cdp, { assertOwnedRenderer: options.assertOwnedRenderer, step });
  const poll = async <T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string, ms = 60_000): Promise<T> => {
    const end = Date.now() + ms; let value = await read();
    while (!accept(value) && Date.now() < end) {
      assert.deepEqual(model.failures, []); await new Promise<void>(done => setTimeout(done, 100)); value = await read();
    }
    assert.ok(accept(value), label); return value;
  };
  const team = join(fixture.root, 'hoststore/teams/test-desktop-backend');
  const owner = () => json(join(team, '.host-owner/state.json'));
  await ui.observeInput(); await ui.clickSidebar(fixture.uiSeed.subject);
  await ui.click('button', 'original saved V2 Team Launch', 'Launch'); options.observeOwnedHost();
  const optional = record(await ui.waitRead(`(() => {
    const buttons=[...document.querySelectorAll('[role="dialog"] button[aria-controls]')].filter(node=>node.textContent.includes('Optional launch settings'));
    return buttons.length===1?{id:buttons[0].getAttribute('aria-controls'),expanded:buttons[0].getAttribute('aria-expanded')}:null;
  })()`, 'original optional launch settings'));
  if (optional.expanded !== 'true') {
    const selector = `[role="dialog"] button[aria-controls=${desktopJsLiteral(optional.id)}]`;
    await ui.scrollTo(selector, 'original optional launch settings');
    await ui.click(selector, 'expand original optional launch settings');
  }
  await ui.waitRead(`document.querySelector('[role="dialog"] #dialog-prompt')?.value===''&&!document.querySelector('[role="dialog"] #dialog-prompt')?.disabled`,
    'original saved prompt hydration');
  // The original button includes a brand monogram in textContent. Its accessible
  // name carries the exact provider/model label without that decorative text.
  await ui.waitRead(`Boolean(document.querySelector('[role="dialog"] button[aria-label="OpenCode provider, TEST-model"]'))`,
    'exact captured V2 model displayed');
  await ui.scrollTo('[role="dialog"] #dialog-prompt', 'original V2 review prompt');
  await ui.click('[role="dialog"] #dialog-prompt', 'focus original V2 review bootstrap');
  await cdp.send('Input.insertText', { text: V2_REVIEW_BOOTSTRAP });
  await ui.waitRead(`document.querySelector('[role="dialog"] #dialog-prompt')?.value===${desktopJsLiteral(V2_REVIEW_BOOTSTRAP)}`,
    'one deliberate original bootstrap');
  await ui.waitRead(`[...document.querySelectorAll('[role="dialog"] button')].some(node=>node.textContent.trim()==='Launch team'&&!node.disabled)`,
    'original captured V2 readiness permits Launch', 120_000);
  assert.ok(model.probes.length > 0 && model.probes.every(row => row.tools === 0));
  assert.equal(model.observations.length, 0, 'preflight never dispatches the business prompt');
  const metadata = readDesktopNativeHostProcesses(fixture, options.group); assert.equal(metadata.children.length, 1);
  await captureReadiness(cdp, fixture.handleId, proof, options.assertOwnedRenderer, 'before-original-submit');
  await ui.scrollTo('[role="dialog"] button', 'original V2 Launch team ready', 'Launch team');
  await ui.click('[role="dialog"] button', 'original V2 Launch team once', 'Launch team');
  await ui.waitRead(`!document.querySelector('[role="dialog"] #dialog-prompt')`, 'Launch dialog closes', 180_000);
  const initial = await poll(owner, state => Array.isArray(state.runtimeCaptures) && state.runtimeCaptures.length === 1, 'one original runtime capture');
  const capture = record((initial.runtimeCaptures as unknown[])[0]);
  assert.equal(record(initial.savedSettings).model, 'TEST-local/TEST-model');
  assert.equal(record(initial.savedSettings).skipPermissions, true);
  const taskId = await poll(async () => model.taskId(), id => id.length > 0, 'actual native MCP Task');
  assert.match(taskId, /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/, 'canonical Host task UUID');
  const sessions = () => readDesktopNativeStopSessions(fixture.root).then(values => values.filter(row => record(row.binding).runId === capture.launchId));
  const boot = await poll(sessions, values => values.length === 1 && (values[0]!.inputs as unknown[]).map(record).some(input => input.phase === 'terminal'), 'bootstrap terminal');
  const originalRuntimeInput = (boot[0]!.inputs as unknown[]).map(record)[0]!;
  assert.equal(originalRuntimeInput.terminal, 'succeeded');
  const eventPath = join(team, '.host-evidence/.board-task-changes/events', taskId + '.jsonl');
  assert.deepEqual(await rows(eventPath), []); assert.equal(await readFile(seed.filePath, 'utf8'), seed.before);
  const selector = `.kanban-task-card[data-task-id="${taskId}"]`;
  await ui.scrollTo(selector, 'actual native Task card');
  const point = record(await ui.waitRead(`(() => {const e=document.querySelector(${desktopJsLiteral(selector)});if(!e)return null;const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null;})()`, 'native Task geometry'));
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await ui.click('.kanban-task-card-toolbar button[aria-label="Start"]', 'original user Task Start once');
  await poll(async () => model.observations, values => values.some(row => row.turn === 'work' && row.step === 3), 'actual two native edits and terminal response', 180_000);
  const starts = (await files(join(team, '.host-owner/commands'))).filter(row => row.principalId === 'TEST-human' &&
    record(row.command).operation === 'task.start' && record(record(row.command).payload).taskId === taskId);
  assert.equal(starts.length, 1); const start = starts[0]!; assert.equal(start.phase, 'completed');
  assert.equal(record(record(start.command).payload).notification, 'user');
  const outboxes = (await files(join(team, '.host-owner/outbox'))).filter(row => row.commandId === start.commandId && row.messageId === record(start.effects).messageId);
  assert.equal(outboxes.length, 1); const outbox = outboxes[0]!; assert.equal(outbox.inputId, outbox.deliveryId);
  const completed = await poll(sessions, values => values.length === 1 && (values[0]!.inputs as unknown[]).map(record)
    .some(input => record(input.intent).inputId === outbox.inputId && input.phase === 'terminal'), 'Task Start durable terminal');
  const runtime = completed[0]!, input = (runtime.inputs as unknown[]).map(record).find(row => record(row.intent).inputId === outbox.inputId)!;
  assert.equal(input.terminal, 'succeeded'); assert.equal(await readFile(seed.filePath, 'utf8'), seed.after);
  const events = await rows(eventPath); assert.equal(events.length, 1, 'one exact native input byte chain');
  const event = events[0]!, cause = record(event.causalBinding), native = record(event.nativeCaptureProof);
  assert.equal(event.filePath, seed.filePath); assert.equal(event.toolStatus, 'succeeded');
  assert.equal(event.toolUseId, V2_REVIEW_TOOL_PREFIX + '2');
  for (const [key, expected] of Object.entries({ taskId, taskStartCommandId: start.commandId,
    inputId: outbox.inputId, operationRef: input.operationRef, sessionRef: runtime.sessionRef, hostIncarnation: runtime.hostIncarnation })) assert.equal(cause[key], expected);
  assert.deepEqual(cause.binding, runtime.binding); assert.equal(event.evidenceProof, digest(cause));
  assert.equal(record(cause.provenance).reviewableComplete, false);
  assert.equal(native.kind, 'opencode-update-patch-v2'); assert.equal(native.protocolRevision, '2.1.4');
  assert.equal(native.beforeSha256, sha(seed.before)); assert.equal(native.afterSha256, sha(seed.after));
  assert.ok(Array.isArray(native.tools) && native.tools.length === 2);
  assert.deepEqual(native.tools.map(record).map(tool => tool.callId), [V2_REVIEW_TOOL_PREFIX + '1', V2_REVIEW_TOOL_PREFIX + '2']);
  for (const [side, expected] of [['before', seed.before], ['after', seed.after]] as const) {
    const ref = record(event[side]); assert.equal(ref.sha256, sha(expected));
    assert.equal(await readFile(join(team, '.host-evidence/.board-task-changes/blobs', String(ref.blobRef)), 'utf8'), expected);
  }
  const changes = await new TaskChangeLedgerReader().readTaskChanges({ teamName: 'test-desktop-backend', taskId,
    projectDir: join(team, '.host-evidence'), projectPath: join(fixture.root, 'workspace'), includeDetails: true });
  assert.ok(changes && changes.warnings.length > 0);
  const changed = changes.files.find(row => row.filePath === seed.filePath); assert.ok(changed && changed.snippets.length > 0);
  assert.ok(changed.snippets.every(snippet => snippet.ledger?.nativeCapture === 'qualified'));
  const children = separateDesktopOpenCodeRuntimeChildren(metadata, readDesktopNativeHostProcesses(fixture, options.group), 1);
  await ui.scrollTo('button[aria-label="Stop"]', 'original targeted Stop before Review');
  await ui.click('button[aria-label="Stop"]', 'original V2 Stop once', 'Stop');
  const stopped = await poll(sessions, values => values.length === 1 && values[0]!.phase === 'closed' && values[0]!.custody === 'released', 'original native Runtime released');
  await poll(async () => readDesktopNativeHostProcesses(fixture, options.group), state => !state.children.some(row => row.pid === children[0]!.pid), 'original runtime physically absent');
  separateDesktopOpenCodeRuntimeChildren(metadata, readDesktopNativeHostProcesses(fixture, options.group), 0);
  Object.assign(proof, { taskId, capture, runtime: stopped[0], originalRuntimeInput, events,
    stop: { children, metadata: metadata.children[0], releasedBeforeReview: true } });
  const review = createDesktopReviewHunkControls(cdp, { taskId, subject: V2_REVIEW_SUBJECT,
    fileLabel: 'native-review.ts', assertOwnedRenderer: options.assertOwnedRenderer, step });
  await review.openChanges(); await review.hoverLine('const first = 2;');
  await ui.click('[data-review-floating-toolbar="true"] button[title^="Accept change"]', 'Keep first actual V2 hunk');
  await review.waitHistory(1, 0); await review.hoverLine('const last = 2;');
  await ui.click('[data-review-floating-toolbar="true"] button[title^="Reject change"]', 'Reject second actual V2 hunk');
  await review.waitHistory(2, 0); assert.equal(await readFile(seed.filePath, 'utf8'), seed.mixed);
  await ui.click('button', 'Undo original V2 hunk rejection', 'Undo'); await review.waitHistory(1, 1);
  assert.equal(await readFile(seed.filePath, 'utf8'), seed.after);
  await ui.click('button', 'Redo original V2 hunk rejection', 'Redo'); await review.waitHistory(2, 0);
  assert.equal(await readFile(seed.filePath, 'utf8'), seed.mixed);
  await ui.click(review.historySelector, 'open original V2 Review History');
  await ui.waitRead(`/undo stack/i.test(document.body.innerText)`, 'original V2 History visible');
  const image = record(await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }));
  const imagePath = join(fixture.root, 'ui-native-v2-review-history.png');
  await writeFile(imagePath, Buffer.from(String(image.data), 'base64'), { mode: 0o600, flag: 'wx' });
  proof.screenshot = { path: imagePath, sha256: await fileDigest(imagePath) };
  await ui.click('button[aria-label="Close review history"]', 'close original V2 History');
  await ui.click('button[aria-label="Close Changes"]', 'close and flush V2 Review');
  await ui.waitRead(`!document.querySelector('button[aria-label="Close Changes"]')`, 'Changes closed');
  const timeOrigin = await cdp.evaluate('performance.timeOrigin'); await cdp.send('Page.reload', { ignoreCache: false });
  await ui.waitRead(`performance.timeOrigin!==${desktopJsLiteral(timeOrigin)}&&Boolean(window.electronAPI)&&!document.getElementById('splash')`, 'new renderer document');
  await ui.observeInput(); await review.openChanges(); await review.waitHistory(2, 0);
  assert.equal(await readFile(seed.filePath, 'utf8'), seed.mixed); assert.deepEqual(await rows(eventPath), events);
  assert.equal(await fileDigest(join(fixture.root, 'workspace/.git/index')), seed.gitIndexSha256);
  assert.equal(await readFile(join(fixture.root, 'workspace/pre-existing-untracked.txt'), 'utf8'), 'TEST unrelated dirty file\n');
  assert.deepEqual(model.failures, []); assert.equal(model.observations.length, 6, 'two original inputs, no tool replay');
  await ui.click('button[aria-label="Close Changes"]', 'close reloaded V2 Changes');
  await ui.waitRead(`!document.querySelector('button[aria-label="Close Changes"]')`, 'reloaded Changes closed');
  Object.assign(proof, { persistence: await readDesktopReviewDecisions(fixture.root), fileSha256: await fileDigest(seed.filePath),
    originalEventsUnchanged: true, nativeModelObservations: model.observations, status: 'PASS' });
}
