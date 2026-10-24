import assert from 'node:assert/strict';
import { TaskChangeLedgerReader } from '@agent-teams/task-change-ledger';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { digest } from '../../packages/legacy-agent-host/dist/team/identity.js';
import { fileDigest } from './desktop-backend-fixture.ts';
import { command, processTable } from './desktop-backend-observations.ts';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';
import { readNativeReviewSeed } from './desktop-native-review-fixture.ts';
import {
  REVIEW_BOOTSTRAP,
  REVIEW_REPLY,
  REVIEW_TASK_SUBJECT,
  REVIEW_WORK_TERMINAL_STEP,
} from './desktop-native-review-model.ts';
import {
  createDesktopReviewHunkControls,
  readDesktopReviewDecisions,
} from './desktop-review-hunk-controls.ts';
import { createDesktopUiControls } from './desktop-ui-controls.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';
import type { prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import type { startNativeTeamModel } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts';
type Row = Record<string, unknown>;
const record = (value: unknown): Row => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Row;
};
const json = async (path: string) => record(JSON.parse(await readFile(path, 'utf8')));
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
async function rows(path: string): Promise<Row[]> {
  try {
    return (await readFile(path, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => record(JSON.parse(line)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
async function files(path: string): Promise<Row[]> {
  const names = (await readdir(path)).filter((name) => /^[A-Za-z0-9_-]+\.json$/.test(name));
  assert.ok(names.length <= 128);
  return Promise.all(names.map((name) => json(join(path, name))));
}
function modelTask(model: Awaited<ReturnType<typeof startNativeTeamModel>>): string {
  assert.ok(
    'taskId' in model && typeof model.taskId === 'function',
    'dedicated native review oracle'
  );
  const taskId: unknown = model.taskId();
  assert.ok(typeof taskId === 'string');
  return taskId;
}

/** Actual native tools publish the journal; the harness never writes Tasks or ledger events. */
export async function runDesktopNativeReviewUiSmoke(
  cdp: UiCdpPort,
  options: {
    fixture: Awaited<ReturnType<typeof prepareDesktopBackendFixture>>;
    model: Awaited<ReturnType<typeof startNativeTeamModel>>;
    evidence: Row;
    group: number;
    observeOwnedHost(): void;
    assertOwnedRenderer(): void;
  }
): Promise<void> {
  const { fixture, model } = options;
  assert.ok(fixture.uiSeed);
  const seed = await readNativeReviewSeed(fixture.root);
  const partial = seed.partialCoverage; assert.ok(partial, 'fresh extended native review seed');
  const steps: Row[] = [],
    step = (value: Row) => {
      steps.push({ monotonicMs: Math.round(performance.now()), ...value });
    };
  const proof: Row = {
    status: 'INCOMPLETE',
    steps,
    scope:
      'Original Launch, native MCP Task creation, original user Task Start, actual sequential foreground Edit capture, Stop, original Changes Keep/Reject/Undo/Redo/history and renderer reload',
    qualification:
      'Two exact foreground Edit transforms; failed/relevant-hook/background bytes and outcomes stay partial or explicit gaps, never qualified authorship',
    excluded: [
      'all tools/profiles',
      'failed/background/post-hook file authorship or global interval completeness',
      'vendor model authentication/inference',
      'full M13/M16',
      'Stage2',
    ],
    seedSha256: await fileDigest(join(fixture.root, 'native-review-ui-seed.json')),
    sourceSha256: await fileDigest(import.meta.filename),
    modelSourceSha256: await fileDigest(
      join(import.meta.dirname, 'desktop-native-review-model.ts')
    ),
  };
  options.evidence.nativeReviewUiProof = proof;
  const ui = createDesktopUiControls(cdp, {
    assertOwnedRenderer: options.assertOwnedRenderer,
    step,
  });
  const poll = async <T>(
    read: () => Promise<T>,
    accept: (value: T) => boolean,
    label: string,
    ms = 60000
  ): Promise<T> => {
    const end = Date.now() + ms;
    let value = await read();
    while (!accept(value) && Date.now() < end) {
      assert.deepEqual(model.failures, []);
      await new Promise<void>((done) => setTimeout(done, 100));
      value = await read();
    }
    assert.ok(accept(value), label);
    return value;
  };
  const team = join(fixture.root, 'hoststore/teams/test-desktop-backend');
  const owner = () => json(join(team, '.host-owner/state.json'));
  await ui.observeInput();
  await ui.clickSidebar(fixture.uiSeed.subject);
  await ui.click('button', 'original saved Team Launch', 'Launch');
  options.observeOwnedHost();
  const optional = record(
    await ui.waitRead(
      `(() => {
    const rows=[...document.querySelectorAll('[role="dialog"] button[aria-controls]')].filter(e=>e.textContent.includes('Optional launch settings'));
    return rows.length===1?{id:rows[0].getAttribute('aria-controls'),expanded:rows[0].getAttribute('aria-expanded')}:null;
  })()`,
      'original optional launch settings'
    )
  );
  if (optional.expanded !== 'true') {
    const selector = `[role="dialog"] button[aria-controls=${JSON.stringify(optional.id)}]`;
    await ui.scrollTo(selector, 'visible optional launch settings');
    await ui.click(selector, 'expand original launch settings');
  }
  const savedSummary = await ui.waitRead(
    `(() => {
    const node=document.querySelector(${JSON.stringify(`[role="dialog"] button[aria-controls=${JSON.stringify(optional.id)}]`)});
    const key=node&&Object.keys(node).find(key=>key.startsWith('__reactFiber$'));let fiber=key?node[key]:null;
    for(let depth=0;fiber&&depth<64;depth++,fiber=fiber.return){
      if(fiber.type?.name!=='OptionalSettingsSection')continue;
      let root=fiber;for(let step=0;root.return&&step<128;step++)root=root.return;
      if(root.return||!root.stateNode?.current)return null;
      const current=root.stateNode.current===root?fiber:fiber.alternate;
      const summary=current?.memoizedProps.summary;
      return Array.isArray(summary)&&['Model: claude-sonnet-4-6','Effort: low','Fast disabled','Anthropic limited to 200K context'].every(value=>summary.includes(value))?summary:null;
    }return null;
  })()`,
    'saved Sonnet4.6/low/off/context choices hydrate before typing',
    60000
  );
  await ui.waitRead(
    `[...document.querySelectorAll('[role="dialog"] button[aria-label*=" provider,"]')].some(node=>node.textContent.trim()==='Sonnet 4.6')`,
    'saved Sonnet label before typing'
  );
  if (!(await cdp.evaluate(`Boolean(document.querySelector('[role="dialog"] #lead-effort'))`))) {
    await ui.scrollTo(
      '[role="dialog"] button[aria-label*=" provider,"]',
      'original saved model row'
    );
    await ui.click(
      '[role="dialog"] button[aria-label*=" provider,"]',
      'expand saved model row without changing choices'
    );
  }
  await ui.waitRead(
    `document.querySelector('[role="dialog"] #lead-effort')?.textContent.trim()==='Low'&&document.querySelector('[role="dialog"] #lead-limit-context')?.getAttribute('data-state')==='checked'`,
    'saved Low effort and context limit displayed'
  );
  await ui.waitRead(
    `(() => {const input=document.querySelector('[role="dialog"] #dialog-prompt');return input?.value===''&&!input.matches(':disabled');})()`,
    'saved empty prompt becomes editable after hydration'
  );
  proof.savedChoicesBeforeTyping = savedSummary;
  await ui.scrollTo('[role="dialog"] #dialog-prompt', 'original bootstrap prompt');
  await ui.click('[role="dialog"] #dialog-prompt', 'focus original prompt');
  await cdp.send('Input.insertText', { text: REVIEW_BOOTSTRAP });
  await ui.waitRead(
    `document.querySelector('[role="dialog"] #dialog-prompt')?.value===${JSON.stringify(REVIEW_BOOTSTRAP)}`,
    'deliberate generic bootstrap retained'
  );
  await ui.scrollTo('[role="dialog"] button', 'original Launch team ready', 'Launch team');
  await ui.click('[role="dialog"] button', 'original Launch once', 'Launch team');
  await ui.waitRead(
    `!document.querySelector('[role="dialog"] #dialog-prompt')`,
    'Launch dialog closes',
    60000
  );
  const initial = await poll(
    owner,
    (value) => Array.isArray(value.runtimeCaptures) && value.runtimeCaptures.length === 1,
    'one actual fresh capture'
  );
  const capture = record((initial.runtimeCaptures as unknown[])[0]);
  for (const [key, value] of Object.entries({
    model: 'claude-sonnet-4-6',
    effort: 'low',
    fastMode: 'off',
    limitContext: true,
  }))
    assert.equal(record(initial.savedSettings)[key], value);
  const taskId = await poll(
    async () => modelTask(model),
    (id) => id.length > 0,
    'actual native MCP Task id'
  );
  const sessions = () =>
    readDesktopNativeStopSessions(fixture.root).then((values) =>
      values.filter((value) => record(value.binding).runId === capture.launchId)
    );
  await poll(
    sessions,
    (values) =>
      values.length === 1 &&
      (values[0]!.inputs as unknown[]).map(record).some((input) => input.phase === 'terminal'),
    'generic bootstrap terminal'
  );
  const eventPath = join(team, '.host-evidence/.board-task-changes/events', taskId + '.jsonl');
  assert.deepEqual(
    await rows(eventPath),
    [],
    'generic bootstrap does not fabricate Task effect evidence'
  );
  assert.equal(await readFile(seed.filePath, 'utf8'), seed.before);
  await ui.waitRead(
    `Boolean(document.querySelector('.kanban-task-card[data-task-id="${taskId}"]'))`,
    'native Task in original Kanban'
  );
  const taskSelector = `.kanban-task-card[data-task-id="${taskId}"]`;
  await ui.scrollTo(taskSelector, 'native Task card before original Start');
  const taskPoint = record(
    await ui.waitRead(
      `(() => {
    const e=document.querySelector(${JSON.stringify(taskSelector)});if(!e)return null;
    const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null;
  })()`,
      'native Task card geometry'
    )
  );
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    ...taskPoint,
  });
  const startSelector = '.kanban-task-card-toolbar button[aria-label="Start"]';
  await ui.click(startSelector, 'original user Task Start once');
  await poll(
    async () => model.observations,
    (values) => values.some((value) => value.turn === 'work' && value.step === REVIEW_WORK_TERMINAL_STEP),
    'actual native Task work terminal response'
  );
  const startReceipts = (await files(join(team, '.host-owner/commands'))).filter((row) => {
    const request = record(row.command);
    return (
      row.principalId === 'TEST-human' &&
      request.operation === 'task.start' &&
      record(request.payload).taskId === taskId
    );
  });
  assert.equal(startReceipts.length, 1);
  const start = startReceipts[0]!;
  assert.equal(start.phase, 'completed');
  assert.equal(record(record(start.command).payload).notification, 'user');
  const outboxes = (await files(join(team, '.host-owner/outbox'))).filter(
    (row) => row.commandId === start.commandId && row.messageId === record(start.effects).messageId
  );
  assert.equal(outboxes.length, 1);
  const outbox = outboxes[0]!;
  assert.equal(outbox.inputId, outbox.deliveryId);
  const completed = await poll(
    sessions,
    (values) =>
      values.length === 1 &&
      (values[0]!.inputs as unknown[])
        .map(record)
        .some(
          (input) => record(input.intent).inputId === outbox.inputId && input.phase === 'terminal'
        ),
    'original Task Start input terminal'
  );
  const runtime = completed[0]!;
  const input = (runtime.inputs as unknown[])
    .map(record)
    .find((value) => record(value.intent).inputId === outbox.inputId)!;
  assert.equal(input.terminal, 'succeeded');
  const inbox: unknown = JSON.parse(await readFile(join(team, 'inboxes/user.json'), 'utf8'));
  assert.ok(Array.isArray(inbox));
  const replies = inbox.map(record).filter((row) => row.text === REVIEW_REPLY);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]!.from, 'alice');
  proof.nativeReply = replies[0];
  const noticePath = join(team, '.host-evidence/.board-task-changes/notices', taskId + '.jsonl');
  const backgroundId = 'native_review_work_5';
  const notices = await poll(async () => ({ rows: await rows(noticePath),
    backgroundBytes: await readFile(partial.backgroundPath, 'utf8') }), value =>
    value.backgroundBytes === partial.backgroundAfter && value.rows.some(row => row.toolUseId === backgroundId &&
      (row.captureBoundary === 'native-task-notification' || String(row.message).startsWith('Native capture gap:'))),
    'original finite background bytes plus native completion observation or explicit unsupported gap');
  const events = await rows(eventPath);
  const qualifiedHunks = events.filter(row => row.filePath === seed.filePath);
  assert.equal(
    qualifiedHunks.length,
    2,
    'exactly two actual qualified Edit events, no synthetic journal rows'
  );
  for (const [index, event] of qualifiedHunks.entries()) {
    const cause = record(event.causalBinding),
      native = record(event.nativeCaptureProof);
    assert.equal(event.filePath, seed.filePath);
    assert.equal(event.toolUseId, `native_review_work_${index + 1}`);
    assert.equal(event.toolStatus, 'succeeded');
    assert.equal(event.executionSeq, 0);
    assert.equal(cause.taskId, taskId);
    assert.equal(cause.taskStartCommandId, start.commandId);
    assert.equal(cause.inputId, outbox.inputId);
    assert.equal(cause.operationRef, input.operationRef);
    assert.equal(cause.sessionRef, runtime.sessionRef);
    assert.equal(cause.hostIncarnation, runtime.hostIncarnation);
    assert.equal(event.evidenceProof, digest(cause));
    assert.deepEqual(cause.binding, runtime.binding);
    assert.equal(record(cause.provenance).reviewableComplete, false);
    assert.equal(native.kind, 'edit-input-v1');
    const before = index === 0 ? seed.before : seed.intermediate,
      after = index === 0 ? seed.intermediate : seed.after;
    assert.equal(native.beforeSha256, sha(before));
    assert.equal(native.afterSha256, sha(after));
    const toolInput = {
      file_path: seed.filePath,
      old_string: index === 0 ? 'const first = 1;' : 'const last = 1;',
      new_string: index === 0 ? 'const first = 2;' : 'const last = 2;',
      replace_all: false,
    };
    assert.equal(native.toolInputDigest, digest({ toolName: 'Edit', input: toolInput }));
    for (const [side, bytes] of [
      ['before', before],
      ['after', after],
    ] as const) {
      const ref = record(event[side]);
      assert.equal(ref.sha256, sha(bytes));
      assert.equal(
        await readFile(
          join(team, '.host-evidence/.board-task-changes/blobs', String(ref.blobRef)),
          'utf8'
        ),
        bytes
      );
    }
  }
  const content = async (event: Row, side: 'before' | 'after') => {
    const reference = event[side];
    if (reference === null) return null;
    const ref = record(reference), bytes = await readFile(join(team, '.host-evidence/.board-task-changes/blobs', String(ref.blobRef)));
    assert.equal(sha(bytes.toString('utf8')), ref.sha256); return bytes.toString('utf8');
  };
  const checkPartial = async (path: string, tool: string, status: string, before: string | null, after: string) => {
    const selected = events.filter(row => row.filePath === path && row.toolUseId === tool);
    assert.equal(selected.length, 1, 'one actual partial row for original tool/path');
    const event = selected[0]!, cause = record(event.causalBinding);
    assert.equal(event.toolStatus, status); assert.equal(event.nativeCaptureProof, undefined);
    assert.equal(event.executionSeq, 0); assert.equal(record(cause.provenance).reviewableComplete, false);
    assert.equal(cause.taskId, taskId); assert.equal(cause.taskStartCommandId, start.commandId);
    assert.equal(cause.inputId, outbox.inputId); assert.equal(cause.operationRef, input.operationRef);
    assert.deepEqual(cause.binding, runtime.binding); assert.equal(event.evidenceProof, digest(cause));
    assert.equal(await content(event, 'before'), before); assert.equal(await content(event, 'after'), after);
    assert.equal(await readFile(path, 'utf8'), after); return event;
  };
  const failed = await checkPartial(partial.failedPath, 'native_review_work_3', 'failed', partial.failedBefore, partial.failedAfter);
  const write = await checkPartial(partial.writePath, 'native_review_work_4', 'succeeded', null, 'WRITE\nHOOK_LATE\n');
  const hook = await checkPartial(partial.hookSidePath, 'native_review_work_4', 'succeeded', partial.hookBefore, partial.hookAfter);
  const hookFacts = await rows(partial.hookLog);
  assert.deepEqual(hookFacts.map(row => [row.phase, row.toolUseId]), [['started', 'native_review_work_4'], ['finished', 'native_review_work_4']]);
  const backgroundRows = events.filter(row => row.toolUseId === backgroundId);
  assert.ok(backgroundRows.length <= 1, 'background completion never invents duplicate capture');
  if (backgroundRows.length) await checkPartial(partial.backgroundPath, backgroundId, 'succeeded', partial.backgroundBefore, partial.backgroundAfter);
  else assert.ok(notices.rows.some(row => row.toolUseId === backgroundId && String(row.message).startsWith('Native capture gap:')));
  const allowed = new Set([seed.filePath, partial.failedPath, partial.writePath, partial.hookSidePath, partial.backgroundPath]);
  assert.ok(events.every(row => allowed.has(String(row.filePath))), 'no unplanned native file effects');
  const changes = await new TaskChangeLedgerReader().readTaskChanges({ teamName: 'test-desktop-backend', taskId,
    projectDir: join(team, '.host-evidence'), projectPath: join(fixture.root, 'workspace'), includeDetails: true });
  assert.ok(changes && changes.warnings.length > 0);
  for (const event of [failed, write, hook, ...backgroundRows]) {
    const file = changes.files.find(row => row.filePath === event.filePath); assert.ok(file);
    assert.ok(file.snippets.length > 0 && file.snippets.every(snippet => snippet.ledger?.nativeCapture === 'unqualified' &&
      snippet.ledger.originalFullContent === null && snippet.ledger.modifiedFullContent === null && !snippet.oldString && !snippet.newString),
      'portable Changes projection cannot promote partial rows to writable native content');
  }
  proof.partialCapture = { status: 'PARTIAL_OR_GAP', failed, write, hook, hookFacts, backgroundRows,
    backgroundNotices: notices.rows.filter(row => row.toolUseId === backgroundId),
    eventualOutcome: backgroundRows.length ? 'observed-native-completion' : 'unsupported-or-unconfirmed',
    backgroundFinalSha256: await fileDigest(partial.backgroundPath), warnings: changes.warnings,
    unsafePromotion: false, fullM13: false };
  assert.equal(await readFile(seed.filePath, 'utf8'), seed.after);
  proof.capture = capture;
  proof.taskId = taskId;
  proof.startReceipt = start;
  proof.taskStartOutbox = outbox;
  proof.runtime = runtime;
  proof.originalRuntimeInput = input;
  proof.events = events;
  const selected = processTable().filter(
    (row) =>
      row.pgid === options.group && command(row.pid) === `${fixture.node} ${fixture.hostEntry}`
  );
  assert.equal(selected.length, 1);
  const children = processTable().filter(
    (row) =>
      row.ppid === selected[0]!.pid &&
      command(row.pid).startsWith(process.env.LEGACY_DESKTOP_CLAUDE_PATH!)
  );
  assert.ok(children.length > 0);
  await ui.scrollTo('button[aria-label="Stop"]', 'original Stop before review');
  await ui.click('button[aria-label="Stop"]', 'original Stop once', 'Stop');
  await poll(
    sessions,
    (values) =>
      values.length === 1 && values[0]!.phase === 'closed' && values[0]!.custody === 'released',
    'closed released native Runtime'
  );
  await poll(
    async () => processTable(),
    (values) => children.every((child) => !values.some((row) => row.pid === child.pid)),
    'original native children physically absent'
  );
  proof.stop = { children, releasedBeforeReview: true };
  const review = createDesktopReviewHunkControls(cdp, {
    taskId,
    subject: REVIEW_TASK_SUBJECT,
    fileLabel: 'native-review.ts',
    assertOwnedRenderer: options.assertOwnedRenderer,
    step,
  });
  await review.openChanges();
  await ui.click('button', 'expand original capture warning details', 'Read more');
  proof.captureWarningsVisible = await ui.waitRead(`document.body.innerText.includes('Native capture interval is partial')`,
    'existing Changes shows original conservative native interval warning');
  await review.hoverLine('const first = 2;');
  await ui.click(
    '[data-review-floating-toolbar="true"] button[title^="Accept change"]',
    'Keep first actual native hunk once'
  );
  await review.waitHistory(1, 0);
  await review.hoverLine('const last = 2;');
  await ui.click(
    '[data-review-floating-toolbar="true"] button[title^="Reject change"]',
    'Reject second actual native hunk once'
  );
  await review.waitHistory(2, 0);
  assert.equal(await readFile(seed.filePath, 'utf8'), seed.mixed);
  await ui.click('button', 'Undo original native hunk rejection', 'Undo');
  await review.waitHistory(1, 1);
  assert.equal(await readFile(seed.filePath, 'utf8'), seed.after);
  await ui.click('button', 'Redo original native hunk rejection', 'Redo');
  await review.waitHistory(2, 0);
  assert.equal(await readFile(seed.filePath, 'utf8'), seed.mixed);
  await ui.click(review.historySelector, 'open original native review History');
  await ui.waitRead(`/undo stack/i.test(document.body.innerText)`, 'native review History visible');
  const image = record(
    await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
    })
  );
  const imagePath = join(fixture.root, 'ui-native-task-review-history.png');
  await writeFile(imagePath, Buffer.from(String(image.data), 'base64'), {
    mode: 0o600,
    flag: 'wx',
  });
  proof.screenshot = { path: imagePath, sha256: await fileDigest(imagePath) };
  await ui.click('button[aria-label="Close review history"]', 'close native review History');
  await ui.click('button[aria-label="Close Changes"]', 'close and flush actual native review');
  await ui.waitRead(
    `!document.querySelector('button[aria-label="Close Changes"]')`,
    'native Changes closed'
  );
  const timeOrigin = await cdp.evaluate('performance.timeOrigin');
  await cdp.send('Page.reload', { ignoreCache: false });
  await ui.waitRead(
    `performance.timeOrigin!==${JSON.stringify(timeOrigin)}&&Boolean(window.electronAPI)&&!document.getElementById('splash')`,
    'new native review renderer document'
  );
  await ui.observeInput();
  await review.openChanges();
  await review.waitHistory(2, 0);
  assert.equal(await readFile(seed.filePath, 'utf8'), seed.mixed);
  assert.deepEqual(
    await rows(eventPath),
    events,
    'renderer reload never replays native tools or rewrites their canonical journal'
  );
  assert.equal(await fileDigest(join(fixture.root, 'workspace/.git/index')), seed.gitIndexSha256);
  assert.equal(
    await readFile(join(fixture.root, 'workspace/pre-existing-untracked.txt'), 'utf8'),
    'TEST unrelated dirty file\n'
  );
  assert.deepEqual(model.failures, []);
  assert.ok(
    model.observations.every(
      (row) => row.requestedModel === 'claude-sonnet-4-6' && row.requestedEffort === 'low'
    )
  );
  assert.deepEqual(model.unexpectedNoToolsRequests, []);
  await ui.click(
    'button[aria-label="Close Changes"]',
    'close reloaded native Changes without mutation'
  );
  await ui.waitRead(
    `!document.querySelector('button[aria-label="Close Changes"]')`,
    'reloaded native Changes closed'
  );
  proof.persistence = await readDesktopReviewDecisions(fixture.root);
  assert.ok((proof.persistence as unknown[]).length > 0);
  proof.fileSha256 = await fileDigest(seed.filePath);
  proof.originalEventsUnchanged = true;
  proof.status = 'PASS';
}
