import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { TaskChangeLedgerReader } from '@agent-teams/task-change-ledger';
import { classifyTaskChangeReviewability } from '@agent-teams/task-change-ledger/reviewability';

function ref(content: string, blobRef: string) {
  return {
    sha256: createHash('sha256').update(content).digest('hex'),
    sizeBytes: Buffer.byteLength(content),
    blobRef,
  };
}

// The public Node entry must reconstruct actual captured evidence without any Desktop runtime or aliases.
test('portable reader preserves journal detail, reconstruction diagnostics, and hash-checked contents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'TEST-portable-task-ledger-'));
  const taskId = 'TEST-task';
  const before = 'export const value = 1;\n';
  const after = 'export const value = 2;\n';
  const eventsDir = join(root, '.board-task-changes', 'events');
  const blobsDir = join(root, '.board-task-changes', 'blobs');
  try {
    await mkdir(eventsDir, { recursive: true });
    await mkdir(blobsDir, { recursive: true });
    await writeFile(join(blobsDir, 'before.txt'), before);
    await writeFile(join(blobsDir, 'after.txt'), after);
    await writeFile(
      join(eventsDir, `${taskId}.jsonl`),
      JSON.stringify({
        schemaVersion: 1,
        eventId: 'TEST-event',
        taskId,
        taskRef: taskId,
        taskRefKind: 'canonical',
        phase: 'work',
        executionSeq: 1,
        sessionId: 'TEST-session',
        memberName: 'alice',
        toolUseId: 'TEST-tool',
        source: 'file_edit',
        operation: 'modify',
        confidence: 'exact',
        workspaceRoot: root,
        filePath: join(root, 'src', 'value.ts'),
        relativePath: 'src/value.ts',
        timestamp: '2026-10-23T00:00:00.000Z',
        toolStatus: 'succeeded',
        before: ref(before, 'before.txt'),
        after: ref(after, 'after.txt'),
        linesAdded: 1,
        linesRemoved: 1,
      }) + '\ntruncated journal tail\n'
    );
    const reader = new TaskChangeLedgerReader();
    const input = {
      teamName: 'TEST-team',
      taskId,
      projectDir: root,
      projectPath: root,
      includeDetails: true,
    };
    const detailed = await reader.readTaskChanges(input);
    assert.ok(detailed);
    assert.equal(detailed.totalFiles, 1);
    assert.equal(detailed.totalLinesAdded, 1);
    assert.equal(detailed.totalLinesRemoved, 1);
    assert.equal(detailed.files[0]!.relativePath, 'src/value.ts');
    assert.equal(detailed.files[0]!.snippets[0]!.ledger!.originalFullContent, before);
    assert.equal(detailed.files[0]!.snippets[0]!.ledger!.modifiedFullContent, after);
    assert.equal(detailed.scope.memberName, 'alice');
    assert.equal(detailed.provenance!.sourceKind, 'ledger');
    assert.equal(detailed.provenance!.integrity, 'recovered');
    assert.ok(
      detailed.reviewDiagnostics!.some(
        (diagnostic) => diagnostic.code === 'ledger_integrity_recovered'
      )
    );
    assert.equal(classifyTaskChangeReviewability(detailed).reviewability, 'attention_required');
    const originalJournal = await readFile(join(eventsDir, `${taskId}.jsonl`), 'utf8');
    await writeFile(join(blobsDir, 'after.txt'), after.replace('2', '9'));
    const tampered = await reader.readTaskChanges(input);
    assert.equal(
      tampered!.files[0]!.snippets[0]!.ledger!.modifiedFullContent,
      null,
      'a blob with the right size and a changed hash cannot become review evidence'
    );
    const summary = await reader.readTaskChanges({ ...input, includeDetails: false });
    assert.equal(summary!.totalFiles, 1);
    assert.deepEqual(summary!.files[0]!.snippets, []);
    assert.equal(
      await readFile(join(eventsDir, `${taskId}.jsonl`), 'utf8'),
      originalJournal,
      'both consumers read existing evidence without rewriting its journal'
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// A portable Host must retain the same confinement boundary when a ledger path escapes its project.
test(
  'portable reader refuses a journal directory symlink outside the captured project',
  { skip: process.platform === 'win32' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'TEST-portable-ledger-confinement-'));
    const outside = await mkdtemp(join(tmpdir(), 'TEST-portable-ledger-outside-'));
    try {
      await mkdir(join(root, '.board-task-changes'), { recursive: true });
      const foreignJournal = JSON.stringify({
        schemaVersion: 1,
        eventId: 'TEST-foreign',
        taskId: 'TEST-task',
        filePath: 'TEST-private-marker',
      });
      await writeFile(join(outside, 'TEST-task.jsonl'), foreignJournal);
      await symlink(outside, join(root, '.board-task-changes', 'events'));
      assert.equal(
        await new TaskChangeLedgerReader().readTaskChanges({
          teamName: 'TEST-team',
          taskId: 'TEST-task',
          projectDir: root,
          includeDetails: true,
        }),
        null
      );
      assert.equal(await readFile(join(outside, 'TEST-task.jsonl'), 'utf8'), foreignJournal);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  }
);
