import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');

function readSource(relativePath: string): string {
  // Paths are fixed repository-owned test fixtures.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return readFileSync(resolve(ROOT, relativePath), 'utf8');
}

describe('review query architecture boundary', () => {
  it('keeps renderer query sanitization in a pure domain policy', () => {
    const policy = readSource('src/features/change-review/core/domain/reviewQueryPolicy.ts');
    const imports = [...policy.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);

    expect(
      imports.some(
        (specifier) =>
          specifier === 'electron' ||
          specifier.startsWith('node:') ||
          specifier.startsWith('@main/')
      )
    ).toBe(false);
    expect(policy).not.toMatch(/\b(ipcMain|readFile|writeFile)\b/);
  });

  it('owns query orchestration behind focused application ports', () => {
    const application = readSource(
      'src/features/change-review/main/application/ReviewQueryApplication.ts'
    );
    const ports = readSource('src/features/change-review/main/application/ReviewQueryPorts.ts');
    const composition = readSource(
      'src/features/change-review/main/composition/createReviewQueryFeature.ts'
    );

    expect(application).not.toMatch(/from\s+['"](?:electron|node:|fs|@main\/)/);
    expect(application).not.toContain('ipcMain');
    expect(ports).toContain('export interface ReviewQueryChangesPort');
    expect(ports).toContain('export interface ReviewQueryScopePort');
    expect(ports).toContain('export interface ReviewQueryGitHistoryPort');
    expect(composition).toContain('return new ReviewQueryApplication(dependencies)');
  });

  it('leaves review IPC as exact registration, transport policy, and delegation', () => {
    const shell = readSource('src/main/ipc/review.ts');

    expect(shell).toContain('createReviewQueryFeature({');
    expect(shell).toContain('reviewQueryFeature.getTaskChanges(teamName, taskId, opts)');
    expect(shell).toContain(
      'reviewQueryFeature.getTeamTaskChangeSummaries(teamName, sanitizedRequests)'
    );
    expect(shell).toContain('reviewQueryFeature.getFileContent(');
    expect(shell).toContain('reviewQueryFeature.getGitFileLog(projectPath, filePath)');
    expect(shell).toContain('ipcMain.handle(REVIEW_GET_FILE_CONTENT, handleGetFileContent)');
    expect(shell).toContain('ipcMain.removeHandler(REVIEW_GET_FILE_CONTENT)');
    expect(shell).not.toContain('function sanitizeTaskChangeOptions');
    expect(shell).not.toContain('function sanitizeTeamTaskChangeSummaryRequests');
    expect(shell).not.toContain('function registerDisplayedReviewSnapshot');
  });
});
