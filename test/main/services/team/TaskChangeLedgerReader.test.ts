import { createHash } from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';

import { TaskChangeLedgerReader } from '@main/services/team/TaskChangeLedgerReader';

const TASK_ID = 'task-1';

function safeTaskIdSegment(taskId: string): string {
  return `task-id-${createHash('sha256').update(taskId).digest('hex').slice(0, 32)}`;
}

function sha(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('TaskChangeLedgerReader', () => {
  let tmpDir: string | null = null;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('returns warning-only notice bundles even when no file events exist', async () => {
    tmpDir = await makeLedgerBundle({
      events: [],
      notices: [
        {
          schemaVersion: 1,
          noticeId: 'notice-1',
          taskId: TASK_ID,
          taskRef: TASK_ID,
          taskRefKind: 'canonical',
          phase: 'work',
          executionSeq: 1,
          sessionId: 'session-1',
          toolUseId: 'tool-1',
          timestamp: '2026-03-01T10:00:00.000Z',
          severity: 'warning',
          message:
            'Task change ledger skipped attribution because multiple task scopes were active.',
        },
      ],
    });

    const reader = new TaskChangeLedgerReader();
    const result = await reader.readTaskChanges({
      teamName: 'team',
      taskId: TASK_ID,
      projectDir: tmpDir,
      includeDetails: true,
    });

    expect(result).not.toBeNull();
    expect(result?.files).toEqual([]);
    expect(result?.warnings).toContain(
      'Task change ledger skipped attribution because multiple task scopes were active.'
    );
    expect(result?.scope.toolUseIds).toEqual(['tool-1']);
  });

  it('reads ledger artifacts stored under Windows-safe task id segments', async () => {
    tmpDir = await fsTempDir();
    const taskId = 'CON';
    const bundleDir = path.join(tmpDir, '.board-task-changes', 'bundles');
    await mkdir(bundleDir, { recursive: true });
    await writeFile(
      path.join(bundleDir, `${safeTaskIdSegment(taskId)}.json`),
      JSON.stringify({
        schemaVersion: 1,
        source: 'task-change-ledger',
        taskId,
        generatedAt: '2026-03-01T10:00:00.000Z',
        eventCount: 0,
        files: [],
        totalLinesAdded: 0,
        totalLinesRemoved: 0,
        totalFiles: 0,
        confidence: 'high',
        warnings: ['reserved segment safe path'],
        events: [],
      }),
      'utf8'
    );

    const reader = new TaskChangeLedgerReader();
    const result = await reader.readTaskChanges({
      teamName: 'team',
      taskId,
      projectDir: tmpDir,
      includeDetails: true,
    });

    expect(result?.warnings).toContain('reserved segment safe path');
  });

  it('reads ledger artifacts stored under hashed long task id segments', async () => {
    tmpDir = await fsTempDir();
    const taskId = `task-${'x'.repeat(180)}`;
    const bundleDir = path.join(tmpDir, '.board-task-changes', 'bundles');
    await mkdir(bundleDir, { recursive: true });
    await writeFile(
      path.join(bundleDir, `${safeTaskIdSegment(taskId)}.json`),
      JSON.stringify({
        schemaVersion: 1,
        source: 'task-change-ledger',
        taskId,
        generatedAt: '2026-03-01T10:00:00.000Z',
        eventCount: 0,
        files: [],
        totalLinesAdded: 0,
        totalLinesRemoved: 0,
        totalFiles: 0,
        confidence: 'high',
        warnings: ['long task id safe path'],
        events: [],
      }),
      'utf8'
    );

    const reader = new TaskChangeLedgerReader();
    const result = await reader.readTaskChanges({
      teamName: 'team',
      taskId,
      projectDir: tmpDir,
      includeDetails: true,
    });

    expect(result?.warnings).toContain('long task id safe path');
  });

  it('maps ledger state and rename relation into snippets', async () => {
    tmpDir = await makeLedgerBundle({
      events: [
        {
          schemaVersion: 1,
          eventId: 'event-1',
          taskId: TASK_ID,
          taskRef: TASK_ID,
          taskRefKind: 'canonical',
          phase: 'work',
          executionSeq: 1,
          sessionId: 'session-1',
          toolUseId: 'tool-1',
          source: 'shell_snapshot',
          operation: 'modify',
          confidence: 'high',
          workspaceRoot: '/repo',
          filePath: '/repo/src/new.ts',
          relativePath: 'src/new.ts',
          timestamp: '2026-03-01T10:00:00.000Z',
          toolStatus: 'succeeded',
          before: null,
          after: null,
          beforeState: { exists: true, unavailableReason: 'binary file' },
          afterState: { exists: true, unavailableReason: 'binary file' },
          relation: { kind: 'rename', oldPath: 'src/old.ts', newPath: 'src/new.ts' },
          linesAdded: 0,
          linesRemoved: 0,
        },
      ],
    });

    const reader = new TaskChangeLedgerReader();
    const result = await reader.readTaskChanges({
      teamName: 'team',
      taskId: TASK_ID,
      projectDir: tmpDir,
      projectPath: '/repo',
      includeDetails: true,
    });

    const snippet = result?.files[0]?.snippets[0];
    expect(snippet?.ledger?.beforeState?.unavailableReason).toBe('binary file');
    expect(snippet?.ledger?.relation).toEqual({
      kind: 'rename',
      oldPath: 'src/old.ts',
      newPath: 'src/new.ts',
    });
    expect(result?.files[0]?.relativePath).toBe('src/new.ts');
  });

  it('maps OpenCode toolpart sources into normal review snippet semantics', async () => {
    tmpDir = await makeLedgerBundle({
      events: [
        {
          schemaVersion: 1,
          eventId: 'event-write',
          taskId: TASK_ID,
          taskRef: TASK_ID,
          taskRefKind: 'canonical',
          phase: 'work',
          executionSeq: 1,
          sessionId: 'opencode-session-1',
          memberName: 'bob',
          toolUseId: 'part-write',
          source: 'opencode_toolpart_write',
          operation: 'create',
          confidence: 'exact',
          workspaceRoot: '/repo',
          filePath: '/repo/src/new.ts',
          relativePath: 'src/new.ts',
          timestamp: '2026-03-01T10:00:00.000Z',
          toolStatus: 'succeeded',
          before: null,
          after: null,
          oldString: '',
          newString: 'export const value = 1;\n',
          linesAdded: 1,
          linesRemoved: 0,
        },
        {
          schemaVersion: 1,
          eventId: 'event-edit',
          taskId: TASK_ID,
          taskRef: TASK_ID,
          taskRefKind: 'canonical',
          phase: 'work',
          executionSeq: 2,
          sessionId: 'opencode-session-1',
          memberName: 'bob',
          toolUseId: 'part-edit',
          source: 'opencode_toolpart_edit',
          operation: 'modify',
          confidence: 'exact',
          workspaceRoot: '/repo',
          filePath: '/repo/src/new.ts',
          relativePath: 'src/new.ts',
          timestamp: '2026-03-01T10:01:00.000Z',
          toolStatus: 'succeeded',
          before: null,
          after: null,
          oldString: 'value = 1',
          newString: 'value = 2',
          linesAdded: 1,
          linesRemoved: 1,
        },
      ],
    });

    const reader = new TaskChangeLedgerReader();
    const result = await reader.readTaskChanges({
      teamName: 'team',
      taskId: TASK_ID,
      projectDir: tmpDir,
      projectPath: '/repo',
      includeDetails: true,
    });

    const snippets = result?.files[0]?.snippets ?? [];
    expect(snippets.map((snippet) => snippet.toolName)).toEqual(['Write', 'Edit']);
    expect(snippets.map((snippet) => snippet.type)).toEqual(['write-new', 'edit']);
  });

  it('groups rename relations in summary-only bundles without losing absolute paths', async () => {
    const relation = { kind: 'rename', oldPath: 'src/old.ts', newPath: 'src/new.ts' };
    tmpDir = await makeLedgerBundle({
      events: [
        {
          schemaVersion: 1,
          eventId: 'event-old',
          taskId: TASK_ID,
          taskRef: TASK_ID,
          taskRefKind: 'canonical',
          phase: 'work',
          executionSeq: 1,
          sessionId: 'session-1',
          toolUseId: 'tool-1',
          source: 'shell_snapshot',
          operation: 'delete',
          confidence: 'high',
          workspaceRoot: '/repo',
          filePath: '/repo/src/old.ts',
          relativePath: 'src/old.ts',
          timestamp: '2026-03-01T10:00:00.000Z',
          toolStatus: 'succeeded',
          before: null,
          after: null,
          relation,
          linesAdded: 0,
          linesRemoved: 2,
        },
        {
          schemaVersion: 1,
          eventId: 'event-new',
          taskId: TASK_ID,
          taskRef: TASK_ID,
          taskRefKind: 'canonical',
          phase: 'work',
          executionSeq: 1,
          sessionId: 'session-1',
          toolUseId: 'tool-1',
          source: 'shell_snapshot',
          operation: 'create',
          confidence: 'high',
          workspaceRoot: '/repo',
          filePath: '/repo/src/new.ts',
          relativePath: 'src/new.ts',
          timestamp: '2026-03-01T10:00:01.000Z',
          toolStatus: 'succeeded',
          before: null,
          after: null,
          relation,
          linesAdded: 3,
          linesRemoved: 0,
        },
      ],
    });

    const reader = new TaskChangeLedgerReader();
    const result = await reader.readTaskChanges({
      teamName: 'team',
      taskId: TASK_ID,
      projectDir: tmpDir,
      projectPath: '/repo',
      includeDetails: false,
    });

    expect(result?.files).toHaveLength(1);
    expect(result?.files[0]?.filePath).toBe('/repo/src/new.ts');
    expect(result?.files[0]?.relativePath).toBe('src/new.ts');
    expect(result?.files[0]?.isNewFile).toBe(false);
    expect(result?.files[0]?.linesAdded).toBe(3);
    expect(result?.files[0]?.linesRemoved).toBe(2);
  });

  it('resolves Windows rename relation paths case-insensitively in legacy fallback grouping', async () => {
    const relation = { kind: 'rename', oldPath: 'src/OLD.ts', newPath: 'src/NEW.ts' };
    tmpDir = await makeLedgerBundle({
      events: [
        {
          schemaVersion: 1,
          eventId: 'event-old',
          taskId: TASK_ID,
          taskRef: TASK_ID,
          taskRefKind: 'canonical',
          phase: 'work',
          executionSeq: 1,
          sessionId: 'session-1',
          toolUseId: 'tool-1',
          source: 'shell_snapshot',
          operation: 'delete',
          confidence: 'high',
          workspaceRoot: 'C:\\Repo',
          filePath: 'C:\\Repo\\SRC\\Old.ts',
          relativePath: 'SRC\\Old.ts',
          timestamp: '2026-03-01T10:00:00.000Z',
          toolStatus: 'succeeded',
          before: null,
          after: null,
          relation,
          linesAdded: 0,
          linesRemoved: 2,
        },
      ],
    });

    const reader = new TaskChangeLedgerReader();
    const result = await reader.readTaskChanges({
      teamName: 'team',
      taskId: TASK_ID,
      projectDir: tmpDir,
      projectPath: 'C:\\Repo',
      includeDetails: false,
    });

    expect(result?.files).toHaveLength(1);
    expect(result?.files[0]?.filePath.replace(/\\/g, '/')).toBe('C:/Repo/src/NEW.ts');
    expect(result?.files[0]?.ledgerSummary?.relation).toEqual(relation);
  });

  it('does not synthesize rename display paths from unsafe suffix matches', async () => {
    const relation = { kind: 'rename', oldPath: 'new.ts', newPath: 'old.ts' };
    tmpDir = await makeLedgerBundle({
      events: [
        {
          schemaVersion: 1,
          eventId: 'event-old',
          taskId: TASK_ID,
          taskRef: TASK_ID,
          taskRefKind: 'canonical',
          phase: 'work',
          executionSeq: 1,
          sessionId: 'session-1',
          toolUseId: 'tool-1',
          source: 'shell_snapshot',
          operation: 'delete',
          confidence: 'high',
          workspaceRoot: 'C:\\Repo',
          filePath: 'C:\\Repo\\src\\renew.ts',
          relativePath: 'src\\renew.ts',
          timestamp: '2026-03-01T10:00:00.000Z',
          toolStatus: 'succeeded',
          before: null,
          after: null,
          relation,
          linesAdded: 0,
          linesRemoved: 1,
        },
      ],
    });

    const reader = new TaskChangeLedgerReader();
    const result = await reader.readTaskChanges({
      teamName: 'team',
      taskId: TASK_ID,
      projectDir: tmpDir,
      projectPath: 'C:\\Repo',
      includeDetails: false,
    });

    expect(result?.files).toHaveLength(1);
    expect(result?.files[0]?.filePath.replace(/\\/g, '/')).toBe('C:/Repo/src/renew.ts');
  });

  it('does not mark delete-then-create lifecycle on an existing path as a new file', async () => {
    const filePath = '/repo/src/replaced.ts';
    const original = 'export const value = 1;\n';
    const modified = 'export const value = 2;\n';
    tmpDir = await makeLedgerBundle({
      events: [
        {
          schemaVersion: 1,
          eventId: 'event-delete',
          taskId: TASK_ID,
          taskRef: TASK_ID,
          taskRefKind: 'canonical',
          phase: 'work',
          executionSeq: 1,
          sessionId: 'session-1',
          toolUseId: 'tool-1',
          source: 'shell_snapshot',
          operation: 'delete',
          confidence: 'high',
          workspaceRoot: '/repo',
          filePath,
          relativePath: 'src/replaced.ts',
          timestamp: '2026-03-01T10:00:00.000Z',
          toolStatus: 'succeeded',
          before: null,
          after: null,
          oldString: original,
          newString: '',
          beforeState: { exists: true, sha256: sha(original) },
          afterState: { exists: false },
          linesAdded: 0,
          linesRemoved: 1,
        },
        {
          schemaVersion: 1,
          eventId: 'event-create',
          taskId: TASK_ID,
          taskRef: TASK_ID,
          taskRefKind: 'canonical',
          phase: 'work',
          executionSeq: 2,
          sessionId: 'session-1',
          toolUseId: 'tool-2',
          source: 'shell_snapshot',
          operation: 'create',
          confidence: 'high',
          workspaceRoot: '/repo',
          filePath,
          relativePath: 'src/replaced.ts',
          timestamp: '2026-03-01T10:01:00.000Z',
          toolStatus: 'succeeded',
          before: null,
          after: null,
          oldString: '',
          newString: modified,
          beforeState: { exists: false },
          afterState: { exists: true, sha256: sha(modified) },
          linesAdded: 1,
          linesRemoved: 0,
        },
      ],
    });

    const reader = new TaskChangeLedgerReader();
    const result = await reader.readTaskChanges({
      teamName: 'team',
      taskId: TASK_ID,
      projectDir: tmpDir,
      projectPath: '/repo',
      includeDetails: true,
    });

    expect(result?.files).toHaveLength(1);
    expect(result?.files[0]?.filePath).toBe(filePath);
    expect(result?.files[0]?.isNewFile).toBe(false);
  });

  it('preserves v2 worktree metadata from centralized ledger summaries', async () => {
    tmpDir = await fsTempDir();
    const bundleDir = path.join(tmpDir, '.board-task-changes', 'bundles');
    await mkdir(bundleDir, { recursive: true });
    await writeFile(
      path.join(bundleDir, `${encodeURIComponent(TASK_ID)}.json`),
      JSON.stringify({
        schemaVersion: 2,
        source: 'task-change-ledger',
        bundleKind: 'summary',
        taskId: TASK_ID,
        generatedAt: '2026-03-01T10:00:00.000Z',
        journalStamp: {},
        integrity: 'ok',
        eventCount: 1,
        noticeCount: 0,
        scope: {
          confidence: { tier: 1, label: 'high', reason: 'bundle' },
          memberName: 'alice',
          agentIds: ['alice@team'],
          startTimestamp: '2026-03-01T10:00:00.000Z',
          endTimestamp: '2026-03-01T10:00:00.000Z',
          toolUseIds: ['tool-1'],
          toolUseCount: 1,
          phaseSet: ['work'],
          visibleFileCount: 1,
          contributors: [],
          worktreePaths: ['/repo/.claude/worktrees/team-atlas-alice-12345678'],
          worktreeBranches: ['worktree-team-atlas-alice-12345678'],
          baseWorkspaceRoots: ['/repo'],
          dirtyLeaderWarnings: ['Leader workspace had uncommitted changes.'],
        },
        files: [
          {
            changeKey: 'path:/repo/.claude/worktrees/team-atlas-alice-12345678/src/a.ts',
            filePath: '/repo/.claude/worktrees/team-atlas-alice-12345678/src/a.ts',
            relativePath: 'src/a.ts',
            linesAdded: 1,
            linesRemoved: 0,
            diffStatKnown: true,
            eventCount: 1,
            firstTimestamp: '2026-03-01T10:00:00.000Z',
            lastTimestamp: '2026-03-01T10:00:00.000Z',
            latestOperation: 'modify',
            createdInTask: false,
            deletedInTask: false,
            latestBeforeHash: null,
            latestAfterHash: null,
            contentAvailability: 'full-text',
            reviewability: 'full-text',
            agentIds: ['alice@team'],
            worktreePath: '/repo/.claude/worktrees/team-atlas-alice-12345678',
            worktreeBranch: 'worktree-team-atlas-alice-12345678',
            baseWorkspaceRoot: '/repo',
            dirtyLeaderWarning: 'Leader workspace had uncommitted changes.',
          },
        ],
        totalLinesAdded: 1,
        totalLinesRemoved: 0,
        diffStatCompleteness: 'complete',
        totalFiles: 1,
        confidence: 'high',
        warningCount: 0,
        warnings: [],
      }),
      'utf8'
    );

    const reader = new TaskChangeLedgerReader();
    const result = await reader.readTaskChanges({
      teamName: 'team',
      taskId: TASK_ID,
      projectDir: tmpDir,
      projectPath: '/repo',
      includeDetails: false,
    });

    expect(result?.scope.worktreePaths).toEqual([
      '/repo/.claude/worktrees/team-atlas-alice-12345678',
    ]);
    expect(result?.files[0]?.ledgerSummary?.worktreePath).toBe(
      '/repo/.claude/worktrees/team-atlas-alice-12345678'
    );
    expect(result?.files[0]?.ledgerSummary?.worktreeBranch).toBe(
      'worktree-team-atlas-alice-12345678'
    );
    expect(result?.files[0]?.filePath).toBe(
      '/repo/.claude/worktrees/team-atlas-alice-12345678/src/a.ts'
    );
  });

  it('keeps identical relative rename relations isolated by worktree path', async () => {
    tmpDir = await fsTempDir();
    const bundleDir = path.join(tmpDir, '.board-task-changes', 'bundles');
    await mkdir(bundleDir, { recursive: true });
    await writeFile(
      path.join(bundleDir, `${encodeURIComponent(TASK_ID)}.json`),
      JSON.stringify({
        schemaVersion: 2,
        source: 'task-change-ledger',
        bundleKind: 'summary',
        taskId: TASK_ID,
        generatedAt: '2026-03-01T10:00:00.000Z',
        journalStamp: {},
        integrity: 'ok',
        eventCount: 2,
        noticeCount: 0,
        scope: {
          confidence: { tier: 1, label: 'high', reason: 'bundle' },
          memberName: 'alice',
          agentIds: ['alice@team', 'bob@team'],
          startTimestamp: '2026-03-01T10:00:00.000Z',
          endTimestamp: '2026-03-01T10:01:00.000Z',
          toolUseIds: ['tool-1', 'tool-2'],
          toolUseCount: 2,
          phaseSet: ['work'],
          visibleFileCount: 2,
          contributors: [],
          worktreePaths: ['/repo/.claude/worktrees/team-a', '/repo/.claude/worktrees/team-b'],
        },
        files: [
          {
            changeKey: 'rename:/repo/.claude/worktrees/team-a:src/old.ts->src/new.ts',
            filePath: '/repo/.claude/worktrees/team-a/src/new.ts',
            relativePath: 'src/new.ts',
            displayPath: 'src/new.ts',
            linesAdded: 0,
            linesRemoved: 0,
            diffStatKnown: true,
            eventCount: 1,
            firstTimestamp: '2026-03-01T10:00:00.000Z',
            lastTimestamp: '2026-03-01T10:00:00.000Z',
            latestOperation: 'modify',
            createdInTask: false,
            deletedInTask: false,
            latestBeforeHash: null,
            latestAfterHash: null,
            contentAvailability: 'full-text',
            reviewability: 'full-text',
            agentIds: ['alice@team'],
            relation: { kind: 'rename', oldPath: 'src/old.ts', newPath: 'src/new.ts' },
            worktreePath: '/repo/.claude/worktrees/team-a',
          },
          {
            changeKey: 'rename:/repo/.claude/worktrees/team-b:src/old.ts->src/new.ts',
            filePath: '/repo/.claude/worktrees/team-b/src/new.ts',
            relativePath: 'src/new.ts',
            displayPath: 'src/new.ts',
            linesAdded: 0,
            linesRemoved: 0,
            diffStatKnown: true,
            eventCount: 1,
            firstTimestamp: '2026-03-01T10:01:00.000Z',
            lastTimestamp: '2026-03-01T10:01:00.000Z',
            latestOperation: 'modify',
            createdInTask: false,
            deletedInTask: false,
            latestBeforeHash: null,
            latestAfterHash: null,
            contentAvailability: 'full-text',
            reviewability: 'full-text',
            agentIds: ['bob@team'],
            relation: { kind: 'rename', oldPath: 'src/old.ts', newPath: 'src/new.ts' },
            worktreePath: '/repo/.claude/worktrees/team-b',
          },
        ],
        totalLinesAdded: 0,
        totalLinesRemoved: 0,
        diffStatCompleteness: 'complete',
        totalFiles: 2,
        confidence: 'high',
        warningCount: 0,
        warnings: [],
      }),
      'utf8'
    );

    const reader = new TaskChangeLedgerReader();
    const result = await reader.readTaskChanges({
      teamName: 'team',
      taskId: TASK_ID,
      projectDir: tmpDir,
      projectPath: '/repo',
      includeDetails: false,
    });

    expect(result?.files).toHaveLength(2);
    expect(new Set(result?.files.map((file) => file.changeKey))).toEqual(
      new Set([
        'rename:/repo/.claude/worktrees/team-a:src/old.ts->src/new.ts',
        'rename:/repo/.claude/worktrees/team-b:src/old.ts->src/new.ts',
      ])
    );
  });

  it('keeps worktree relation keys isolated when rebuilding directly from journal events', async () => {
    tmpDir = await fsTempDir();
    const eventsDir = path.join(tmpDir, '.board-task-changes', 'events');
    await mkdir(eventsDir, { recursive: true });
    await writeFile(
      path.join(eventsDir, `${encodeURIComponent(TASK_ID)}.jsonl`),
      [
        {
          schemaVersion: 1,
          eventId: 'event-a',
          taskId: TASK_ID,
          taskRef: TASK_ID,
          taskRefKind: 'canonical',
          phase: 'work',
          executionSeq: 1,
          sessionId: 'session-a',
          agentId: 'alice@team',
          toolUseId: 'tool-a',
          source: 'shell_snapshot',
          operation: 'modify',
          confidence: 'high',
          workspaceRoot: '/repo/.claude/worktrees/team-a',
          worktreePath: '/repo/.claude/worktrees/team-a',
          filePath: '/repo/.claude/worktrees/team-a/src/new.ts',
          relativePath: 'src/new.ts',
          timestamp: '2026-03-01T10:00:00.000Z',
          toolStatus: 'succeeded',
          before: null,
          after: null,
          oldString: 'export const a = 1;\n',
          newString: 'export const a = 2;\n',
          relation: { kind: 'rename', oldPath: 'src/old.ts', newPath: 'src/new.ts' },
          linesAdded: 1,
          linesRemoved: 1,
        },
        {
          schemaVersion: 1,
          eventId: 'event-b',
          taskId: TASK_ID,
          taskRef: TASK_ID,
          taskRefKind: 'canonical',
          phase: 'work',
          executionSeq: 2,
          sessionId: 'session-b',
          agentId: 'bob@team',
          toolUseId: 'tool-b',
          source: 'shell_snapshot',
          operation: 'modify',
          confidence: 'high',
          workspaceRoot: '/repo/.claude/worktrees/team-b',
          worktreePath: '/repo/.claude/worktrees/team-b',
          filePath: '/repo/.claude/worktrees/team-b/src/new.ts',
          relativePath: 'src/new.ts',
          timestamp: '2026-03-01T10:01:00.000Z',
          toolStatus: 'succeeded',
          before: null,
          after: null,
          oldString: 'export const b = 1;\n',
          newString: 'export const b = 2;\n',
          relation: { kind: 'rename', oldPath: 'src/old.ts', newPath: 'src/new.ts' },
          linesAdded: 1,
          linesRemoved: 1,
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n') + '\n',
      'utf8'
    );

    const reader = new TaskChangeLedgerReader();
    const result = await reader.readTaskChanges({
      teamName: 'team',
      taskId: TASK_ID,
      projectDir: tmpDir,
      projectPath: '/repo',
      includeDetails: false,
    });

    expect(result?.files).toHaveLength(2);
    expect(new Set(result?.files.map((file) => file.changeKey))).toEqual(
      new Set([
        'rename:/repo/.claude/worktrees/team-a:src/old.ts->src/new.ts',
        'rename:/repo/.claude/worktrees/team-b:src/old.ts->src/new.ts',
      ])
    );
  });

  it('falls back to journal summary when bundle and freshness describe different generations', async () => {
    tmpDir = await fsTempDir();
    const bundleDir = path.join(tmpDir, '.board-task-changes', 'bundles');
    const eventsDir = path.join(tmpDir, '.board-task-changes', 'events');
    const freshnessDir = path.join(tmpDir, '.board-task-change-freshness');
    await mkdir(bundleDir, { recursive: true });
    await mkdir(eventsDir, { recursive: true });
    await mkdir(freshnessDir, { recursive: true });

    await writeFile(
      path.join(bundleDir, `${encodeURIComponent(TASK_ID)}.json`),
      JSON.stringify({
        schemaVersion: 2,
        source: 'task-change-ledger',
        bundleKind: 'summary',
        taskId: TASK_ID,
        generatedAt: '2026-03-01T10:00:00.000Z',
        journalStamp: { events: { bytes: 10, mtimeMs: 1, tailSha256: 'bundle' } },
        integrity: 'ok',
        eventCount: 1,
        noticeCount: 0,
        scope: {
          confidence: { tier: 1, label: 'high', reason: 'bundle' },
          memberName: 'bundle-agent',
          agentIds: ['bundle-agent'],
          startTimestamp: '2026-03-01T10:00:00.000Z',
          endTimestamp: '2026-03-01T10:00:00.000Z',
          toolUseIds: ['bundle-tool'],
          toolUseCount: 1,
          phaseSet: ['work'],
          visibleFileCount: 1,
          contributors: [],
        },
        files: [
          {
            changeKey: 'path:/repo/stale.ts',
            filePath: '/repo/stale.ts',
            relativePath: 'stale.ts',
            linesAdded: 1,
            linesRemoved: 0,
            diffStatKnown: true,
            eventCount: 1,
            firstTimestamp: '2026-03-01T10:00:00.000Z',
            lastTimestamp: '2026-03-01T10:00:00.000Z',
            latestOperation: 'modify',
            createdInTask: false,
            deletedInTask: false,
            latestBeforeHash: null,
            latestAfterHash: null,
            contentAvailability: 'metadata-only',
            reviewability: 'metadata-only',
            agentIds: ['bundle-agent'],
          },
        ],
        totalLinesAdded: 1,
        totalLinesRemoved: 0,
        diffStatCompleteness: 'complete',
        totalFiles: 1,
        confidence: 'high',
        warningCount: 0,
        warnings: [],
      }),
      'utf8'
    );

    await writeFile(
      path.join(freshnessDir, `${encodeURIComponent(TASK_ID)}.json`),
      JSON.stringify({
        schemaVersion: 2,
        source: 'task-change-ledger',
        taskId: TASK_ID,
        updatedAt: '2026-03-01T10:00:01.000Z',
        journalStamp: { events: { bytes: 20, mtimeMs: 2, tailSha256: 'freshness' } },
        eventCount: 1,
        noticeCount: 0,
        integrity: 'ok',
        bundleSchemaVersion: 2,
        bundleKind: 'summary',
      }),
      'utf8'
    );

    await writeFile(
      path.join(eventsDir, `${encodeURIComponent(TASK_ID)}.jsonl`),
      `${JSON.stringify({
        schemaVersion: 1,
        eventId: 'event-1',
        taskId: TASK_ID,
        taskRef: TASK_ID,
        taskRefKind: 'canonical',
        phase: 'work',
        executionSeq: 1,
        sessionId: 'session-1',
        toolUseId: 'journal-tool',
        source: 'file_edit',
        operation: 'modify',
        confidence: 'exact',
        workspaceRoot: '/repo',
        filePath: '/repo/journal.ts',
        relativePath: 'journal.ts',
        timestamp: '2026-03-01T10:00:02.000Z',
        toolStatus: 'succeeded',
        before: null,
        after: null,
        oldString: 'const a = 1;\n',
        newString: 'const a = 2;\n',
        linesAdded: 1,
        linesRemoved: 1,
      })}\n`,
      'utf8'
    );

    const reader = new TaskChangeLedgerReader();
    const result = await reader.readTaskChanges({
      teamName: 'team',
      taskId: TASK_ID,
      projectDir: tmpDir,
      projectPath: '/repo',
      includeDetails: false,
    });

    expect(result?.files).toHaveLength(1);
    expect(result?.files[0]?.filePath).toBe('/repo/journal.ts');
    expect(result?.warnings).toContain('Task change summary fell back to journal reconstruction.');
  });
});

async function makeLedgerBundle(params: {
  events: unknown[];
  notices?: unknown[];
}): Promise<string> {
  const dir = await fsTempDir();
  const bundleDir = path.join(dir, '.board-task-changes', 'bundles');
  await mkdir(bundleDir, { recursive: true });
  await writeFile(
    path.join(bundleDir, `${encodeURIComponent(TASK_ID)}.json`),
    JSON.stringify({
      schemaVersion: 1,
      source: 'task-change-ledger',
      taskId: TASK_ID,
      generatedAt: '2026-03-01T10:00:00.000Z',
      eventCount: params.events.length,
      files: params.events.map((event: any) => ({
        filePath: event.filePath,
        relativePath: event.relativePath,
        eventIds: [event.eventId],
        linesAdded: event.linesAdded ?? 0,
        linesRemoved: event.linesRemoved ?? 0,
        isNewFile: event.operation === 'create',
        latestAfterHash: event.after?.sha256 ?? null,
      })),
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      totalFiles: params.events.length,
      confidence: 'high',
      warnings: [],
      events: params.events,
      ...(params.notices ? { notices: params.notices } : {}),
    }),
    'utf8'
  );
  return dir;
}

async function fsTempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'ledger-reader-'));
}
