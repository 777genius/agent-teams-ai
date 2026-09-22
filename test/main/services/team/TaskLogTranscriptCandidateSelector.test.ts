import path from 'path';

import { describe, expect, it } from 'vitest';

import { TaskLogTranscriptCandidateSelector } from '../../../../src/main/services/team/taskLogs/stream/TaskLogTranscriptCandidateSelector';

import type { BoardTaskActivityRecord } from '../../../../src/main/services/team/taskLogs/activity/BoardTaskActivityRecord';

function makeRecord(args: {
  id: string;
  filePath: string;
  sessionId?: string;
  canonicalToolName?: string;
  category?: NonNullable<BoardTaskActivityRecord['action']>['category'];
}): BoardTaskActivityRecord {
  return {
    id: args.id,
    timestamp: '2026-04-30T10:00:00.000Z',
    task: {
      locator: { ref: 'abcd1234', refKind: 'display', canonicalId: 'task-a' },
      resolution: 'resolved',
    },
    linkKind: 'board_action',
    targetRole: 'subject',
    actor: {
      memberName: 'alice',
      role: 'member',
      sessionId: args.sessionId ?? '',
      isSidechain: true,
    },
    actorContext: { relation: 'same_task' },
    ...(args.canonicalToolName || args.category
      ? {
          action: {
            canonicalToolName: args.canonicalToolName ?? 'task_add_comment',
            toolUseId: `${args.id}-tool`,
            category: args.category ?? 'comment',
          },
        }
      : {}),
    source: {
      filePath: args.filePath,
      messageUuid: `${args.id}-msg`,
      toolUseId: `${args.id}-tool`,
      sourceOrder: 1,
    },
  };
}

describe('TaskLogTranscriptCandidateSelector', () => {
  it('selects direct record files and same-session files for non-read task records', () => {
    const projectDir = path.join('/tmp', 'claude-project');
    const rootFile = path.join(projectDir, 'session-a.jsonl');
    const subagentFile = path.join(projectDir, 'session-a', 'subagents', 'agent-worker.jsonl');
    const unrelatedFile = path.join(projectDir, 'session-b.jsonl');
    const selector = new TaskLogTranscriptCandidateSelector();

    const selection = selector.selectInferredNativeTranscriptFiles({
      projectDir,
      transcriptFiles: [unrelatedFile, subagentFile, rootFile],
      records: [
        makeRecord({
          id: 'comment',
          filePath: rootFile,
          sessionId: 'session-a',
          canonicalToolName: 'task_add_comment',
          category: 'comment',
        }),
      ],
      alreadyParsedFilePaths: new Set([rootFile]),
    });

    expect(selection.filePaths).toEqual([subagentFile]);
    expect(selection.candidates.map((candidate) => candidate.filePath)).toEqual([
      rootFile,
      subagentFile,
    ]);
    expect(selection.diagnostics).toMatchObject({
      recordFileCount: 1,
      nonReadSessionCount: 1,
      sameSessionFileCount: 2,
      alreadyParsedCandidateCount: 1,
      finalCandidateCount: 1,
      reason: 'same_session_native_window',
    });
  });

  it('does not expand read-only task records to every file in the same session', () => {
    const projectDir = path.join('/tmp', 'claude-project');
    const rootFile = path.join(projectDir, 'session-a.jsonl');
    const subagentFile = path.join(projectDir, 'session-a', 'subagents', 'agent-worker.jsonl');
    const selector = new TaskLogTranscriptCandidateSelector();

    const selection = selector.selectInferredNativeTranscriptFiles({
      projectDir,
      transcriptFiles: [rootFile, subagentFile],
      records: [
        makeRecord({
          id: 'read',
          filePath: rootFile,
          sessionId: 'session-a',
          canonicalToolName: 'task_get',
          category: 'read',
        }),
      ],
    });

    expect(selection.filePaths).toEqual([rootFile]);
    expect(selection.candidates.map((candidate) => candidate.filePath)).toEqual([rootFile]);
    expect(selection.diagnostics).toMatchObject({
      nonReadSessionCount: 0,
      sameSessionFileCount: 0,
      reason: 'direct_record_files',
    });
  });

  it('falls back to direct record files when the transcript file cannot be session-indexed', () => {
    const projectDir = path.join('/tmp', 'claude-project');
    const outsideFile = path.join('/tmp', 'other-project', 'session-a.jsonl');
    const selector = new TaskLogTranscriptCandidateSelector();

    const selection = selector.selectInferredNativeTranscriptFiles({
      projectDir,
      transcriptFiles: [outsideFile],
      records: [
        makeRecord({
          id: 'comment',
          filePath: outsideFile,
          canonicalToolName: 'task_add_comment',
          category: 'comment',
        }),
      ],
    });

    expect(selection.filePaths).toEqual([outsideFile]);
    expect(selection.diagnostics).toMatchObject({
      recordFileCount: 1,
      nonReadSessionCount: 0,
      sameSessionFileCount: 0,
      finalCandidateCount: 1,
      reason: 'direct_record_files',
    });
  });

  it('does not select files by owner-looking names without session evidence', () => {
    const projectDir = path.join('/tmp', 'claude-project');
    const recordFile = path.join(projectDir, 'session-a.jsonl');
    const ownerLookingFile = path.join(projectDir, 'alice-work.jsonl');
    const selector = new TaskLogTranscriptCandidateSelector();

    const selection = selector.selectInferredNativeTranscriptFiles({
      projectDir,
      transcriptFiles: [recordFile, ownerLookingFile],
      records: [
        makeRecord({
          id: 'comment',
          filePath: recordFile,
          sessionId: undefined,
          canonicalToolName: 'task_add_comment',
          category: 'comment',
        }),
      ],
    });

    expect(selection.filePaths).toEqual([recordFile]);
    expect(selection.filePaths).not.toContain(ownerLookingFile);
  });
});
