import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChangeExtractorService } from '@main/services/team/ChangeExtractorService';
import { FileContentResolver } from '@main/services/team/FileContentResolver';
import { ReviewApplierService } from '@main/services/team/ReviewApplierService';
import { TaskChangeLedgerReader } from '@main/services/team/TaskChangeLedgerReader';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { buildPathChangeLabels } from '@renderer/components/team/review/pathChangeLabels';

import { materializeTaskChangeLedgerFixture } from './taskChangeLedgerFixtureUtils';

const TEAM_NAME = 'team-a';
const SUMMARY_OPTIONS = {
  owner: 'alice',
  status: 'completed',
  stateBucket: 'completed' as const,
  summaryOnly: true,
};

async function writeTaskFile(baseDir: string, taskId: string, projectPath: string): Promise<void> {
  const taskPath = path.join(baseDir, 'tasks', TEAM_NAME, `${taskId}.json`);
  await fs.mkdir(path.dirname(taskPath), { recursive: true });
  await fs.writeFile(
    taskPath,
    JSON.stringify(
      {
        id: taskId,
        owner: 'alice',
        status: 'completed',
        createdAt: '2026-03-01T09:55:00.000Z',
        updatedAt: '2026-03-01T10:10:00.000Z',
        projectPath,
        workIntervals: [
          { startedAt: '2026-03-01T10:00:00.000Z', completedAt: '2026-03-01T10:10:00.000Z' },
        ],
        historyEvents: [],
      },
      null,
      2
    ),
    'utf8'
  );
}

function createLedgerBackedChangeExtractorService(params: {
  projectDir: string;
  taskChangePresenceRepository?: {
    upsertEntry: ReturnType<typeof vi.fn>;
    deleteEntry?: ReturnType<typeof vi.fn>;
  };
  teamLogSourceTracker?: {
    ensureTracking: ReturnType<
      typeof vi.fn<
        () => Promise<{ projectFingerprint: string | null; logSourceGeneration: string | null }>
      >
    >;
  };
}) {
  const findLogFileRefsForTask = vi.fn(async () => {
    throw new Error('fallback log reconstruction should not run for ledger fixtures');
  });
  const computeTaskChanges = vi.fn(async () => {
    throw new Error('worker path should not run for ledger fixtures');
  });
  const service = new ChangeExtractorService(
    {
      getLogSourceWatchContext: vi.fn(async () => ({
        projectDir: params.projectDir,
        projectPath: params.projectDir,
      })),
      findLogFileRefsForTask,
      findMemberLogPaths: vi.fn(async () => []),
    } as any,
    {
      parseBoundaries: vi.fn(async () => {
        throw new Error('inline parser should not run for ledger fixtures');
      }),
    } as any,
    { getConfig: vi.fn(async () => ({ projectPath: params.projectDir })) } as any,
    undefined,
    {
      isAvailable: vi.fn(() => true),
      computeTaskChanges,
    } as any
  );

  if (params.taskChangePresenceRepository && params.teamLogSourceTracker) {
    service.setTaskChangePresenceServices(
      params.taskChangePresenceRepository as any,
      params.teamLogSourceTracker as any
    );
  }

  return { service, findLogFileRefsForTask, computeTaskChanges };
}

describe('task change ledger golden fixtures', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    setClaudeBasePathOverride(null);
    vi.restoreAllMocks();
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it('reads rename and copy fixtures as grouped ledger changes', async () => {
    const renameFixture = await materializeTaskChangeLedgerFixture('rename');
    const copyFixture = await materializeTaskChangeLedgerFixture('copy');
    cleanups.push(renameFixture.cleanup, copyFixture.cleanup);
    const reader = new TaskChangeLedgerReader();

    const rename = await reader.readTaskChanges({
      teamName: TEAM_NAME,
      taskId: renameFixture.manifest.taskId,
      projectDir: renameFixture.projectDir,
      projectPath: renameFixture.projectDir,
      includeDetails: false,
    });
    const copy = await reader.readTaskChanges({
      teamName: TEAM_NAME,
      taskId: copyFixture.manifest.taskId,
      projectDir: copyFixture.projectDir,
      projectPath: copyFixture.projectDir,
      includeDetails: false,
    });

    expect(rename?.files).toHaveLength(1);
    expect(rename?.files[0]?.changeKey).toBe('rename:src/old.ts->src/new.ts');
    expect(rename?.files[0]?.filePath).toBe(path.join(renameFixture.projectDir, 'src', 'new.ts'));
    expect(rename?.files[0]?.ledgerSummary?.relation).toEqual({
      kind: 'rename',
      oldPath: 'src/old.ts',
      newPath: 'src/new.ts',
    });

    expect(copy?.files).toHaveLength(1);
    expect(copy?.files[0]?.changeKey).toBe('copy:src/base.ts->src/copy.ts');
    expect(copy?.files[0]?.isNewFile).toBe(true);
    expect(copy?.files[0]?.filePath).toBe(path.join(copyFixture.projectDir, 'src', 'copy.ts'));
    expect(copy?.files[0]?.ledgerSummary?.relation).toEqual({
      kind: 'copy',
      oldPath: 'src/base.ts',
      newPath: 'src/copy.ts',
    });
  });

  it('projects service-read ledger rename and copy fixtures into UI relation labels', async () => {
    const renameFixture = await materializeTaskChangeLedgerFixture('rename');
    const copyFixture = await materializeTaskChangeLedgerFixture('copy');
    cleanups.push(renameFixture.cleanup, copyFixture.cleanup);
    const claudeBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-labels-ledger-'));
    cleanups.push(async () => {
      await fs.rm(claudeBaseDir, { recursive: true, force: true });
    });
    setClaudeBasePathOverride(claudeBaseDir);
    await writeTaskFile(claudeBaseDir, renameFixture.manifest.taskId, renameFixture.projectDir);
    await writeTaskFile(claudeBaseDir, copyFixture.manifest.taskId, copyFixture.projectDir);

    const renameService = createLedgerBackedChangeExtractorService({
      projectDir: renameFixture.projectDir,
    }).service;
    const copyService = createLedgerBackedChangeExtractorService({
      projectDir: copyFixture.projectDir,
    }).service;

    const rename = await renameService.getTaskChanges(
      TEAM_NAME,
      renameFixture.manifest.taskId,
      SUMMARY_OPTIONS
    );
    const copy = await copyService.getTaskChanges(
      TEAM_NAME,
      copyFixture.manifest.taskId,
      SUMMARY_OPTIONS
    );

    const renameFile = rename.files[0];
    const copyFile = copy.files[0];
    expect(renameFile?.filePath).toBe(path.join(renameFixture.projectDir, 'src', 'new.ts'));
    expect(copyFile?.filePath).toBe(path.join(copyFixture.projectDir, 'src', 'copy.ts'));
    expect(buildPathChangeLabels(rename.files, {})[renameFile!.filePath]).toEqual({
      kind: 'renamed',
      direction: 'from',
      otherPath: 'src/old.ts',
    });
    expect(buildPathChangeLabels(copy.files, {})[copyFile!.filePath]).toEqual({
      kind: 'copied',
      direction: 'from',
      otherPath: 'src/base.ts',
    });
  });

  it('returns warning-only notice fixtures without synthesizing fake file changes', async () => {
    const fixture = await materializeTaskChangeLedgerFixture('notices-only');
    cleanups.push(fixture.cleanup);
    const reader = new TaskChangeLedgerReader();

    const result = await reader.readTaskChanges({
      teamName: TEAM_NAME,
      taskId: fixture.manifest.taskId,
      projectDir: fixture.projectDir,
      projectPath: fixture.projectDir,
      includeDetails: true,
    });

    expect(result).not.toBeNull();
    expect(result?.files).toEqual([]);
    expect(result?.warnings).toContain(
      'Task change ledger skipped attribution because multiple task scopes were active.'
    );
  });

  it('falls back when bundle freshness is intentionally mismatched', async () => {
    const fixture = await materializeTaskChangeLedgerFixture('generation-mismatch');
    cleanups.push(fixture.cleanup);
    const reader = new TaskChangeLedgerReader();

    const result = await reader.readTaskChanges({
      teamName: TEAM_NAME,
      taskId: fixture.manifest.taskId,
      projectDir: fixture.projectDir,
      projectPath: fixture.projectDir,
      includeDetails: false,
    });

    expect(result?.files).toHaveLength(1);
    expect(result?.warnings).toContain('Task change summary fell back to journal reconstruction.');
  });

  it('uses journal tail hash, not only size and mtime, when freshness is missing', async () => {
    const fixture = await materializeTaskChangeLedgerFixture('v2-summary');
    cleanups.push(fixture.cleanup);
    const taskId = fixture.manifest.taskId;
    const eventPath = path.join(
      fixture.projectDir,
      '.board-task-changes',
      'events',
      `${encodeURIComponent(taskId)}.jsonl`
    );
    const freshnessSignalPath = path.join(
      fixture.projectDir,
      '.board-task-change-freshness',
      `${encodeURIComponent(taskId)}.json`
    );
    const originalStat = await fs.stat(eventPath);
    const raw = await fs.readFile(eventPath, 'utf8');
    const mutated = raw.replace(
      /"eventId":"([0-9a-f])([0-9a-f]+)"/,
      (_match, first: string, rest: string) => `"eventId":"${first === 'a' ? 'b' : 'a'}${rest}"`
    );
    expect(mutated).not.toBe(raw);
    expect(mutated.length).toBe(raw.length);
    await fs.writeFile(eventPath, mutated, 'utf8');
    await fs.utimes(eventPath, originalStat.atime, originalStat.mtime);
    await fs.unlink(freshnessSignalPath);

    const reader = new TaskChangeLedgerReader();
    const result = await reader.readTaskChanges({
      teamName: TEAM_NAME,
      taskId,
      projectDir: fixture.projectDir,
      projectPath: fixture.projectDir,
      includeDetails: false,
    });

    expect(result?.files).toHaveLength(1);
    expect(result?.warnings).toContain('Task change summary fell back to journal reconstruction.');
  });

  it('surfaces recovered-journal warnings from real recovered artifacts', async () => {
    const fixture = await materializeTaskChangeLedgerFixture('recovered-journal');
    cleanups.push(fixture.cleanup);
    const reader = new TaskChangeLedgerReader();

    const result = await reader.readTaskChanges({
      teamName: TEAM_NAME,
      taskId: fixture.manifest.taskId,
      projectDir: fixture.projectDir,
      projectPath: fixture.projectDir,
      includeDetails: false,
    });

    expect(result?.files).toHaveLength(1);
    expect(result?.warnings).toContain(
      'Task change ledger recovered from malformed journal lines.'
    );
  });

  it('keeps missing-blob fixture unavailable instead of synthesizing empty text', async () => {
    const fixture = await materializeTaskChangeLedgerFixture('missing-blob');
    cleanups.push(fixture.cleanup);
    const reader = new TaskChangeLedgerReader();
    const changeSet = await reader.readTaskChanges({
      teamName: TEAM_NAME,
      taskId: fixture.manifest.taskId,
      projectDir: fixture.projectDir,
      projectPath: fixture.projectDir,
      includeDetails: true,
    });
    const file = changeSet?.files[0];
    expect(file).toBeDefined();

    const resolver = new FileContentResolver({ findMemberLogPaths: vi.fn(async () => []) } as any);
    const resolved = await resolver.getFileContent(
      TEAM_NAME,
      'alice',
      file!.filePath,
      file!.snippets
    );

    expect(resolved.originalFullContent).toBeNull();
    expect(resolved.modifiedFullContent).toBe('export const missing = 2;\n');
    expect(resolved.contentSource).toBe('ledger-snapshot');
  });

  it('reads OpenCode snapshot upgrade fixtures as one full-text ledger row', async () => {
    const fixture = await materializeTaskChangeLedgerFixture('opencode-snapshot-upgrade');
    cleanups.push(fixture.cleanup);
    const reader = new TaskChangeLedgerReader();
    const changeSet = await reader.readTaskChanges({
      teamName: TEAM_NAME,
      taskId: fixture.manifest.taskId,
      projectDir: fixture.projectDir,
      projectPath: fixture.projectDir,
      includeDetails: true,
    });

    expect(changeSet?.files).toHaveLength(1);
    const file = changeSet!.files[0]!;
    expect(file.relativePath).toBe('src/snapshot-only.js');
    expect(file.ledgerSummary).toMatchObject({
      reviewability: 'full-text',
      contentAvailability: 'full-text',
    });
    expect(file.snippets).toHaveLength(1);
    const snippet = file.snippets[0]!;
    expect(snippet.toolName).toBe('Edit');
    expect(snippet.type).toBe('edit');
    expect(snippet.ledger).toMatchObject({
      source: 'ledger-snapshot',
      confidence: 'high',
      textAvailability: 'full-text',
      operation: 'modify',
    });
    expect(snippet.ledger?.originalFullContent).toBe('export const snapshot = 1;\n');
    expect(snippet.ledger?.modifiedFullContent).toBe('export const snapshot = 2;\n');

    const resolver = new FileContentResolver({ findMemberLogPaths: vi.fn(async () => []) } as any);
    const resolved = await resolver.getFileContent(
      TEAM_NAME,
      'bob',
      file.filePath,
      file.snippets
    );
    expect(resolved.originalFullContent).toBe('export const snapshot = 1;\n');
    expect(resolved.modifiedFullContent).toBe('export const snapshot = 2;\n');
    expect(resolved.contentSource).toBe('ledger-snapshot');
  });

  it('rejects grouped copy fixtures by deleting only the copied path', async () => {
    const fixture = await materializeTaskChangeLedgerFixture('copy');
    cleanups.push(fixture.cleanup);
    const reader = new TaskChangeLedgerReader();
    const changeSet = await reader.readTaskChanges({
      teamName: TEAM_NAME,
      taskId: fixture.manifest.taskId,
      projectDir: fixture.projectDir,
      projectPath: fixture.projectDir,
      includeDetails: true,
    });
    const file = changeSet?.files[0];
    expect(file).toBeDefined();
    const resolver = new FileContentResolver({ findMemberLogPaths: vi.fn(async () => []) } as any);
    const resolved = await resolver.getFileContent(
      TEAM_NAME,
      'alice',
      file!.filePath,
      file!.snippets
    );

    const service = new ReviewApplierService();
    const result = await service.applyReviewDecisions(
      {
        teamName: TEAM_NAME,
        decisions: [
          {
            filePath: file!.filePath,
            fileDecision: 'rejected',
            hunkDecisions: { 0: 'rejected' },
          },
        ],
      },
      new Map([
        [
          file!.filePath,
          {
            ...file!,
            ...resolved,
          },
        ],
      ])
    );

    expect(result).toMatchObject({ applied: 1, conflicts: 0 });
    await expect(fs.stat(path.join(fixture.projectDir, 'src', 'copy.ts'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      fs.readFile(path.join(fixture.projectDir, 'src', 'base.ts'), 'utf8')
    ).resolves.toBe('export const copied = true;\n');
  });

  it('rejects create fixtures by deleting the created path only when the ledger hash matches', async () => {
    const fixture = await materializeTaskChangeLedgerFixture('v2-summary');
    cleanups.push(fixture.cleanup);
    const reader = new TaskChangeLedgerReader();
    const changeSet = await reader.readTaskChanges({
      teamName: TEAM_NAME,
      taskId: fixture.manifest.taskId,
      projectDir: fixture.projectDir,
      projectPath: fixture.projectDir,
      includeDetails: true,
    });
    const file = changeSet?.files[0];
    expect(file).toBeDefined();
    const resolver = new FileContentResolver({ findMemberLogPaths: vi.fn(async () => []) } as any);
    const resolved = await resolver.getFileContent(
      TEAM_NAME,
      'alice',
      file!.filePath,
      file!.snippets
    );
    await fs.mkdir(path.dirname(file!.filePath), { recursive: true });
    await fs.writeFile(file!.filePath, resolved.modifiedFullContent ?? '', 'utf8');

    const service = new ReviewApplierService();
    const result = await service.applyReviewDecisions(
      {
        teamName: TEAM_NAME,
        decisions: [
          {
            filePath: file!.filePath,
            fileDecision: 'rejected',
            hunkDecisions: { 0: 'rejected' },
          },
        ],
      },
      new Map([
        [
          file!.filePath,
          {
            ...file!,
            ...resolved,
          },
        ],
      ])
    );

    expect(result).toMatchObject({ applied: 1, conflicts: 0 });
    await expect(fs.stat(file!.filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('blocks create fixture reject when the created path changed after ledger capture', async () => {
    const fixture = await materializeTaskChangeLedgerFixture('v2-summary');
    cleanups.push(fixture.cleanup);
    const reader = new TaskChangeLedgerReader();
    const changeSet = await reader.readTaskChanges({
      teamName: TEAM_NAME,
      taskId: fixture.manifest.taskId,
      projectDir: fixture.projectDir,
      projectPath: fixture.projectDir,
      includeDetails: true,
    });
    const file = changeSet?.files[0];
    expect(file).toBeDefined();
    const resolver = new FileContentResolver({ findMemberLogPaths: vi.fn(async () => []) } as any);
    const resolved = await resolver.getFileContent(
      TEAM_NAME,
      'alice',
      file!.filePath,
      file!.snippets
    );
    await fs.mkdir(path.dirname(file!.filePath), { recursive: true });
    await fs.writeFile(file!.filePath, 'external edit\n', 'utf8');

    const service = new ReviewApplierService();
    const result = await service.applyReviewDecisions(
      {
        teamName: TEAM_NAME,
        decisions: [
          {
            filePath: file!.filePath,
            fileDecision: 'rejected',
            hunkDecisions: { 0: 'rejected' },
          },
        ],
      },
      new Map([
        [
          file!.filePath,
          {
            ...file!,
            ...resolved,
          },
        ],
      ])
    );

    expect(result.applied).toBe(0);
    expect(result.conflicts).toBe(1);
    expect(result.errors[0]?.code).toBe('conflict');
    await expect(fs.readFile(file!.filePath, 'utf8')).resolves.toBe('external edit\n');
  });

  it('rejects grouped rename fixtures by restoring the old path and removing the new path', async () => {
    const fixture = await materializeTaskChangeLedgerFixture('rename');
    cleanups.push(fixture.cleanup);
    const reader = new TaskChangeLedgerReader();
    const changeSet = await reader.readTaskChanges({
      teamName: TEAM_NAME,
      taskId: fixture.manifest.taskId,
      projectDir: fixture.projectDir,
      projectPath: fixture.projectDir,
      includeDetails: true,
    });
    const file = changeSet?.files[0];
    expect(file).toBeDefined();
    const resolver = new FileContentResolver({ findMemberLogPaths: vi.fn(async () => []) } as any);
    const resolved = await resolver.getFileContent(
      TEAM_NAME,
      'alice',
      file!.filePath,
      file!.snippets
    );

    const service = new ReviewApplierService();
    const result = await service.applyReviewDecisions(
      {
        teamName: TEAM_NAME,
        decisions: [
          {
            filePath: file!.filePath,
            fileDecision: 'rejected',
            hunkDecisions: { 0: 'rejected' },
          },
        ],
      },
      new Map([
        [
          file!.filePath,
          {
            ...file!,
            ...resolved,
          },
        ],
      ])
    );

    expect(result).toMatchObject({ applied: 1, conflicts: 0 });
    await expect(fs.stat(path.join(fixture.projectDir, 'src', 'new.ts'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      fs.readFile(path.join(fixture.projectDir, 'src', 'old.ts'), 'utf8')
    ).resolves.toBe('export const renamed = true;\n');
  });

  it('blocks grouped rename reject when the new path changed after ledger capture', async () => {
    const fixture = await materializeTaskChangeLedgerFixture('rename');
    cleanups.push(fixture.cleanup);
    const reader = new TaskChangeLedgerReader();
    const changeSet = await reader.readTaskChanges({
      teamName: TEAM_NAME,
      taskId: fixture.manifest.taskId,
      projectDir: fixture.projectDir,
      projectPath: fixture.projectDir,
      includeDetails: true,
    });
    const file = changeSet?.files[0];
    expect(file).toBeDefined();
    const resolver = new FileContentResolver({ findMemberLogPaths: vi.fn(async () => []) } as any);
    const resolved = await resolver.getFileContent(
      TEAM_NAME,
      'alice',
      file!.filePath,
      file!.snippets
    );
    await fs.writeFile(path.join(fixture.projectDir, 'src', 'new.ts'), 'external edit\n', 'utf8');

    const service = new ReviewApplierService();
    const result = await service.applyReviewDecisions(
      {
        teamName: TEAM_NAME,
        decisions: [
          {
            filePath: file!.filePath,
            fileDecision: 'rejected',
            hunkDecisions: { 0: 'rejected' },
          },
        ],
      },
      new Map([
        [
          file!.filePath,
          {
            ...file!,
            ...resolved,
          },
        ],
      ])
    );

    expect(result.applied).toBe(0);
    expect(result.conflicts).toBe(1);
    expect(result.errors[0]?.code).toBe('conflict');
    await expect(
      fs.readFile(path.join(fixture.projectDir, 'src', 'new.ts'), 'utf8')
    ).resolves.toBe('external edit\n');
    await expect(fs.stat(path.join(fixture.projectDir, 'src', 'old.ts'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('requires manual review when a fixture is missing original ledger text', async () => {
    const fixture = await materializeTaskChangeLedgerFixture('missing-blob');
    cleanups.push(fixture.cleanup);
    const reader = new TaskChangeLedgerReader();
    const changeSet = await reader.readTaskChanges({
      teamName: TEAM_NAME,
      taskId: fixture.manifest.taskId,
      projectDir: fixture.projectDir,
      projectPath: fixture.projectDir,
      includeDetails: true,
    });
    const file = changeSet?.files[0];
    expect(file).toBeDefined();
    const resolver = new FileContentResolver({ findMemberLogPaths: vi.fn(async () => []) } as any);
    const resolved = await resolver.getFileContent(
      TEAM_NAME,
      'alice',
      file!.filePath,
      file!.snippets
    );

    const service = new ReviewApplierService();
    const result = await service.applyReviewDecisions(
      {
        teamName: TEAM_NAME,
        decisions: [
          {
            filePath: file!.filePath,
            fileDecision: 'rejected',
            hunkDecisions: { 0: 'rejected' },
          },
        ],
      },
      new Map([
        [
          file!.filePath,
          {
            ...file!,
            ...resolved,
          },
        ],
      ])
    );

    expect(result.applied).toBe(0);
    expect(result.errors[0]?.code).toBe('manual-review-required');
  });

  it('requires manual review for binary metadata-only fixtures and keeps the binary file intact', async () => {
    const fixture = await materializeTaskChangeLedgerFixture('binary');
    cleanups.push(fixture.cleanup);
    const reader = new TaskChangeLedgerReader();
    const changeSet = await reader.readTaskChanges({
      teamName: TEAM_NAME,
      taskId: fixture.manifest.taskId,
      projectDir: fixture.projectDir,
      projectPath: fixture.projectDir,
      includeDetails: true,
    });
    const file = changeSet?.files[0];
    expect(file).toBeDefined();
    const before = await fs.readFile(file!.filePath);
    const resolver = new FileContentResolver({ findMemberLogPaths: vi.fn(async () => []) } as any);
    const resolved = await resolver.getFileContent(
      TEAM_NAME,
      'alice',
      file!.filePath,
      file!.snippets
    );
    expect(file!.snippets[0]?.ledger?.modifiedFullContent).toBeNull();
    expect(resolved.originalFullContent).toBeNull();
    expect(resolved.modifiedFullContent).toBeNull();
    expect(resolved.contentSource).toBe('unavailable');

    const service = new ReviewApplierService();
    const result = await service.applyReviewDecisions(
      {
        teamName: TEAM_NAME,
        decisions: [
          {
            filePath: file!.filePath,
            fileDecision: 'rejected',
            hunkDecisions: { 0: 'rejected' },
          },
        ],
      },
      new Map([
        [
          file!.filePath,
          {
            ...file!,
            ...resolved,
          },
        ],
      ])
    );

    expect(result.applied).toBe(0);
    expect(result.errors[0]?.code).toBe('manual-review-required');
    await expect(fs.readFile(file!.filePath)).resolves.toEqual(before);
  });

  it('uses ledger fixtures as the primary source in ChangeExtractorService', async () => {
    const fixture = await materializeTaskChangeLedgerFixture('generation-mismatch');
    cleanups.push(fixture.cleanup);
    const claudeBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-ledger-'));
    cleanups.push(async () => {
      await fs.rm(claudeBaseDir, { recursive: true, force: true });
    });
    setClaudeBasePathOverride(claudeBaseDir);
    await writeTaskFile(claudeBaseDir, fixture.manifest.taskId, fixture.projectDir);

    const { service, findLogFileRefsForTask, computeTaskChanges } =
      createLedgerBackedChangeExtractorService({
        projectDir: fixture.projectDir,
      });

    const result = await service.getTaskChanges(
      TEAM_NAME,
      fixture.manifest.taskId,
      SUMMARY_OPTIONS
    );

    expect(result.files).toHaveLength(1);
    expect(result.warnings).toContain('Task change summary fell back to journal reconstruction.');
    expect(findLogFileRefsForTask).not.toHaveBeenCalled();
    expect(computeTaskChanges).not.toHaveBeenCalled();
  });

  it('clears cached presence from diagnostic-only warning ledger fixtures', async () => {
    const fixture = await materializeTaskChangeLedgerFixture('notices-only');
    cleanups.push(fixture.cleanup);
    const claudeBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'change-extractor-presence-'));
    cleanups.push(async () => {
      await fs.rm(claudeBaseDir, { recursive: true, force: true });
    });
    setClaudeBasePathOverride(claudeBaseDir);
    await writeTaskFile(claudeBaseDir, fixture.manifest.taskId, fixture.projectDir);

    const upsertEntry = vi.fn(() => Promise.resolve(undefined));
    const deleteEntry = vi.fn(() => Promise.resolve(undefined));
    const ensureTracking = vi.fn(() =>
      Promise.resolve({
        projectFingerprint: 'fixture-project-fingerprint',
        logSourceGeneration: 'fixture-log-generation',
      })
    );
    const { service, findLogFileRefsForTask } = createLedgerBackedChangeExtractorService({
      projectDir: fixture.projectDir,
      taskChangePresenceRepository: { upsertEntry, deleteEntry },
      teamLogSourceTracker: { ensureTracking },
    });

    const result = await service.getTaskChanges(
      TEAM_NAME,
      fixture.manifest.taskId,
      SUMMARY_OPTIONS
    );

    expect(result.files).toEqual([]);
    expect(result.warnings).toContain(
      'Task change ledger skipped attribution because multiple task scopes were active.'
    );
    expect(findLogFileRefsForTask).not.toHaveBeenCalled();
    expect(upsertEntry).not.toHaveBeenCalled();
    expect(deleteEntry).toHaveBeenCalledWith(TEAM_NAME, fixture.manifest.taskId);
  });
});
