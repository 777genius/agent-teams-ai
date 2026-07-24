import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { createReviewScopeAuthorizationFeature } from '@features/change-review/main';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FileChangeSummary, FileChangeWithContent } from '@shared/types/review';

const temporaryRoots: string[] = [];

function createFile(filePath: string): FileChangeSummary {
  return {
    filePath,
    relativePath: 'src/reviewed.ts',
    snippets: [],
    linesAdded: 1,
    linesRemoved: 1,
    isNewFile: false,
    changeKey: 'reviewed-change',
  };
}

function createContent(file: FileChangeSummary): FileChangeWithContent {
  return {
    ...file,
    originalFullContent: 'before\n',
    modifiedFullContent: 'after\n',
    contentSource: 'ledger-exact',
  };
}

function createHarness(root: string, files: FileChangeSummary[]) {
  const getFileContent = vi.fn((_team, _member, filePath: string) => {
    const file = files.find((candidate) => candidate.filePath === filePath);
    if (!file) throw new Error('Missing test file');
    return Promise.resolve(createContent(file));
  });
  return {
    feature: createReviewScopeAuthorizationFeature({
      validators: {
        validateTeamName: (value) =>
          value === 'safe-team'
            ? { valid: true, value: 'safe-team' }
            : { valid: false, error: 'Invalid teamName' },
        validateTaskId: (value) =>
          value === 'task-1'
            ? { valid: true, value: 'task-1' }
            : { valid: false, error: 'Invalid taskId' },
      },
      config: {
        getConfig: vi.fn(() => Promise.resolve({ projectPath: root, members: [{ cwd: root }] })),
      },
      changes: {
        getTaskChanges: vi.fn(() =>
          Promise.resolve({
            files,
            scope: { memberName: 'worker' },
          })
        ),
        getAgentChanges: vi.fn(() => Promise.resolve({ files })),
      },
      content: {
        getFileContent,
        invalidateFile: vi.fn(),
      },
    }),
    getFileContent,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('ReviewScopeAuthorizationApplication', () => {
  it('binds a task scope to configured roots and authoritative reviewed files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'review-scope-'));
    temporaryRoots.push(root);
    const filePath = path.join(root, 'src', 'reviewed.ts');
    // Path is derived from a fresh test-only temporary directory.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await mkdir(path.dirname(filePath), { recursive: true });
    // Path is derived from a fresh test-only temporary directory.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await writeFile(filePath, 'current\n', { encoding: 'utf8', flag: 'w' });
    const file = createFile(filePath);
    const { feature, getFileContent } = createHarness(root, [file]);

    const { scope, authorization } = await feature.resolveReviewPathAuthorization({
      teamName: 'safe-team',
      taskId: 'task-1',
    });
    const authorizedPath = await feature.validateAuthorizedReviewFilePath(authorization, filePath, {
      requireReviewedFile: true,
      rejectHardlinks: true,
    });
    const content = await feature.resolveAuthoritativeFileContent(
      scope,
      authorization,
      authorizedPath
    );

    expect(scope).toEqual({ teamName: 'safe-team', taskId: 'task-1' });
    expect(authorization.resolutionMemberName).toBe('worker');
    expect(feature.getAuthoritativeReviewedFile(authorization, filePath)).toBe(file);
    expect(content).toMatchObject({ filePath, snippets: [], contentSource: 'ledger-exact' });
    expect(getFileContent).toHaveBeenCalledWith('safe-team', 'worker', filePath, []);
  });

  it('rejects existing files outside every authoritative project root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'review-scope-root-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'review-scope-outside-'));
    temporaryRoots.push(root, outside);
    const outsideFile = path.join(outside, 'outside.ts');
    // Path is derived from a fresh test-only temporary directory.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await writeFile(outsideFile, 'outside\n', 'utf8');
    const { feature } = createHarness(root, []);
    const { authorization } = await feature.resolveReviewPathAuthorization({
      teamName: 'safe-team',
      memberName: 'worker',
    });

    await expect(
      feature.validateAuthorizedReviewFilePath(authorization, outsideFile, {
        requireReviewedFile: false,
      })
    ).rejects.toThrow('Review file path is outside the authoritative project/worktree');
  });

  it('refuses a reviewed symlink even when its target remains inside the project root', async () => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(path.join(tmpdir(), 'review-scope-link-'));
    temporaryRoots.push(root);
    const targetPath = path.join(root, 'target.ts');
    const linkPath = path.join(root, 'reviewed.ts');
    // Paths are derived from a fresh test-only temporary directory.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await writeFile(targetPath, 'target\n', 'utf8');
    // Paths are derived from a fresh test-only temporary directory.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await symlink(targetPath, linkPath);
    const file = createFile(linkPath);
    const { feature } = createHarness(root, [file]);
    const { authorization } = await feature.resolveReviewPathAuthorization({
      teamName: 'safe-team',
      memberName: 'worker',
    });

    await expect(
      feature.validateAuthorizedReviewFilePath(authorization, linkPath, {
        requireReviewedFile: true,
        rejectHardlinks: true,
      })
    ).rejects.toThrow('Review mutation refuses symbolic or multiply-linked files');
  });

  it('rejects a renderer member that conflicts with authoritative task ownership', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'review-scope-owner-'));
    temporaryRoots.push(root);
    const { feature } = createHarness(root, []);

    await expect(
      feature.resolveReviewPathAuthorization({
        teamName: 'safe-team',
        taskId: 'task-1',
        memberName: 'other-worker',
      })
    ).rejects.toThrow('Review memberName does not match the authoritative task scope');
  });
});
