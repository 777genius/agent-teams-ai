import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileContentResolver } from '@agent-teams/task-change-ledger/review-content';
it('Host ledger-only mode never upgrades disk bytes or renderer reconstruction into authoritative content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'TEST-ledger-only-'));
  try {
    const filePath = join(root, 'current.txt');
    await writeFile(filePath, 'current disk bytes\n');
    const snippets = [
      {
        filePath,
        toolUseId: 'renderer-supplied',
        toolName: 'Edit' as const,
        type: 'edit' as const,
        oldString: 'before',
        newString: 'current disk bytes',
        replaceAll: false,
        timestamp: '',
        isError: false,
      },
    ];
    const result = await new FileContentResolver({ mode: 'ledger-only' }).getFileContent(
      'test-team',
      'lead',
      filePath,
      snippets
    );
    assert.strictEqual(result.contentSource, 'unavailable');
    assert.strictEqual(result.originalFullContent, null);
    assert.strictEqual(result.modifiedFullContent, null);
    assert.strictEqual(await readFile(filePath, 'utf8'), 'current disk bytes\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('qualified native content is usable; old, malformed, missing and intervening unqualified evidence stays nonwritable', async () => {
  const { mkdir } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const { TaskChangeLedgerReader } = await import('@agent-teams/task-change-ledger');
  const root = await mkdtemp(join(tmpdir(), 'TEST-native-content-'));
  try {
    const events = join(root, '.board-task-changes', 'events');
    const blobs = join(root, '.board-task-changes', 'blobs');
    await mkdir(events, { recursive: true });
    await mkdir(blobs, { recursive: true });
    const ref = async (text: string) => {
      const sha256 = createHash('sha256').update(text).digest('hex');
      await writeFile(join(blobs, `${sha256}.txt`), text);
      return { sha256, blobRef: `${sha256}.txt`, sizeBytes: Buffer.byteLength(text) };
    };
    const before = await ref('initial dirty\n'), middle = await ref('authored\n'), after = await ref('final\n');
    const filePath = join(root, 'file.txt');
    const row = (id: string, old = before, next = middle) => ({
      schemaVersion: 1, eventId: id, taskId: 'TEST-task', taskRef: 'TEST-task', taskRefKind: 'canonical',
      phase: 'work', executionSeq: 0, sessionId: 'TEST-session', agentId: 'alice', toolUseId: id,
      source: 'file_write', operation: 'modify', confidence: 'low', workspaceRoot: root,
      filePath, relativePath: 'file.txt', timestamp: '2026-10-23T00:00:00.000Z', toolStatus: 'succeeded',
      before: old, after: next, evidenceProof: 'a'.repeat(64),
      causalBinding: { toolName: 'Write', toolUseId: id },
      nativeCaptureProof: { kind: 'write-input-v1', toolInputDigest: 'b'.repeat(64), beforeSha256: old.sha256, afterSha256: next.sha256 },
    });
    const { ReviewApplier } = await import('@agent-teams/task-change-ledger/review-apply');
    const resolver = new FileContentResolver({ mode: 'ledger-only' });
    const resolve = async (rows: object[]) => {
      await writeFile(join(events, 'TEST-task.jsonl'), rows.map((value) => JSON.stringify(value)).join('\n') + '\n');
      const result = await new TaskChangeLedgerReader().readTaskChanges({ teamName: 'test', taskId: 'TEST-task', projectDir: root, includeDetails: true });
      assert.ok(result);
      const snippets = result.files[0]!.snippets;
      return { snippets, content: await resolver.getFileContent('test', 'alice', filePath, snippets) };
    };
    let result = await resolve([row('qualified')]);
    assert.equal(result.content.originalFullContent, 'initial dirty\n');
    assert.equal(result.content.modifiedFullContent, 'authored\n');
    const old = { ...row('old'), nativeCaptureProof: undefined };
    result = await resolve([old]);
    assert.equal(result.snippets[0]!.ledger!.nativeCapture, 'unqualified');
    assert.equal(result.snippets[0]!.ledger!.originalFullContent, null);
    assert.equal(result.content.contentSource, 'unavailable');
    result = await resolve([old, row('later', middle, after)]);
    assert.equal(result.content.contentSource, 'unavailable', 'later qualified endpoint cannot launder old interval');
    const malformed = row('malformed');
    malformed.nativeCaptureProof.afterSha256 = before.sha256;
    assert.equal((await resolve([malformed])).content.contentSource, 'unavailable');
    assert.equal((await resolve([row('first'), row('disconnected', before, after)])).content.contentSource, 'unavailable');
    result = await resolve([row('first'), row('continuous', middle, after)]);
    assert.equal(result.content.originalFullContent, 'initial dirty\n');
    assert.equal(result.content.modifiedFullContent, 'final\n');
    const missing = row('missing');
    missing.after = { ...middle, blobRef: 'missing.txt' };
    assert.equal((await resolve([missing])).content.contentSource, 'unavailable');
    const creation = { ...row('created'), operation: 'create', before: null,
      beforeState: { exists: false }, nativeCaptureProof: { kind: 'write-input-v1',
        toolInputDigest: 'b'.repeat(64), beforeSha256: null, afterSha256: middle.sha256 } };
    await writeFile(filePath, 'authored\n');
    const reject = async (content: typeof result.content) => new ReviewApplier().applyReviewDecisions({
      teamName: 'test', memberName: 'alice', decisions: [{ filePath, fileDecision: 'rejected', hunkDecisions: {} }],
    }, new Map([[filePath, content]]));
    result = await resolve([{ ...creation, nativeCaptureProof: undefined }]);
    assert.equal((await reject(result.content)).errors[0]?.code, 'manual-review-required');
    assert.equal(await readFile(filePath, 'utf8'), 'authored\n', 'matching afterHash must not authorize unsafe deletion');
    result = await resolve([creation]);
    assert.equal(result.content.originalFullContent, '');
    assert.equal((await reject(result.content)).applied, 1, 'qualified creation still supports rejection');
    await assert.rejects(readFile(filePath), { code: 'ENOENT' });
    const legacy = { ...row('legacy'), evidenceProof: 'inverse-edit-chain', causalBinding: undefined, nativeCaptureProof: undefined };
    result = await resolve([legacy]);
    assert.equal(result.snippets[0]!.ledger!.nativeCapture, undefined);
    assert.equal(result.content.modifiedFullContent, 'authored\n', 'legacy journals retain behavior');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('preview-only mode displays current bytes without inventing a rejection baseline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'TEST-ledger-preview-'));
  try {
    const filePath = join(root, 'created.txt');
    await writeFile(filePath, 'current user bytes\n');
    const snippets = [{
      filePath, toolUseId: 'metadata-add', toolName: 'Edit' as const,
      type: 'write-new' as const, oldString: '', newString: 'task-time bytes\n',
      replaceAll: false, timestamp: '2026-03-01T10:00:00.000Z', isError: false,
    }];
    const content = await new FileContentResolver({ mode: 'preview-only' }).getFileContent(
      'test-team', 'alice', filePath, snippets
    );
    assert.equal(content.isNewFile, true, 'display lifecycle is distinct from writable evidence');
    assert.equal(content.originalFullContent, null);
    assert.equal(content.modifiedFullContent, 'current user bytes\n');
    assert.equal(content.contentSource, 'disk-current');
    const { ReviewApplier } = await import('@agent-teams/task-change-ledger/review-apply');
    const rejected = await new ReviewApplier().applyReviewDecisions({
      teamName: 'test-team', memberName: 'alice',
      decisions: [{ filePath, fileDecision: 'rejected', hunkDecisions: {} }],
    }, new Map([[filePath, content]]));
    assert.equal(rejected.applied, 0, 'preview cannot authorize deletion');
    assert.equal(await readFile(filePath, 'utf8'), 'current user bytes\n');
    const strict = await new FileContentResolver({ mode: 'ledger-only' }).getFileContent(
      'test-team', 'alice', filePath, snippets
    );
    assert.equal(strict.contentSource, 'unavailable');
    assert.equal(strict.modifiedFullContent, null, 'Host strict owner never acquires disk fallback');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('preview creation display respects the earliest event and conflicting tied timestamps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'TEST-ledger-preview-lifecycle-'));
  try {
    const filePath = join(root, 'recreated.txt');
    await writeFile(filePath, 'replacement\n');
    const remove = {
      filePath, toolUseId: 'remove-original', toolName: 'Edit' as const,
      type: 'edit' as const, oldString: 'original\n', newString: '',
      replaceAll: false, timestamp: '2026-03-01T10:00:00.000Z', isError: false,
    };
    const add = {
      ...remove, toolUseId: 'recreate', type: 'write-new' as const,
      oldString: '', newString: 'replacement\n', timestamp: '2026-03-01T10:01:00.000Z',
    };
    const resolver = new FileContentResolver({ mode: 'preview-only' });
    for (const snippets of [[remove, add], [{ ...add, timestamp: remove.timestamp }, remove]]) {
      const content = await resolver.getFileContent('test-team', 'alice', filePath, snippets);
      assert.equal(content.isNewFile, false);
      assert.equal(content.originalFullContent, null);
      assert.equal(content.modifiedFullContent, 'replacement\n');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
