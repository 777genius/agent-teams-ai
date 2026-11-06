import assert from 'node:assert/strict';
import { test } from 'node:test';
import { digest } from '../../packages/legacy-agent-host/dist/team/identity.js';
import {
  assertNativeReviewContinuationSource,
  NATIVE_REVIEW_UNDO_FAILURE,
} from './desktop-native-review-continuation-source.ts';
import { assertNativeReviewRuntimeRecords } from './desktop-native-review-runtime.ts';
import { prepareDesktopProofMode } from './desktop-proof-mode.ts';
const source = () => {
  const binding = {
    backendId: 'TEST-owner',
    teamId: 'TEST-team',
    runId: 'TEST-capture',
    memberId: 'TEST-member',
    generation: 'TEST-generation',
  };
  const input = {
    phase: 'terminal',
    terminal: 'succeeded',
    operationRef: 'TEST-operation',
    intent: { inputId: 'TEST-input' },
  };
  const cause = {
    taskId: 'TEST-task',
    taskStartCommandId: 'TEST-start',
    inputId: 'TEST-input',
    operationRef: input.operationRef,
    sessionRef: 'TEST-session',
    binding,
  };
  return {
    mode: 'native-review-ui',
    status: 'INCOMPLETE',
    failure: NATIVE_REVIEW_UNDO_FAILURE,
    model: { failures: [], unexpectedNoToolsRequests: [] },
    cleanup: { remaining: [], capturedHostObserved: true, capturedHostAbsent: true },
    nativeReviewUiProof: {
      status: 'INCOMPLETE',
      taskId: 'TEST-task',
      capture: { launchId: 'TEST-capture' },
      stop: { releasedBeforeReview: true },
      startReceipt: {
        phase: 'completed',
        principalId: 'TEST-human',
        commandId: 'TEST-start',
        command: {
          operation: 'task.start',
          payload: { taskId: 'TEST-task', notification: 'user' },
        },
        effects: { messageId: 'TEST-message' },
      },
      taskStartOutbox: {
        commandId: 'TEST-start',
        messageId: 'TEST-message',
        inputId: 'TEST-input',
        deliveryId: 'TEST-input',
        phase: 'admitted',
      },
      originalRuntimeInput: input,
      runtime: {
        binding,
        sessionRef: 'TEST-session',
        inputs: [{ ...input, intent: { inputId: 'TEST-bootstrap' } }, input],
      },
      events: [1, 2].map((i) => ({
        taskId: 'TEST-task',
        taskRef: 'TEST-task',
        taskRefKind: 'canonical',
        toolStatus: 'succeeded',
        toolUseId: `TEST-edit-${i}`,
        causalBinding: cause,
        evidenceProof: digest(cause),
        nativeCaptureProof: { kind: 'edit-input-v1' },
      })),
    },
  };
};
test('continuation admits only the precise retained pre-Undo failure with original native input proof', () => {
  assert.equal(assertNativeReviewContinuationSource(source()).taskId, 'TEST-task');
  for (const mutate of [
    (row: ReturnType<typeof source>) => {
      row.status = 'PASS';
    },
    (row: ReturnType<typeof source>) => {
      row.failure = 'another UI timeout';
    },
    (row: ReturnType<typeof source>) => {
      row.cleanup.capturedHostAbsent = false;
    },
    (row: ReturnType<typeof source>) => {
      row.nativeReviewUiProof.stop.releasedBeforeReview = false;
    },
    (row: ReturnType<typeof source>) => {
      row.nativeReviewUiProof.startReceipt.command.payload.notification = 'legacy';
    },
    (row: ReturnType<typeof source>) => {
      row.nativeReviewUiProof.taskStartOutbox.inputId = 'unrelated';
    },
    (row: ReturnType<typeof source>) => {
      row.nativeReviewUiProof.runtime.inputs = [];
    },
    (row: ReturnType<typeof source>) => {
      row.nativeReviewUiProof.events.pop();
    },
    (row: ReturnType<typeof source>) => {
      row.nativeReviewUiProof.events[0]!.nativeCaptureProof.kind = 'unqualified';
    },
    (row: ReturnType<typeof source>) => {
      row.nativeReviewUiProof.events[0]!.evidenceProof = 'unbound';
    },
  ]) {
    const row = source();
    mutate(row);
    assert.throws(() => assertNativeReviewContinuationSource(row));
  }
});
test('continuation mode never allocates a model or fresh Launch fixture', async () => {
  const mode = await prepareDesktopProofMode('native-review-continuation-ui', () => {
    throw new Error('no native principal lookup');
  });
  assert.equal(mode.nativeReviewContinuationMode, true);
  assert.equal(mode.nativeReviewReadbackMode, true);
  assert.equal(mode.nativeReviewMode, true);
  assert.equal(mode.launchDialogMode, false);
  assert.equal(mode.model, undefined);
  assert.equal(mode.reviewUiMode, false);
});

test('cold native review admits only exact captured input history and unused exact profile binding', () => {
  const original = source().nativeReviewUiProof;
  const baseBinding = { ...original.runtime.binding, runId: 'TEST-base', generation: '1' };
  const profile = {
    teams: [{ members: [{ delivery: { ...baseBinding, teamName: 'TEST-label' } }] }],
  };
  const captured = { ...original.runtime, phase: 'closed', custody: 'released' };
  const unused = {
    binding: baseBinding,
    config: null,
    phase: 'closed',
    custody: 'released',
    inputs: [],
  };
  assert.doesNotThrow(() => assertNativeReviewRuntimeRecords([captured], original, profile));
  assert.doesNotThrow(() =>
    assertNativeReviewRuntimeRecords([unused, captured], original, profile)
  );
  for (const other of [
    { ...unused, binding: { ...baseBinding, generation: 'unrelated' } },
    { ...unused, custody: 'unknown' },
    { ...unused, inputs: [original.originalRuntimeInput] },
    { ...unused, config: {} },
    { ...unused, sessionRef: 'unexpected' },
  ])
    assert.throws(() => assertNativeReviewRuntimeRecords([captured, other], original, profile));
  assert.throws(() =>
    assertNativeReviewRuntimeRecords([{ ...captured, inputs: [] }], original, profile)
  );
  assert.throws(() =>
    assertNativeReviewRuntimeRecords([captured, unused, unused], original, profile)
  );
});

test('persistence comparison permits only exact native-derived context enrichment', async () => {
  const { assertNativeReviewPersistence } =
    await import('./desktop-native-review-continuation-persistence.ts');
  const { buildReviewChunkContextHashes } =
    await import('@agent-teams/task-change-ledger/review-text');
  const beforeText =
    'const first = 1;\n' + 'const middle = true;\n'.repeat(12) + 'const last = 1;\n';
  const native = {
    filePath: '/TEST/native-review.ts',
    before: beforeText,
    after: beforeText.replaceAll('= 1;', '= 2;'),
  };
  const key = `path:${native.filePath}`,
    hashes = buildReviewChunkContextHashes(native.before, native.after);
  const before = [
    {
      path: '/TEST/state.json',
      sha256: 'a'.repeat(64),
      value: {
        scopeKey: 'TEST-task',
        scopeToken: 'TEST-scope',
        hunkDecisions: { [`${key}:0`]: 'accepted', [`${key}:1`]: 'rejected' },
        reviewActionHistory: [{ id: 'original-1' }, { id: 'original-2' }],
        reviewRedoHistory: [],
        hunkContextHashesByFile: { [key]: {} },
        revision: 5,
        updatedAt: '2026-10-23T01:11:54.038Z',
      },
    },
  ];
  const after = [
    {
      ...before[0]!,
      sha256: 'b'.repeat(64),
      value: {
        ...before[0]!.value,
        hunkContextHashesByFile: { [key]: hashes },
        revision: 6,
        updatedAt: '2026-10-23T01:12:14.863Z',
      },
    },
  ];
  assert.deepEqual(assertNativeReviewPersistence(before, after, native), { contextEnriched: true });
  assert.deepEqual(assertNativeReviewPersistence(after, after, native), { contextEnriched: false });
  assert.deepEqual(assertNativeReviewPersistence(before, before, native), {
    contextEnriched: false,
  });
  const alias = structuredClone(before);
  alias[0]!.value.hunkContextHashesByFile[key] = { '00': hashes[0]! };
  assert.throws(() => assertNativeReviewPersistence(alias, alias, native));
  const rejects = (change: Record<string, unknown>) =>
    assert.throws(() =>
      assertNativeReviewPersistence(
        before,
        [{ ...after[0]!, value: { ...after[0]!.value, ...change } }],
        native
      )
    );
  rejects({ reviewActionHistory: [] });
  rejects({ reviewRedoHistory: [{ id: 'new' }] });
  rejects({ scopeToken: 'other' });
  rejects({ lastMutationId: 'new' });
  rejects({ revision: 7 });
  rejects({ updatedAt: '2026-10-22T00:00:00Z' });
  rejects({ hunkContextHashesByFile: { [key]: { ...hashes, 0: 'wrong' } } });
  rejects({ hunkContextHashesByFile: {} });
  rejects({ hunkDecisions: {} });
  assert.throws(() => assertNativeReviewPersistence(after, before, native));
  assert.throws(() => assertNativeReviewPersistence(before, [], native));
  const partialKeys = [
    'native-review-failed.txt',
    'native-review-failure-hook-side.txt',
    'native-review-hook-side.txt',
    'native-review-write.txt',
    'native-review-background.txt',
  ].map((name) => `path:/TEST/${name}`);
  const cache = { [key]: hashes, ...Object.fromEntries(partialKeys.map((path) => [path, {}])) };
  const recorded = [
    { ...after[0]!, value: { ...after[0]!.value, hunkContextHashesByFile: cache } },
  ];
  assert.deepEqual(assertNativeReviewPersistence(recorded, recorded, native), {
    contextEnriched: false,
  });
  const cacheRejects = (next: Record<string, unknown>) =>
    assert.throws(() =>
      assertNativeReviewPersistence(
        recorded,
        [{ ...recorded[0]!, value: { ...recorded[0]!.value, hunkContextHashesByFile: next } }],
        native
      )
    );
  cacheRejects({ ...cache, 'path:/TEST/unknown.txt': {} });
  const missingPartial = { ...cache };
  delete missingPartial[partialKeys[0]!];
  cacheRejects(missingPartial);
  cacheRejects({ ...cache, [partialKeys[0]!]: { 0: 'unsafe-derived-hash' } });
  const missingNative = { ...cache };
  delete missingNative[key];
  const missing = [
    { ...recorded[0]!, value: { ...recorded[0]!.value, hunkContextHashesByFile: missingNative } },
  ];
  assert.throws(() => assertNativeReviewPersistence(missing, missing, native));
  const promoted = [
    {
      ...recorded[0]!,
      value: {
        ...recorded[0]!.value,
        hunkContextHashesByFile: { ...cache, [partialKeys[0]!]: { 0: 'unsafe-existing-hash' } },
      },
    },
  ];
  assert.throws(() => assertNativeReviewPersistence(promoted, promoted, native));
});

test('pre-review continuation is separately admitted only for the hydrated native navigation failure', async () => {
  const { assertNativeReviewPreReviewSource, NATIVE_REVIEW_PRE_REVIEW_FAILURE } =
    await import('./desktop-native-review-continuation-source.ts');
  const native = source();
  const raw = {
    ...native,
    failure: NATIVE_REVIEW_PRE_REVIEW_FAILURE,
    model: {
      ...native.model,
      observations: [
        ['bootstrap', 0],
        ['bootstrap', 1],
        ['work', 0],
        ['work', 1],
        ['work', 2],
        ['work', 3],
        ['work', 4],
      ].map(([turn, step]) => ({
        turn,
        step,
        requestedModel: 'claude-sonnet-4-6',
        requestedEffort: 'low',
      })),
    },
    nativeReviewUiProof: {
      ...native.nativeReviewUiProof,
      savedChoicesBeforeTyping: [
        'Model: claude-sonnet-4-6',
        'Effort: low',
        'Fast disabled',
        'Anthropic limited to 200K context',
      ],
      steps: [{ label: 'open original Task detail' }],
    },
  };
  assert.equal(assertNativeReviewPreReviewSource(raw).taskId, 'TEST-task');
  assert.throws(() => assertNativeReviewContinuationSource(raw));
  assert.throws(() => assertNativeReviewPreReviewSource(native));
  const wrongModel = structuredClone(raw);
  wrongModel.model.observations[0]!.requestedModel = 'claude-opus-4-6';
  assert.throws(() => assertNativeReviewPreReviewSource(wrongModel));
  const partial = structuredClone(raw);
  partial.model.observations.pop();
  assert.throws(() => assertNativeReviewPreReviewSource(partial));
  const priorReview = structuredClone(raw);
  priorReview.nativeReviewUiProof.steps.push({ label: 'Keep first actual native hunk once' });
  assert.throws(() => assertNativeReviewPreReviewSource(priorReview));
  const wrongSaved = structuredClone(raw);
  wrongSaved.nativeReviewUiProof.savedChoicesBeforeTyping.pop();
  assert.throws(() => assertNativeReviewPreReviewSource(wrongSaved));
});

test('Task navigation hovers and remeasures a moving card before one click', async () => {
  const { clickStableDesktopReviewTask } = await import('./desktop-review-hunk-controls.ts');
  const events: Record<string, unknown>[] = [],
    steps: Record<string, unknown>[] = [];
  let hovered = false;
  await clickStableDesktopReviewTask(
    {
      evaluate: async (expression) =>
        expression.includes('scrollHeight')
          ? { visible: true }
          : {
              x: 686,
              y: hovered ? 538 : 486,
              width: 600,
              height: 100,
              taskId: 'TEST-task',
              hitTaskId: 'TEST-task',
            },
      send: async (method, params = {}) => {
        if (method === 'Input.dispatchMouseEvent') {
          events.push(params);
          if (params.type === 'mouseMoved') hovered = true;
        }
        return {};
      },
    },
    {
      taskId: 'TEST-task',
      assertOwnedRenderer: () => {},
      step: (row) => {
        steps.push(row);
      },
    }
  );
  assert.equal(events[0]!.y, 486);
  assert.deepEqual(
    events.filter((row) => row.type === 'mousePressed').map((row) => row.y),
    [538]
  );
  assert.deepEqual(
    events.filter((row) => row.type === 'mouseReleased').map((row) => row.y),
    [538]
  );
  assert.equal(steps[0]!.stableGeometrySamples, 3);
});

test('pre-review hydration snapshot admits only exact empty defaults in the qualified scope', async () => {
  const { assertNativeReviewEmptyPersistence } =
    await import('./desktop-native-review-continuation-source.ts');
  const scope = {
    taskId: 'TEST-task',
    scopeToken: 'task:TEST-task:TEST-context:provenance:ledger:TEST-digest',
    path: '/TEST/qualified-snapshot.json',
  };
  const value = {
    version: 6,
    scopeKey: 'task-TEST-task',
    scopeToken: scope.scopeToken,
    hunkDecisions: {},
    fileDecisions: {},
    hunkContextHashesByFile: {},
    reviewActionHistory: [],
    reviewRedoHistory: [],
    textBlobs: {},
    fileSummaryBlobs: {},
    revision: 1,
    updatedAt: '2026-10-23T01:44:34.874Z',
  };
  const snapshot = { path: scope.path, value };
  assert.doesNotThrow(() => assertNativeReviewEmptyPersistence(snapshot, scope));
  for (const change of [
    { revision: 2 },
    { scopeToken: 'another-context' },
    { scopeKey: 'task-another' },
    { hunkDecisions: { 'TEST:0': 'accepted' } },
    { reviewActionHistory: [{ id: 'unknown' }] },
    { reviewRedoHistory: [{ id: 'unknown' }] },
    { textBlobs: { unknown: 'data' } },
    { fileSummaryBlobs: { unknown: {} } },
    { lastMutationId: 'unknown' },
  ])
    assert.throws(() =>
      assertNativeReviewEmptyPersistence({ ...snapshot, value: { ...value, ...change } }, scope)
    );
  assert.throws(() =>
    assertNativeReviewEmptyPersistence({ ...snapshot, path: '/TEST/other.json' }, scope)
  );
});

test('pre-review admits only the completed exact initial empty-scope close command', async () => {
  const { assertNativeReviewInitialMetadataCommand } =
    await import('./desktop-native-review-continuation-source.ts');
  const scope = {
    taskId: 'TEST-task',
    scopeToken: 'TEST-exact-ledger-context',
    binding: { backendId: 'TEST-owner', teamId: 'TEST-team', teamName: 'test-desktop-backend' },
    updatedAt: '2026-10-23T01:44:34.874Z',
  };
  const requestDigest = digest({
    method: 'clearDecisions',
    args: ['test-desktop-backend', 'task-TEST-task', scope.scopeToken, 0],
  });
  const base = {
    family: 'review',
    binding: scope.binding,
    commandId: 'c87e2971-5b22-43d2-8047-683521e45a3c',
    principalId: 'TEST-human',
    origin: { taskId: scope.taskId },
    method: 'clearDecisions',
    requestDigest,
  };
  const response = { kind: 'review-writer', method: 'clearDecisions', result: { revision: 1 } };
  const command = {
    ...base,
    schemaVersion: 1,
    authorityRevision: 1,
    createdAt: '2026-10-23T01:44:34.788Z',
    phase: 'completed',
    fingerprint: digest(base),
    response,
    responseDigest: digest(response),
  };
  assert.doesNotThrow(() => assertNativeReviewInitialMetadataCommand(command, scope));
  for (const change of [
    { method: 'executeReviewMutation' },
    { phase: 'prepared' },
    { phase: 'held' },
    { commandId: 'another-command' },
    { origin: { taskId: 'another-task' } },
    { principalId: 'another-principal' },
    { authorityRevision: 2 },
    { createdAt: '2026-10-23T01:44:34.875Z' },
    { binding: { ...scope.binding, teamId: 'another-team' } },
    {
      requestDigest: digest({
        method: 'clearDecisions',
        args: ['test-desktop-backend', 'task-TEST-task', scope.scopeToken, 1],
      }),
    },
    { response: { ...response, result: { revision: 2 } } },
    { responseDigest: 'unverified' },
    { fingerprint: 'unverified' },
    { commitProof: { walId: 'unexpected' } },
  ])
    assert.throws(() => assertNativeReviewInitialMetadataCommand({ ...command, ...change }, scope));
  assert.throws(() =>
    assertNativeReviewInitialMetadataCommand(command, {
      ...scope,
      scopeToken: 'another-ledger-context',
    })
  );
});

test('History continuation admits only the exact finished four-action failure checkpoint', async () => {
  const { assertNativeReviewHistoryCheckpoint } =
    await import('./desktop-native-review-continuation-source.ts');
  const { createHash } = await import('node:crypto');
  const original = { ...source(), root: '/TEST/root', selectedSourceHashesBeforeApp: [] };
  const after = 'TEST-native-after';
  const checkpoint = {
    mode: 'native-review-continuation-ui',
    status: 'INCOMPLETE',
    root: original.root,
    failure: 'UI read timed out: continued original History visible; no mutation retry',
    selectedSourceHashesBeforeApp: [],
    selectedSourceHashesAfterFlow: [],
    cleanup: { remaining: [], capturedHostObserved: true, capturedHostAbsent: true },
    nativeReviewContinuationProof: {
      status: 'INCOMPLETE',
      stage: 'pre-review',
      taskId: 'TEST-task',
      originalReceiptSha256: '6758429e18597fc528b69b73a06ca66f2152843e5aedc700e634b221d20fe41f',
      sourceSha256: 'a0d23a754a5df7eee2f1dcfe007a9f799f2c5d859b92fb0c02d1b9cf41a19d2f',
      undoFileSha256: createHash('sha256').update(after).digest('hex'),
      sourceEpochs: [{ selectedSourcesDigest: digest([]) }, { selectedSourcesDigest: digest([]) }],
      steps: [
        'Keep first retained native hunk once',
        'Reject second retained native hunk once',
        'Undo original retained native hunk rejection once',
        'Redo original retained native hunk rejection once',
        'open continued original History',
      ].map((label) => ({ action: 'mouseClick', label, state: 'attempted' })),
    },
  };
  assert.doesNotThrow(() => assertNativeReviewHistoryCheckpoint(checkpoint, original, after));
  for (const mutate of [
    (row: typeof checkpoint) => {
      row.status = 'PASS';
    },
    (row: typeof checkpoint) => {
      row.failure = 'another failure';
    },
    (row: typeof checkpoint) => {
      row.nativeReviewContinuationProof.stage = 'undo';
    },
    (row: typeof checkpoint) => {
      row.nativeReviewContinuationProof.taskId = 'another-task';
    },
    (row: typeof checkpoint) => {
      row.nativeReviewContinuationProof.sourceSha256 = 'other-source';
    },
    (row: typeof checkpoint) => {
      row.nativeReviewContinuationProof.steps.splice(1, 1);
    },
    (row: typeof checkpoint) => {
      row.nativeReviewContinuationProof.steps.push(row.nativeReviewContinuationProof.steps[0]!);
    },
    (row: typeof checkpoint) => {
      row.cleanup.capturedHostAbsent = false;
    },
    (row: typeof checkpoint) => {
      row.nativeReviewContinuationProof.sourceEpochs[1]!.selectedSourcesDigest = 'changed';
    },
  ]) {
    const row = structuredClone(checkpoint);
    mutate(row);
    assert.throws(() => assertNativeReviewHistoryCheckpoint(row, original, after));
  }
  assert.throws(() =>
    assertNativeReviewHistoryCheckpoint(checkpoint, original, 'not-original-after')
  );
});

test('History hovers and remeasures before one hit-tested click, without keyboard or review actions', async () => {
  const { openDesktopReviewHistory } = await import('./desktop-review-hunk-controls.ts');
  for (const alreadyOpen of [false, true]) {
    let reads = 0,
      expanded = alreadyOpen;
    const sent: Record<string, unknown>[] = [];
    await openDesktopReviewHistory(
      {
        async evaluate(expression) {
          if (expression.includes('undo stack')) return expanded;
          if (expression.includes('window.__TEST_desktopInputEvents')) return {};
          reads++;
          return {
            x: reads === 1 ? 100 : 120,
            y: 73,
            width: 80,
            height: 28,
            label: 'Review history: 2 undo, 0 redo; saved',
            expanded: expanded ? 'true' : 'false',
          };
        },
        async send(method, params) {
          if (method === 'Page.bringToFront') return {};
          assert.equal(method, 'Input.dispatchMouseEvent');
          sent.push(params!);
          if (params?.type === 'mouseReleased') expanded = true;
          return {};
        },
      },
      { assertOwnedRenderer() {}, step() {} }
    );
    const clicks = sent.filter(
      (row) => row.type === 'mousePressed' || row.type === 'mouseReleased'
    );
    assert.deepEqual(
      clicks.map((row) => [row.type, row.x, row.y]),
      alreadyOpen
        ? []
        : [
            ['mousePressed', 120, 73],
            ['mouseReleased', 120, 73],
          ]
    );
    if (!alreadyOpen) assert.ok(reads >= 5);
  }
});

test('readback artifact suffix preserves original files and rejects unsafe or ambiguous attempts', async () => {
  const { desktopReadbackArtifactName } = await import('./desktop-readback-fixture.ts');
  assert.equal(
    desktopReadbackArtifactName('desktop-native-review-history-receipt.json', 'HIST02'),
    'desktop-native-review-history-receipt-HIST02.json'
  );
  assert.equal(
    desktopReadbackArtifactName('ui-readback-failure.png', 'HIST02'),
    'ui-readback-failure-HIST02.png'
  );
  for (const id of ['', '../foo', '12345', '1234567', 'foo_12', 'foo/12'])
    assert.throws(() => desktopReadbackArtifactName('desktop-app.log', id));
  assert.throws(() => desktopReadbackArtifactName('../desktop-app.log', 'HIST02'));
});

test('actual continuation mode reaches suffixed artifact branches without becoming ordinary readback', async () => {
  const { desktopReadbackArtifacts } = await import('./desktop-readback-fixture.ts');
  const noFixture = () => {
    throw new Error('artifact mode test must not allocate a fixture or model');
  };
  const continuation = await prepareDesktopProofMode('native-review-continuation-ui', noFixture);
  assert.equal(continuation.readbackMode, false);
  assert.equal(continuation.nativeReviewContinuationMode, true);
  assert.equal(continuation.model, undefined);
  assert.deepEqual(desktopReadbackArtifacts(continuation, 'history', 'HIST02'), {
    receipt: 'desktop-native-review-history-receipt-HIST02.json',
    appLog: 'desktop-native-review-history-app-HIST02.log',
    failureScreenshot: 'ui-readback-failure-HIST02.png',
  });
  assert.equal(
    desktopReadbackArtifacts(continuation, 'pre-review', 'HIST02').receipt,
    'desktop-native-review-pre-review-receipt-HIST02.json'
  );
  const ordinary = await prepareDesktopProofMode('native-readback-ui', noFixture);
  assert.equal(ordinary.readbackMode, true);
  assert.equal(ordinary.nativeReviewContinuationMode, false);
  assert.equal(
    desktopReadbackArtifacts(ordinary, undefined, 'TEST01').receipt,
    'desktop-readback-receipt-TEST01.json'
  );
  const nativeReview = await prepareDesktopProofMode('native-review-readback-ui', noFixture);
  assert.equal(nativeReview.model, undefined);
  assert.equal(nativeReview.nativeReviewContinuationMode, false);
  assert.deepEqual(desktopReadbackArtifacts(nativeReview, undefined, 'RO0002'), {
    receipt: 'desktop-native-review-readback-receipt-RO0002.json',
    appLog: 'desktop-native-review-readback-app-RO0002.log',
    failureScreenshot: 'ui-failure-RO0002.png',
  });
  const bridge = await prepareDesktopProofMode('bridge-diagnostics', noFixture);
  assert.throws(() => desktopReadbackArtifacts(bridge, undefined, 'HIST02'));
  assert.throws(() => desktopReadbackArtifacts(continuation, 'unknown', 'HIST02'));
});

test('prior History focus failure must prove no Space or review action was dispatched', async () => {
  const { assertNativeReviewHistoryFocusFailure } =
    await import('./desktop-native-review-continuation-source.ts');
  const raw = {
    mode: 'native-review-continuation-ui',
    status: 'INCOMPLETE',
    root: '/TEST/root',
    failure: 'exact original History trigger focused before Space\n\nfalse !== true\n',
    selectedSourceHashesBeforeApp: [],
    selectedSourceHashesAfterFlow: [],
    nativeReviewContinuationProof: {
      stage: 'history',
      status: 'INCOMPLETE',
      originalReceiptSha256: '6758429e18597fc528b69b73a06ca66f2152843e5aedc700e634b221d20fe41f',
      steps: [] as Record<string, unknown>[],
    },
    cleanup: { remaining: [], capturedHostObserved: true, capturedHostAbsent: true },
  };
  assert.doesNotThrow(() => assertNativeReviewHistoryFocusFailure(raw, raw.root));
  for (const step of [
    { action: 'keyboard', label: 'Space' },
    { action: 'mouseClick', label: 'Undo original action' },
    { action: 'mouseClick', label: 'Keep another hunk' },
  ]) {
    const changed = structuredClone(raw);
    changed.nativeReviewContinuationProof.steps.push(step);
    assert.throws(() => assertNativeReviewHistoryFocusFailure(changed, raw.root));
  }
  assert.throws(() =>
    assertNativeReviewHistoryFocusFailure({ ...raw, failure: 'different timeout' }, raw.root)
  );
  assert.throws(() =>
    assertNativeReviewHistoryFocusFailure({ ...raw, selectedSourceHashesAfterFlow: [{}] }, raw.root)
  );
});

test('only the exact 59-indent keyboard draft is admitted, with no disk or review-state changes', async () => {
  const { assertNativeReviewKeyboardDraft } =
    await import('./desktop-native-review-continuation-source.ts');
  const { createHash } = await import('node:crypto');
  const scope = {
    taskId: 'TEST-task',
    filePath: '/TEST/native-review.ts',
    path: '/TEST/exact-draft.json',
    mixed: 'TEST mixed disk bytes\n',
    scopeToken: 'TEST-ledger-scope',
  };
  const entry = {
    filePath: scope.filePath,
    codec: 'codemirror-history-v1',
    revision: 59,
    diskBaseline: scope.mixed,
    generation: '8286c59f-5a4b-406d-95cb-afaa660f9cf9',
    updatedAt: '2026-10-23T02:07:58.832Z',
    editorState: {
      doc: ' '.repeat(118) + scope.mixed,
      selection: { ranges: [{ anchor: 118, head: 118 }], main: 0 },
      history: {
        done: Array.from({ length: 59 }, (_, index) => ({
          changes: [[2], scope.mixed.length + index * 2],
          startSelection: { ranges: [{ anchor: index * 2, head: index * 2 }], main: 0 },
          selectionsAfter: [],
        })),
        undone: [],
      },
    },
  };
  const snapshot = {
    path: scope.path,
    value: {
      version: 1,
      scopeKey: 'task-TEST-task',
      scopeTokenHash: createHash('sha256').update(scope.scopeToken).digest('hex'),
      entries: { [scope.filePath]: entry },
      updatedAt: entry.updatedAt,
    },
  };
  assert.doesNotThrow(() => assertNativeReviewKeyboardDraft(snapshot, scope));
  for (const mutate of [
    (row: typeof snapshot) => {
      row.path = '/TEST/another-draft.json';
    },
    (row: typeof snapshot) => {
      row.value.scopeTokenHash = 'another-context';
    },
    (row: typeof snapshot) => {
      row.value.entries[scope.filePath]!.revision = 60;
    },
    (row: typeof snapshot) => {
      row.value.entries[scope.filePath]!.diskBaseline = 'changed disk';
    },
    (row: typeof snapshot) => {
      row.value.entries[scope.filePath]!.editorState.doc = ' '.repeat(116) + scope.mixed;
    },
    (row: typeof snapshot) => {
      row.value.entries[scope.filePath]!.editorState.history.done.pop();
    },
    (row: typeof snapshot) => {
      row.value.entries[scope.filePath]!.editorState.history.done[0]!.changes = [
        [4],
        scope.mixed.length,
      ];
    },
    (row: typeof snapshot) => {
      row.value.entries['/TEST/other.ts'] = entry;
    },
    (row: typeof snapshot) => {
      row.value.entries[scope.filePath]!.generation = 'another-generation';
    },
  ]) {
    const row = structuredClone(snapshot);
    mutate(row);
    assert.throws(() => assertNativeReviewKeyboardDraft(row, scope));
  }
});
