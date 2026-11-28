import assert from 'node:assert/strict';
import { TaskChangeLedgerReader } from '@agent-teams/task-change-ledger';
import { deriveTaskSince } from '../../src/shared/utils/taskChangeSince.ts';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { digest } from '../../packages/legacy-agent-host/dist/team/identity.js';
import { fileDigest } from './desktop-backend-fixture.ts';
import { readNativeReviewSeed } from './desktop-native-review-fixture.ts';
import { readNativeReviewRuntimeRecords } from './desktop-native-review-runtime.ts';
import { readDesktopReviewDecisions } from './desktop-review-hunk-controls.ts';
type Row = Record<string, unknown>;
const record = (value: unknown): Row => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Row;
};
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
export const NATIVE_REVIEW_UNDO_FAILURE =
  'UI read timed out: Undo original native hunk rejection; no mutation retry';

export type NativeReviewContinuationStage = 'undo' | 'pre-review' | 'history';
export function nativeReviewContinuationStage(): NativeReviewContinuationStage {
  const stage = process.env.LEGACY_DESKTOP_REVIEW_CONTINUATION_STAGE ?? 'undo';
  assert.ok(stage === 'undo' || stage === 'pre-review' || stage === 'history');
  return stage;
}
export function assertNativeReviewContinuationSource(raw: Row): Row {
  assert.equal(raw.failure, NATIVE_REVIEW_UNDO_FAILURE);
  return assertNativeReviewSource(raw);
}
export const NATIVE_REVIEW_PRE_REVIEW_FAILURE =
  'UI read timed out: Task Changes section; no mutation retry';
export function assertNativeReviewPreReviewSource(raw: Row): Row {
  assert.equal(raw.failure, NATIVE_REVIEW_PRE_REVIEW_FAILURE);
  const original = assertNativeReviewSource(raw),
    expected = [
      'Model: claude-sonnet-4-6',
      'Effort: low',
      'Fast disabled',
      'Anthropic limited to 200K context',
    ];
  assert.ok(
    Array.isArray(original.savedChoicesBeforeTyping) &&
      expected.every(
        (value) =>
          original.savedChoicesBeforeTyping instanceof Array &&
          original.savedChoicesBeforeTyping.includes(value)
      )
  );
  const observations = record(raw.model).observations;
  assert.ok(Array.isArray(observations) && observations.length === 7);
  assert.deepEqual(
    observations.map(record).map((row) => [row.turn, row.step]),
    [
      ['bootstrap', 0],
      ['bootstrap', 1],
      ['work', 0],
      ['work', 1],
      ['work', 2],
      ['work', 3],
      ['work', 4],
    ]
  );
  assert.ok(
    observations
      .map(record)
      .every((row) => row.requestedModel === 'claude-sonnet-4-6' && row.requestedEffort === 'low')
  );
  const steps = (original.steps as unknown[]).map(record);
  assert.equal(steps.filter((row) => row.label === 'open original Task detail').length, 1);
  assert.ok(!steps.some((row) => /^(Keep|Reject|Undo|Redo) /.test(String(row.label))));
  return original;
}
/** Shared exact native provenance only; each finite continuation keeps its separate failure guard. */
function assertNativeReviewSource(raw: Row): Row {
  assert.equal(raw.mode, 'native-review-ui');
  assert.equal(raw.status, 'INCOMPLETE');
  const original = record(raw.nativeReviewUiProof);
  assert.equal(original.status, 'INCOMPLETE');
  assert.match(String(original.taskId), /^[A-Za-z0-9_-]+$/);
  assert.equal(record(original.stop).releasedBeforeReview, true);
  const cleanup = record(raw.cleanup);
  assert.deepEqual(cleanup.remaining, []);
  assert.equal(cleanup.capturedHostObserved, true);
  assert.equal(cleanup.capturedHostAbsent, true);
  const start = record(original.startReceipt),
    command = record(start.command),
    outbox = record(original.taskStartOutbox);
  assert.equal(start.phase, 'completed');
  assert.equal(start.principalId, 'TEST-human');
  assert.equal(command.operation, 'task.start');
  assert.equal(record(command.payload).taskId, original.taskId);
  assert.equal(record(command.payload).notification, 'user');
  assert.equal(outbox.commandId, start.commandId);
  assert.equal(outbox.messageId, record(start.effects).messageId);
  assert.equal(outbox.inputId, outbox.deliveryId);
  assert.equal(outbox.phase, 'admitted');
  const input = record(original.originalRuntimeInput);
  assert.equal(input.phase, 'terminal');
  assert.equal(input.terminal, 'succeeded');
  assert.equal(record(input.intent).inputId, outbox.inputId);
  const runtime = record(original.runtime);
  assert.ok(Array.isArray(runtime.inputs) && runtime.inputs.length === 2);
  assert.ok(
    runtime.inputs
      .map(record)
      .every((value) => value.phase === 'terminal' && value.terminal === 'succeeded')
  );
  assert.deepEqual(
    runtime.inputs.map(record).find((value) => record(value.intent).inputId === outbox.inputId),
    input
  );
  assert.deepEqual(record(raw.model).failures, []);
  assert.deepEqual(record(raw.model).unexpectedNoToolsRequests, []);
  assert.ok(Array.isArray(original.events) && original.events.length === 2);
  for (const event of original.events.map(record)) {
    assert.equal(event.taskId, original.taskId);
    assert.equal(event.taskRef, original.taskId);
    assert.equal(event.taskRefKind, 'canonical');
    assert.equal(event.toolStatus, 'succeeded');
    const cause = record(event.causalBinding),
      proof = record(event.nativeCaptureProof);
    assert.equal(cause.taskId, original.taskId);
    assert.equal(cause.taskStartCommandId, start.commandId);
    assert.equal(cause.inputId, outbox.inputId);
    assert.equal(cause.operationRef, input.operationRef);
    assert.equal(cause.sessionRef, record(original.runtime).sessionRef);
    assert.deepEqual(cause.binding, record(original.runtime).binding);
    assert.equal(event.evidenceProof, digest(cause));
    assert.equal(proof.kind, 'edit-input-v1');
  }
  assert.equal(new Set(original.events.map((event) => record(event).toolUseId)).size, 2);
  return original;
}

/** Read-only qualification before app startup and again before any review mutation. */
export async function readNativeReviewContinuationSource(
  root: string,
  raw: Row,
  stage: NativeReviewContinuationStage = 'undo'
) {
  assert.equal(raw.root, root);
  const original =
      stage === 'undo'
        ? assertNativeReviewContinuationSource(raw)
        : assertNativeReviewPreReviewSource(raw),
    taskId = String(original.taskId);
  const seed = await readNativeReviewSeed(root),
    team = join(root, 'hoststore/teams/test-desktop-backend');
  let historyCheckpoint: Row | undefined;
  if (stage === 'history') {
    assert.equal(
      await fileDigest(join(root, 'desktop-backend-receipt.json')),
      '6758429e18597fc528b69b73a06ca66f2152843e5aedc700e634b221d20fe41f'
    );
    assert.equal(
      await fileDigest(join(root, 'desktop-native-review-continuation-receipt.json')),
      'fe948f0ec6c837ad316c7e8de88169ca3d4d7648f8e79cb7c5a83bba6f40fafa'
    );
    const path = join(root, 'desktop-native-review-pre-review-receipt.json');
    const sha256 = await fileDigest(path);
    assert.equal(sha256, '9b99345c84da27e6b719bca659794fbb6dde12cdd62df4c80fbd098abf2e9a9d');
    const checkpoint = record(JSON.parse(await readFile(path, 'utf8')));
    assert.equal(
      digest(checkpoint.selectedSourceHashesBeforeApp),
      '09cef90e2c095b2677fa77ad0cbc15446c5c17b98945c8fe82a2207c91de3479'
    );
    assertNativeReviewHistoryCheckpoint(checkpoint, raw, seed.after);
    historyCheckpoint = {
      path,
      sha256,
      executedSourceSha256: record(checkpoint.nativeReviewContinuationProof).sourceSha256,
      selectedSourcesDigest: digest(checkpoint.selectedSourceHashesBeforeApp),
    };
    const readonlyPath = join(root, 'desktop-native-review-history-receipt.json');
    const readonlySha256 = await fileDigest(readonlyPath);
    assert.equal(
      readonlySha256,
      'd0f511add1cc1f246dbde586e5b63019e15bbbe73e5bfab9381737faa39fcfc0'
    );
    const readonly = record(JSON.parse(await readFile(readonlyPath, 'utf8')));
    assertNativeReviewHistoryFocusFailure(readonly, root);
    historyCheckpoint.priorHistoryNavigationFailure = {
      path: readonlyPath,
      sha256: readonlySha256,
    };
  }
  assert.equal(await fileDigest(join(root, 'native-review-ui-seed.json')), original.seedSha256);
  assert.equal(
    await readFile(seed.filePath, 'utf8'),
    stage === 'pre-review' ? seed.after : seed.mixed
  );
  const eventPath = join(team, '.host-evidence/.board-task-changes/events', taskId + '.jsonl');
  const eventBytes = await readFile(eventPath);
  const events = eventBytes
    .toString('utf8')
    .trim()
    .split('\n')
    .map((line) => record(JSON.parse(line)));
  assert.deepEqual(events, original.events);
  for (const [index, event] of events.entries()) {
    const before = index === 0 ? seed.before : seed.intermediate,
      after = index === 0 ? seed.intermediate : seed.after;
    const proof = record(event.nativeCaptureProof);
    assert.equal(event.filePath, seed.filePath);
    assert.equal(proof.beforeSha256, sha(before));
    assert.equal(proof.afterSha256, sha(after));
    assert.equal(
      proof.toolInputDigest,
      digest({
        toolName: 'Edit',
        input: {
          file_path: seed.filePath,
          old_string: index === 0 ? 'const first = 1;' : 'const last = 1;',
          new_string: index === 0 ? 'const first = 2;' : 'const last = 2;',
          replace_all: false,
        },
      })
    );
    for (const [side, text] of [
      ['before', before],
      ['after', after],
    ] as const) {
      const blob = record(event[side]);
      assert.equal(blob.sha256, sha(text));
      assert.equal(
        await readFile(
          join(team, '.host-evidence/.board-task-changes/blobs', String(blob.blobRef)),
          'utf8'
        ),
        text
      );
    }
  }
  const sessions = await readNativeReviewRuntimeRecords(root, original);
  const statePath = join(team, '.host-owner/state.json'),
    stateBytes = await readFile(statePath);
  const state = record(JSON.parse(stateBytes.toString('utf8')));
  assert.deepEqual(state.runtimeCaptures, [original.capture]);
  let initialMetadataCommand: Row | undefined;
  let keyboardDraft: { snapshot: Row; identity: Row } | undefined;
  const persistence = await readDesktopReviewDecisions(root).catch(
    (error: NodeJS.ErrnoException) => {
      if (
        stage === 'pre-review' &&
        error.code === 'ENOENT' &&
        error.path === join(team, 'review-decisions')
      )
        return [];
      throw error;
    }
  );
  if (stage === 'pre-review') {
    assert.ok(persistence.length <= 1);
    const names = await readdir(join(team, '.host-owner/commands'));
    assert.ok(names.length <= 128);
    const reviewCommands: { path: string; value: Row }[] = [];
    for (const name of names.filter((value) => value.endsWith('.json'))) {
      const path = join(team, '.host-owner/commands', name);
      const command = record(JSON.parse(await readFile(path, 'utf8')));
      if (command.family === 'review') reviewCommands.push({ path, value: command });
    }
    if (persistence.length === 0) {
      assert.equal(reviewCommands.length, 0);
      await assertReviewNamespaceAbsent(join(team, 'review-decisions'));
    } else {
      const task = record(
        JSON.parse(
          await readFile(
            join(root, 'hoststore/tasks/test-desktop-backend', taskId + '.json'),
            'utf8'
          )
        )
      );
      const expectedTask = record(record(record(original.startReceipt).result).task);
      for (const key of ['id', 'owner', 'status', 'createdAt'])
        assert.equal(task[key], expectedTask[key]);
      assert.equal(task.reviewState, 'none');
      assert.equal(task.status, 'in_progress');
      const changes = await new TaskChangeLedgerReader().readTaskChanges({
        teamName: 'test-desktop-backend',
        taskId,
        projectDir: join(team, '.host-evidence'),
        projectPath: join(root, 'workspace'),
        includeDetails: true,
      });
      assert.equal(changes?.provenance?.sourceKind, 'ledger');
      assert.ok(changes?.provenance?.sourceFingerprint);
      const since = deriveTaskSince({
        createdAt: String(task.createdAt),
        historyEvents: (task.historyEvents as unknown[])
          .map(record)
          .map((row) => ({ timestamp: String(row.timestamp) })),
        workIntervals: (task.workIntervals as unknown[])
          .map(record)
          .map((row) => ({ startedAt: String(row.startedAt) })),
      });
      const signature = JSON.stringify({
        owner: task.owner,
        status: task.status,
        since,
        stateBucket: 'active',
        intervals: [],
      });
      const scopeToken = `task:${taskId}:${signature}:provenance:ledger:${changes.provenance.sourceFingerprint}`;
      const expectedPath = join(
        team,
        'review-decisions/v2',
        `task-${taskId}`,
        sha(scopeToken) + '.json'
      );
      assertNativeReviewEmptyPersistence(persistence[0]!, {
        taskId,
        scopeToken,
        path: expectedPath,
      });
      assert.equal(reviewCommands.length, 1);
      const metadata = reviewCommands[0]!;
      assertNativeReviewInitialMetadataCommand(metadata.value, {
        taskId,
        scopeToken,
        binding: record(state.binding),
        updatedAt: String(record(persistence[0]!.value).updatedAt),
      });
      assert.equal(
        metadata.path,
        join(team, '.host-owner/commands', digest(metadata.value.commandId) + '.json')
      );
      initialMetadataCommand = { ...metadata, sha256: await fileDigest(metadata.path) };
      const entries = await readdir(join(team, 'review-decisions'), {
        recursive: true,
        withFileTypes: true,
      });
      for (const entry of entries) {
        const path = join(entry.parentPath, entry.name);
        assert.ok(
          (entry.isFile() && path === expectedPath) ||
            (entry.isDirectory() &&
              (path === dirname(expectedPath) || path === dirname(dirname(expectedPath)))),
          'only exact empty snapshot namespace; no WAL, conflicts, other scopes or links'
        );
      }
    }
    for (const [key, value] of Object.entries({
      model: 'claude-sonnet-4-6',
      effort: 'low',
      fastMode: 'off',
      limitContext: true,
    }))
      assert.equal(record(state.savedSettings)[key], value);
  } else {
    let decisionSnapshots = persistence;
    if (stage === 'history') {
      assert.equal(
        persistence.length,
        2,
        'one exact authoritative snapshot plus the admitted keyboard draft'
      );
      const scopeToken = String(
        record(persistence.find((row) => record(row.value).version === 6)!.value).scopeToken
      );
      const draftPath = join(
        team,
        'review-decisions/draft-history/v1',
        `task-${taskId}`,
        sha(scopeToken) + '.json'
      );
      const snapshot = persistence.find((row) => row.path === draftPath)!;
      assert.ok(snapshot);
      assert.equal(
        snapshot.sha256,
        '8a56c576f2bb98552125056d981a06e3b57d7c6527c70a50a31b4c392d1e2e5c'
      );
      assertNativeReviewKeyboardDraft(snapshot, {
        taskId,
        filePath: seed.filePath,
        mixed: seed.mixed,
        scopeToken,
        path: draftPath,
      });
      keyboardDraft = {
        snapshot,
        identity: await readNativeReviewKeyboardDraftIdentity(draftPath),
      };
      decisionSnapshots = persistence.filter((row) => row !== snapshot);
    }
    assert.equal(decisionSnapshots.length, 1);
    const review = record(decisionSnapshots[0]!.value);
    assert.equal(review.scopeKey, `task-${taskId}`);
    assert.ok(Array.isArray(review.reviewActionHistory) && review.reviewActionHistory.length === 2);
    assert.deepEqual(review.reviewRedoHistory, []);
    assert.deepEqual(review.hunkDecisions, {
      [`path:${seed.filePath}:0`]: 'accepted',
      [`path:${seed.filePath}:1`]: 'rejected',
    });
    for (const [index, entry] of review.reviewActionHistory.map(record).entries()) {
      const descriptor = record(entry.descriptor);
      assert.equal(descriptor.filePath, seed.filePath);
      assert.equal(descriptor.intent, index === 0 ? 'accept-hunk' : 'reject-hunk');
      assert.equal(descriptor.hunkIndex, index);
    }
    if (stage === 'history')
      assert.equal(
        decisionSnapshots[0]!.sha256,
        '4c2d99a11968036b01288111216153d3ba5d96d8ab79e1faaec2806fdc468cd0'
      );
  }
  assert.equal(await fileDigest(join(root, 'workspace/.git/index')), seed.gitIndexSha256);
  return {
    stage,
    original,
    taskId,
    seed,
    sessions,
    statePath,
    stateBytes,
    eventPath,
    eventBytes,
    persistence,
    initialMetadataCommand,
    historyCheckpoint,
    keyboardDraft,
    fileSha256: await fileDigest(seed.filePath),
  };
}

/** The prior Tab fallback contaminated only this exact persisted editor draft, never disk. */
export function assertNativeReviewKeyboardDraft(
  snapshot: Row,
  scope: {
    taskId: string;
    filePath: string;
    mixed: string;
    scopeToken: string;
    path: string;
  }
): void {
  assert.equal(snapshot.path, scope.path);
  const value = record(snapshot.value);
  assert.deepEqual(
    Object.keys(value).sort(),
    ['version', 'scopeKey', 'scopeTokenHash', 'entries', 'updatedAt'].sort()
  );
  assert.equal(value.version, 1);
  assert.equal(value.scopeKey, `task-${scope.taskId}`);
  assert.equal(value.scopeTokenHash, sha(scope.scopeToken));
  const entries = record(value.entries);
  assert.deepEqual(Object.keys(entries), [scope.filePath]);
  const entry = record(entries[scope.filePath]);
  assert.deepEqual(
    Object.keys(entry).sort(),
    [
      'filePath',
      'codec',
      'revision',
      'diskBaseline',
      'editorState',
      'generation',
      'updatedAt',
    ].sort()
  );
  assert.equal(entry.filePath, scope.filePath);
  assert.equal(entry.codec, 'codemirror-history-v1');
  assert.equal(entry.revision, 59);
  assert.equal(entry.diskBaseline, scope.mixed);
  assert.equal(entry.generation, '8286c59f-5a4b-406d-95cb-afaa660f9cf9');
  assert.equal(entry.updatedAt, '2026-10-23T02:07:58.832Z');
  assert.equal(value.updatedAt, entry.updatedAt);
  assert.deepEqual(entry.editorState, {
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
  });
}

/** Physical identity and full bytes stay frozen; no draft rewrite, discard or metadata normalization. */
export async function readNativeReviewKeyboardDraftIdentity(path: string): Promise<Row> {
  const identity = async () => {
    const stat = await lstat(path, { bigint: true });
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
    return Object.fromEntries(
      ['dev', 'ino', 'birthtimeNs', 'mtimeNs', 'ctimeNs', 'size', 'mode', 'nlink'].map((key) => [
        key,
        String(stat[key as keyof typeof stat]),
      ])
    );
  };
  const before = await identity();
  assert.deepEqual(before, {
    dev: '16777230',
    ino: '1344846820',
    birthtimeNs: '1792721278832784957',
    mtimeNs: '1792721278832910292',
    ctimeNs: '1792721278842361201',
    size: '7843',
    mode: '33152',
    nlink: '1',
  });
  const sha256 = await fileDigest(path);
  assert.equal(sha256, '8a56c576f2bb98552125056d981a06e3b57d7c6527c70a50a31b4c392d1e2e5c');
  assert.deepEqual(await identity(), before);
  return { ...before, sha256 };
}

export function assertNativeReviewHistoryFocusFailure(raw: Row, root: string): void {
  assert.equal(raw.mode, 'native-review-continuation-ui');
  assert.equal(raw.status, 'INCOMPLETE');
  assert.equal(raw.root, root);
  assert.equal(
    raw.failure,
    'exact original History trigger focused before Space\n\nfalse !== true\n'
  );
  assert.deepEqual(raw.selectedSourceHashesBeforeApp, raw.selectedSourceHashesAfterFlow);
  const proof = record(raw.nativeReviewContinuationProof);
  assert.equal(proof.stage, 'history');
  assert.equal(proof.status, 'INCOMPLETE');
  assert.equal(
    proof.originalReceiptSha256,
    '6758429e18597fc528b69b73a06ca66f2152843e5aedc700e634b221d20fe41f'
  );
  assert.ok(
    !(proof.steps as unknown[])
      .map(record)
      .some(
        (row) => /^(Keep|Reject|Undo|Redo) /.test(String(row.label)) || row.action === 'keyboard'
      )
  );
  const cleanup = record(raw.cleanup);
  assert.deepEqual(cleanup.remaining, []);
  assert.equal(cleanup.capturedHostObserved, true);
  assert.equal(cleanup.capturedHostAbsent, true);
}

/** Exact prior four-action checkpoint; the history stage has no review-mutation authority. */
export function assertNativeReviewHistoryCheckpoint(
  checkpoint: Row,
  original: Row,
  after: string
): void {
  assert.equal(checkpoint.mode, 'native-review-continuation-ui');
  assert.equal(checkpoint.status, 'INCOMPLETE');
  assert.equal(checkpoint.root, original.root);
  assert.equal(
    checkpoint.failure,
    'UI read timed out: continued original History visible; no mutation retry'
  );
  assert.deepEqual(
    checkpoint.selectedSourceHashesBeforeApp,
    checkpoint.selectedSourceHashesAfterFlow
  );
  const proof = record(checkpoint.nativeReviewContinuationProof);
  const epochs = proof.sourceEpochs as unknown[];
  assert.ok(Array.isArray(epochs) && epochs.length === 2);
  assert.equal(
    record(epochs[1]).selectedSourcesDigest,
    digest(checkpoint.selectedSourceHashesBeforeApp)
  );
  assert.equal(
    record(epochs[0]).selectedSourcesDigest,
    digest(original.selectedSourceHashesBeforeApp)
  );
  assert.equal(proof.status, 'INCOMPLETE');
  assert.equal(proof.stage, 'pre-review');
  assert.equal(proof.taskId, record(original.nativeReviewUiProof).taskId);
  assert.equal(
    proof.originalReceiptSha256,
    '6758429e18597fc528b69b73a06ca66f2152843e5aedc700e634b221d20fe41f'
  );
  assert.equal(
    proof.sourceSha256,
    'a0d23a754a5df7eee2f1dcfe007a9f799f2c5d859b92fb0c02d1b9cf41a19d2f'
  );
  assert.equal(proof.undoFileSha256, sha(after));
  const actions = (proof.steps as unknown[])
    .map(record)
    .filter((row) => /^(Keep|Reject|Undo|Redo) /.test(String(row.label)));
  assert.deepEqual(
    actions.map((row) => [row.action, row.label, row.state]),
    [
      ['mouseClick', 'Keep first retained native hunk once', 'attempted'],
      ['mouseClick', 'Reject second retained native hunk once', 'attempted'],
      ['mouseClick', 'Undo original retained native hunk rejection once', 'attempted'],
      ['mouseClick', 'Redo original retained native hunk rejection once', 'attempted'],
    ]
  );
  assert.equal(
    (proof.steps as unknown[])
      .map(record)
      .filter((row) => row.label === 'open continued original History').length,
    1
  );
  const cleanup = record(checkpoint.cleanup);
  assert.deepEqual(cleanup.remaining, []);
  assert.equal(cleanup.capturedHostObserved, true);
  assert.equal(cleanup.capturedHostAbsent, true);
}

/** Existing close initializes one empty scope; this admits no user review mutation or replay. */
export function assertNativeReviewInitialMetadataCommand(
  command: Row,
  scope: { taskId: string; scopeToken: string; binding: Row; updatedAt: string }
): void {
  assert.deepEqual(
    Object.keys(command).sort(),
    [
      'schemaVersion',
      'family',
      'binding',
      'commandId',
      'principalId',
      'origin',
      'method',
      'requestDigest',
      'authorityRevision',
      'createdAt',
      'phase',
      'fingerprint',
      'response',
      'responseDigest',
    ].sort()
  );
  assert.equal(command.schemaVersion, 1);
  assert.equal(command.family, 'review');
  assert.equal(command.commandId, 'c87e2971-5b22-43d2-8047-683521e45a3c');
  assert.deepEqual(command.binding, scope.binding);
  assert.equal(command.principalId, 'TEST-human');
  assert.deepEqual(command.origin, { taskId: scope.taskId });
  assert.equal(command.method, 'clearDecisions');
  assert.equal(command.phase, 'completed');
  assert.equal(command.authorityRevision, 1);
  assert.equal(
    command.requestDigest,
    digest({
      method: 'clearDecisions',
      args: ['test-desktop-backend', `task-${scope.taskId}`, scope.scopeToken, 0],
    })
  );
  assert.equal(
    command.fingerprint,
    digest({
      family: 'review',
      binding: command.binding,
      commandId: command.commandId,
      principalId: command.principalId,
      origin: command.origin,
      method: command.method,
      requestDigest: command.requestDigest,
    })
  );
  assert.deepEqual(command.response, {
    kind: 'review-writer',
    method: 'clearDecisions',
    result: { revision: 1 },
  });
  assert.equal(command.responseDigest, digest(command.response));
  const time = Date.parse(String(command.createdAt));
  assert.ok(Number.isFinite(time) && time <= Date.parse(scope.updatedAt));
  assert.equal(new Date(time).toISOString(), command.createdAt);
}

async function assertReviewNamespaceAbsent(path: string): Promise<void> {
  try {
    await readdir(path);
    assert.fail('pre-review continuation requires no prior decision/WAL namespace');
  } catch (error) {
    assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT');
  }
}

/** An initial hydration cache is allowed only with zero decisions, blobs, history or mutation identity. */
export function assertNativeReviewEmptyPersistence(
  snapshot: Row,
  scope: { taskId: string; scopeToken: string; path: string }
): void {
  assert.equal(snapshot.path, scope.path);
  const value = record(snapshot.value);
  assert.deepEqual(
    Object.keys(value).sort(),
    [
      'version',
      'scopeKey',
      'scopeToken',
      'hunkDecisions',
      'fileDecisions',
      'hunkContextHashesByFile',
      'reviewActionHistory',
      'reviewRedoHistory',
      'textBlobs',
      'fileSummaryBlobs',
      'revision',
      'updatedAt',
    ].sort()
  );
  assert.equal(value.version, 6);
  assert.equal(value.revision, 1);
  assert.equal(value.scopeKey, `task-${scope.taskId}`);
  assert.equal(value.scopeToken, scope.scopeToken);
  for (const key of [
    'hunkDecisions',
    'fileDecisions',
    'hunkContextHashesByFile',
    'textBlobs',
    'fileSummaryBlobs',
  ])
    assert.deepEqual(value[key], {});
  assert.deepEqual(value.reviewActionHistory, []);
  assert.deepEqual(value.reviewRedoHistory, []);
  assert.equal(typeof value.updatedAt, 'string');
  const time = Date.parse(String(value.updatedAt));
  assert.ok(Number.isFinite(time));
  assert.equal(new Date(time).toISOString(), value.updatedAt);
}
