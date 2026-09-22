import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { TaskChangeLedgerReader } from '@main/services/team/TaskChangeLedgerReader';
import { buildPathChangeLabels } from '@renderer/components/team/review/pathChangeLabels';

import { materializeTaskChangeLedgerFixture } from '../../../../main/services/team/taskChangeLedgerFixtureUtils';

import type { FileChangeSummary, FileChangeWithContent } from '@shared/types';

const TEAM_NAME = 'team-a';

describe('buildPathChangeLabels', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it('projects real ledger rename and copy fixtures from relation metadata, not content heuristics', async () => {
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

    const renameFile = rename?.files[0];
    const copyFile = copy?.files[0];
    expect(renameFile?.filePath).toBe(path.join(renameFixture.projectDir, 'src', 'new.ts'));
    expect(copyFile?.filePath).toBe(path.join(copyFixture.projectDir, 'src', 'copy.ts'));

    const renameLabels = buildPathChangeLabels(rename?.files ?? [], {});
    const copyLabels = buildPathChangeLabels(copy?.files ?? [], {});

    expect(renameLabels[renameFile!.filePath]).toEqual({
      kind: 'renamed',
      direction: 'from',
      otherPath: 'src/old.ts',
    });
    expect(copyLabels[copyFile!.filePath]).toEqual({
      kind: 'copied',
      direction: 'from',
      otherPath: 'src/base.ts',
    });
  });

  it('does not mark metadata-only unavailable content as deleted without ledger delete evidence', () => {
    const file: FileChangeSummary = {
      filePath: '/repo/src/binary.dat',
      relativePath: 'src/binary.dat',
      snippets: [],
      linesAdded: 0,
      linesRemoved: 0,
      isNewFile: false,
      ledgerSummary: {
        latestOperation: 'modify',
        contentAvailability: 'metadata-only',
        reviewability: 'metadata-only',
      },
    };
    const content: FileChangeWithContent = {
      ...file,
      originalFullContent: null,
      modifiedFullContent: null,
      contentSource: 'unavailable',
    };

    expect(buildPathChangeLabels([file], { [file.filePath]: content })).toEqual({});
  });

  it('matches relative ledger relation paths case-insensitively against Windows drive paths', () => {
    const oldFile: FileChangeSummary = {
      filePath: 'C:\\Repo\\SRC\\Old.ts',
      relativePath: 'SRC\\Old.ts',
      snippets: [],
      linesAdded: 0,
      linesRemoved: 1,
      isNewFile: false,
      ledgerSummary: {
        latestOperation: 'delete',
        relation: {
          kind: 'rename',
          oldPath: 'src\\old.ts',
          newPath: 'src\\new.ts',
        },
      },
    };
    const newFile: FileChangeSummary = {
      filePath: 'C:\\Repo\\src\\New.ts',
      relativePath: 'src\\New.ts',
      snippets: [],
      linesAdded: 1,
      linesRemoved: 0,
      isNewFile: false,
      ledgerSummary: {
        latestOperation: 'create',
        relation: {
          kind: 'rename',
          oldPath: 'src\\old.ts',
          newPath: 'src\\new.ts',
        },
      },
    };

    expect(buildPathChangeLabels([oldFile, newFile], {})).toEqual({
      [oldFile.filePath]: {
        kind: 'renamed',
        direction: 'to',
        otherPath: 'src\\new.ts',
      },
      [newFile.filePath]: {
        kind: 'renamed',
        direction: 'from',
        otherPath: 'src\\old.ts',
      },
    });
  });

  it('matches relative Windows relation paths case-insensitively when only backslash paths are available', () => {
    const file: FileChangeSummary = {
      filePath: 'SRC\\New.ts',
      relativePath: 'SRC\\New.ts',
      snippets: [],
      linesAdded: 1,
      linesRemoved: 0,
      isNewFile: false,
      ledgerSummary: {
        latestOperation: 'create',
        relation: {
          kind: 'rename',
          oldPath: 'src\\old.ts',
          newPath: 'src\\new.ts',
        },
      },
    };

    expect(buildPathChangeLabels([file], {})).toEqual({
      [file.filePath]: {
        kind: 'renamed',
        direction: 'from',
        otherPath: 'src\\old.ts',
      },
    });
  });

  it('does not project rename labels when relation paths match neither file side', () => {
    const file: FileChangeSummary = {
      filePath: 'C:\\Repo\\src\\renew.ts',
      relativePath: 'src\\renew.ts',
      snippets: [],
      linesAdded: 1,
      linesRemoved: 1,
      isNewFile: false,
      ledgerSummary: {
        latestOperation: 'modify',
        relation: {
          kind: 'rename',
          oldPath: 'old.ts',
          newPath: 'new.ts',
        },
      },
    };

    expect(buildPathChangeLabels([file], {})).toEqual({});
  });

  it('falls back to delete label when invalid relation metadata belongs to a delete event', () => {
    const file: FileChangeSummary = {
      filePath: 'C:\\Repo\\src\\renew.ts',
      relativePath: 'src\\renew.ts',
      snippets: [],
      linesAdded: 0,
      linesRemoved: 1,
      isNewFile: false,
      ledgerSummary: {
        latestOperation: 'delete',
        relation: {
          kind: 'rename',
          oldPath: 'old.ts',
          newPath: 'new.ts',
        },
      },
    };

    expect(buildPathChangeLabels([file], {})).toEqual({
      [file.filePath]: { kind: 'deleted' },
    });
  });

  it('keeps the legacy content-hash move fallback only when text evidence is available', () => {
    const oldFile: FileChangeSummary = {
      filePath: '/repo/src/old.ts',
      relativePath: 'src/old.ts',
      snippets: [],
      linesAdded: 0,
      linesRemoved: 1,
      isNewFile: false,
    };
    const newFile: FileChangeSummary = {
      filePath: '/repo/lib/old.ts',
      relativePath: 'lib/old.ts',
      snippets: [],
      linesAdded: 1,
      linesRemoved: 0,
      isNewFile: true,
    };
    const contentByPath: Record<string, FileChangeWithContent> = {
      [oldFile.filePath]: {
        ...oldFile,
        originalFullContent: 'export const value = 1;\n',
        modifiedFullContent: null,
        contentSource: 'file-history',
      },
      [newFile.filePath]: {
        ...newFile,
        originalFullContent: '',
        modifiedFullContent: 'export const value = 1;\n',
        contentSource: 'disk-current',
      },
    };

    expect(buildPathChangeLabels([oldFile, newFile], contentByPath)).toEqual({
      [newFile.filePath]: { kind: 'moved', direction: 'from', otherPath: 'src/old.ts' },
      [oldFile.filePath]: { kind: 'moved', direction: 'to', otherPath: 'lib/old.ts' },
    });
  });
});
