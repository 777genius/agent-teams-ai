import assert from 'node:assert/strict';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { validateCommandEntry, teamCommandPath } from '../../packages/legacy-agent-host/dist/team/commandEntries.js';
import { projectDesktopHarnessFailure } from './desktop-backend-observations.ts';
import { desktopProofSources } from './desktop-proof-sources.ts';
import { runDesktopTaskBoardUiSmoke } from './desktop-task-board-ui-smoke.ts';
import { runDesktopTaskReviewCycleUiSmoke, runDesktopTaskNotificationUiSmoke } from './desktop-task-review-cycle-ui-smoke.ts';
import { runDesktopCrossTeamUiSmoke } from './desktop-cross-team-ui-smoke.ts';
import { runDesktopOversizedCommentUiSmoke } from './desktop-oversized-comment-ui-smoke.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';

/** One failure-only observation; never turns missing receipt evidence into no-dispatch authority. */
async function observeClarificationFailure(
  error: unknown,
  options: Parameters<typeof runDesktopTaskBoardUiSmoke>[1]
): Promise<void> {
  const object = (value: unknown): Record<string, unknown> => {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    return value as Record<string, unknown>;
  };
  const proof = object(options.evidence.taskBoardUiProof);
  if (!Array.isArray(proof.steps)) return;
  const last = object(proof.steps.at(-1));
  if (last.action !== 'mouseClick' || last.state !== 'attempted' ||
      last.label !== 'clear original clarification once') return;
  let canonicalClarification = 'unknown';
  let receiptCount: number | null = null, scannedReceipts: number | null = null;
  let receiptPhases: Record<string, number> | null = null;
  try {
    const created = object(validateCommandEntry(
      proof.createReceipt as Parameters<typeof validateCommandEntry>[0]
    ));
    assert.equal(created.phase, 'completed');
    assert.equal(created.principalId, 'TEST-human');
    assert.equal(object(created.command).operation, 'task.create');
    const binding = object(created.binding), taskId = object(created.effects).taskId;
    assert.equal(binding.teamName, 'test-desktop-backend');
    assert.ok(typeof binding.backendId === 'string' && binding.backendId.length > 0);
    assert.ok(typeof binding.teamId === 'string' && binding.teamId.length > 0);
    assert.ok(typeof taskId === 'string' && /^[a-f0-9-]{36}$/i.test(taskId));
    assert.equal(await realpath(options.root), options.root);
    assert.match(basename(options.root), /^TEST-desktop-backend-[A-Za-z0-9]+$/);
    const ownerRoot = join(options.root, 'hoststore/teams/test-desktop-backend/.host-owner');
    const commandRoot = join(ownerRoot, 'commands');
    const same = (a: BigIntStats, b: BigIntStats) =>
      a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink &&
      a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
    let budget = 1024 * 1024;
    const readJson = async (path: string): Promise<unknown> => {
      assert.equal(await realpath(path), path);
      const before = await lstat(path, { bigint: true });
      assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n);
      assert.ok(before.size >= 0n && before.size <= 64n * 1024n);
      const length = Number(before.size) + 1;
      assert.ok(length <= budget);
      budget -= length;
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        assert.ok(same(before, await file.stat({ bigint: true })));
        const bytes = Buffer.alloc(length);
        let offset = 0;
        while (offset < bytes.length) {
          const read = await file.read(bytes, offset, bytes.length - offset, offset);
          if (read.bytesRead === 0) break;
          offset += read.bytesRead;
        }
        assert.equal(offset, Number(before.size));
        assert.ok(same(before, await file.stat({ bigint: true })));
        assert.ok(same(before, await lstat(path, { bigint: true })));
        assert.equal(await realpath(path), path);
        return JSON.parse(bytes.subarray(0, offset).toString('utf8')) as unknown;
      } finally {
        await file.close();
      }
    };
    const task = object(await readJson(join(options.root, 'hoststore/tasks/test-desktop-backend', taskId + '.json')));
    assert.equal(task.id, taskId);
    if (Object.hasOwn(task, 'needsClarification')) {
      assert.ok(task.needsClarification === 'user' || task.needsClarification === 'lead');
      canonicalClarification = task.needsClarification;
    } else canonicalClarification = 'absent';
    assert.equal(await realpath(commandRoot), commandRoot);
    const directoryBefore = await lstat(commandRoot, { bigint: true });
    assert.ok(directoryBefore.isDirectory() && !directoryBefore.isSymbolicLink());
    const phases = { prepared: 0, applying: 0, completed: 0, rejected: 0, held: 0 };
    let walked = 0, scanned = 0, matching = 0;
    for await (const entry of await opendir(commandRoot)) {
      assert.ok(++walked <= 128);
      assert.ok(!entry.isSymbolicLink());
      if (!entry.name.endsWith('.json')) continue;
      assert.ok(entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name));
      const receipt = object(validateCommandEntry(
        await readJson(join(commandRoot, entry.name)) as Parameters<typeof validateCommandEntry>[0]
      ));
      assert.equal(basename(teamCommandPath(String(receipt.commandId))), entry.name);
      assert.deepEqual(receipt.binding, binding);
      scanned++;
      if (Object.hasOwn(receipt, 'family') || receipt.principalId !== created.principalId) continue;
      const command = object(receipt.command), payload = object(command.payload);
      if (command.operation !== 'task.clarification' || payload.taskId !== taskId || payload.value !== null) continue;
      assert.ok(typeof receipt.phase === 'string' && Object.hasOwn(phases, receipt.phase));
      phases[receipt.phase as keyof typeof phases]++;
      matching++;
    }
    assert.ok(same(directoryBefore, await lstat(commandRoot, { bigint: true })));
    assert.equal(await realpath(commandRoot), commandRoot);
    receiptCount = matching;
    scannedReceipts = scanned;
    receiptPhases = phases;
  } catch { /* Incomplete or replaced original evidence remains unknown, never an empty scan. */ }
  let observation: Record<string, unknown> = {
    diagnostic: 'taskboard-clarification', phase: 'clarification-clear',
    source: projectDesktopHarnessFailure(error, options.repo, desktopProofSources),
    canonicalClarification, receiptScanComplete: receiptCount !== null,
    scannedReceipts, receiptCount, receiptPhases,
  };
  if (Buffer.byteLength(JSON.stringify(observation)) > 4096)
    observation = { diagnostic: 'taskboard-clarification', unavailable: true };
  proof.clarificationFailure = observation;
  console.log(JSON.stringify(observation));
}

/** Existing flows can run together or qualify the remaining cross-Team workflow alone. */
export async function runDesktopOfflineTaskBoardUiSmoke(
  cdp: UiCdpPort,
  options: Parameters<typeof runDesktopTaskBoardUiSmoke>[1],
  mode: string
) {
  assert.ok(['task-board-ui', 'task-board-cross-team-ui', 'cross-team-ui'].includes(mode));
  if (mode === 'cross-team-ui') {
    await runDesktopCrossTeamUiSmoke(cdp, options);
    return;
  }
  try {
    await runDesktopTaskBoardUiSmoke(cdp, options);
  } catch (error) {
    try { await observeClarificationFailure(error, options); } catch { /* Keep the original failure and cleanup. */ }
    throw error;
  }
  if (mode === 'task-board-ui') {
    await runDesktopTaskNotificationUiSmoke(cdp, options);
    return;
  }
  await runDesktopTaskReviewCycleUiSmoke(cdp, options);
  await runDesktopTaskNotificationUiSmoke(cdp, options);
  await runDesktopCrossTeamUiSmoke(cdp, options);
  // UI composer is intentionally capped; this tests accepted large Host
  // comments through the existing Task detail after a cold renderer reload.
  assert.ok(options.seed.taskId && options.seed.subject, 'original TEST Task identity required');
  const steps: Record<string, unknown>[] = [];
  options.evidence.oversizedCommentUiProof = await runDesktopOversizedCommentUiSmoke(cdp, {
    root: options.root,
    handleId: options.handleId,
    taskId: options.seed.taskId,
    subject: options.seed.subject,
    assertOwnedRenderer: options.assertOwnedRenderer,
    step: (row) => { steps.push(row); },
  });
  options.evidence.oversizedCommentUiSteps = steps;
}
