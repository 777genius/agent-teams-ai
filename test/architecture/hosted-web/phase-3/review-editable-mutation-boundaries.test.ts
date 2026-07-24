import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');

function readSource(relativePath: string): string {
  // Paths are fixed repository-owned test fixtures.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return readFileSync(resolve(ROOT, relativePath), 'utf8');
}

describe('review editable mutation architecture boundary', () => {
  it('keeps direct edit input policy free of runtime dependencies', () => {
    const policy = readSource(
      'src/features/review-mutations/core/domain/reviewEditableMutationPolicy.ts'
    );
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

  it('owns editable mutation orchestration behind focused ports', () => {
    const application = readSource(
      'src/features/review-mutations/main/application/ReviewEditableMutationApplication.ts'
    );
    const ports = readSource(
      'src/features/review-mutations/main/application/ReviewEditableMutationPorts.ts'
    );
    const composition = readSource(
      'src/features/review-mutations/main/composition/createReviewEditableMutationFeature.ts'
    );

    expect(application).not.toMatch(/from\s+['"](?:electron|node:|fs|@main\/)/);
    expect(application).not.toContain('ipcMain');
    expect(ports).toContain('export interface ReviewEditableMutationScopePort');
    expect(ports).toContain('export interface ReviewEditableMutationApplierPort');
    expect(ports).toContain('export interface ReviewEditableMutationContentPort');
    expect(composition).toContain('return new ReviewEditableMutationApplication(dependencies)');
  });

  it('leaves editable review IPC as exact validation and delegation', () => {
    const shell = readSource('src/main/ipc/review.ts');
    const handlers = shell.slice(
      shell.indexOf('// --- Editable diff Handlers ---'),
      shell.indexOf('async function handleWatchReviewFiles')
    );

    expect(shell).toContain('createReviewEditableMutationFeature({');
    expect(shell).toContain('ipcMain.handle(REVIEW_SAVE_EDITED_FILE, handleSaveEditedFile)');
    expect(shell).toContain('ipcMain.removeHandler(REVIEW_SAVE_EDITED_FILE)');
    expect(handlers).toContain('parseSaveEditedFileInput(');
    expect(handlers).toContain('parseDeleteEditedFileInput(');
    expect(handlers).toContain('reviewEditableMutationFeature.restoreRejectedRename(');
    expect(handlers).toContain('reviewEditableMutationFeature.reapplyRejectedRename(');
    expect(handlers).not.toContain('resolveReviewPathAuthorization(');
    expect(handlers).not.toContain('validateAuthorizedReviewFilePath(');
    expect(handlers).not.toContain('getApplier()');
    expect(handlers).not.toContain('invalidateAuthoritativeReviewContent(');
  });
});
