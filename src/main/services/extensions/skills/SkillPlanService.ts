import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { SkillScanner } from './SkillScanner';

import type { ImportedSkillSourceFile } from './SkillImportService';
import type {
  SkillDraftFile,
  SkillReviewFileChange,
  SkillReviewPreview,
  SkillReviewSummary,
} from '@shared/types/extensions';

type SkillPlanInputFile =
  | { relativePath: string; isBinary: false; content: string }
  | { relativePath: string; isBinary: true; sourceAbsolutePath: string };

interface ManagedCurrentFile {
  relativePath: string;
  absolutePath: string;
}

interface SkillExecutionChange extends SkillReviewFileChange {
  sourceAbsolutePath?: string;
  expectedSHA256: string | null;
}

export interface SkillExecutionPlan {
  preview: SkillReviewPreview;
  changes: SkillExecutionChange[];
}

const MANAGED_SUBDIRECTORIES = ['scripts', 'references', 'assets'] as const;
export class SkillPlanService {
  constructor(private readonly scanner = new SkillScanner()) {}

  async buildUpsertPlan(
    targetSkillDir: string,
    files: SkillDraftFile[]
  ): Promise<SkillExecutionPlan> {
    const desiredFiles: SkillPlanInputFile[] = files.map((file) => ({
      relativePath: file.relativePath,
      isBinary: false,
      content: file.content,
    }));

    return this.buildPlan(targetSkillDir, desiredFiles, 'upsert');
  }

  async buildImportPlan(
    targetSkillDir: string,
    files: ImportedSkillSourceFile[]
  ): Promise<SkillExecutionPlan> {
    const desiredFiles: SkillPlanInputFile[] = files.map((file) =>
      file.isBinary
        ? {
            relativePath: file.relativePath,
            isBinary: true,
            sourceAbsolutePath: file.absolutePath,
          }
        : {
            relativePath: file.relativePath,
            isBinary: false,
            content: file.content ?? '',
          }
    );

    return this.buildPlan(targetSkillDir, desiredFiles, 'import');
  }

  private async buildPlan(
    targetSkillDir: string,
    desiredFiles: SkillPlanInputFile[],
    mode: 'upsert' | 'import'
  ): Promise<SkillExecutionPlan> {
    const normalizedDesired = this.normalizeDesiredFiles(desiredFiles);
    const [currentManagedFiles, allExistingFiles] = await Promise.all([
      this.readCurrentManagedFiles(targetSkillDir),
      this.listAllRelativeFiles(targetSkillDir),
    ]);

    const changesByRelativePath = new Map<string, SkillExecutionChange>();

    await Promise.all(
      normalizedDesired.map(async (file) => {
        const absolutePath = path.join(targetSkillDir, file.relativePath);
        const existing = await this.readBytesIfExists(absolutePath);
        const action = existing === null ? 'create' : 'update';
        changesByRelativePath.set(file.relativePath, {
          relativePath: file.relativePath,
          absolutePath,
          action,
          oldContent: file.isBinary ? null : (existing?.toString('utf8') ?? null),
          expectedSHA256:
            existing === null ? null : createHash('sha256').update(existing).digest('hex'),
          newContent: file.isBinary ? null : file.content,
          isBinary: file.isBinary,
          sourceAbsolutePath: file.isBinary ? file.sourceAbsolutePath : undefined,
        });
      })
    );

    for (const currentFile of currentManagedFiles.values()) {
      if (changesByRelativePath.has(currentFile.relativePath)) {
        continue;
      }

      const existing = await this.readBytesIfExists(currentFile.absolutePath);
      changesByRelativePath.set(currentFile.relativePath, {
        relativePath: currentFile.relativePath,
        absolutePath: currentFile.absolutePath,
        action: 'delete',
        oldContent: existing?.toString('utf8') ?? null,
        expectedSHA256:
          existing === null ? null : createHash('sha256').update(existing).digest('hex'),
        newContent: null,
        isBinary: false,
      });
    }

    const changes = [...changesByRelativePath.values()].sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath)
    );
    const warnings = this.buildWarnings({
      changes,
      currentManagedFiles,
      allExistingFiles,
      desiredFiles: new Set(normalizedDesired.map((file) => file.relativePath)),
      mode,
    });

    const summary = changes.reduce<SkillReviewSummary>(
      (acc, change) => {
        acc[`${change.action}d`] += 1;
        if (change.isBinary) {
          acc.binary += 1;
        }
        return acc;
      },
      { created: 0, updated: 0, deleted: 0, binary: 0 }
    );

    const preview: SkillReviewPreview = {
      planId: this.buildPlanId(targetSkillDir, changes, warnings),
      targetSkillDir,
      changes: changes.map(
        ({ sourceAbsolutePath: _sourceAbsolutePath, expectedSHA256: _expectedSHA256, ...change }) =>
          change
      ),
      warnings,
      summary,
    };

    return { preview, changes };
  }

  private normalizeDesiredFiles(files: SkillPlanInputFile[]): SkillPlanInputFile[] {
    const map = new Map<string, SkillPlanInputFile>();
    for (const file of files) {
      const normalizedPath = path.normalize(file.relativePath).replace(/\\/g, '/');
      map.set(normalizedPath, { ...file, relativePath: normalizedPath });
    }
    return [...map.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  private async readCurrentManagedFiles(
    targetSkillDir: string
  ): Promise<Map<string, ManagedCurrentFile>> {
    const files = new Map<string, ManagedCurrentFile>();
    const detectedSkillFile = await this.scanner.detectSkillFile(targetSkillDir);
    if (detectedSkillFile) {
      files.set(path.basename(detectedSkillFile), {
        relativePath: path.basename(detectedSkillFile),
        absolutePath: detectedSkillFile,
      });
    }

    for (const directory of MANAGED_SUBDIRECTORIES) {
      const fullDirectoryPath = path.join(targetSkillDir, directory);
      const relativeFiles = await this.listAllRelativeFiles(fullDirectoryPath);
      for (const relativePath of relativeFiles) {
        const managedRelativePath = `${directory}/${relativePath}`;
        files.set(managedRelativePath, {
          relativePath: managedRelativePath,
          absolutePath: path.join(fullDirectoryPath, relativePath),
        });
      }
    }

    return files;
  }

  private async listAllRelativeFiles(rootDir: string): Promise<string[]> {
    try {
      const rootStat = await fs.stat(rootDir);
      if (!rootStat.isDirectory()) {
        return [];
      }
    } catch {
      return [];
    }

    const dirEntries = await fs.readdir(rootDir, { withFileTypes: true });
    const entries = await Promise.all(
      dirEntries.map(async (entry) => {
        const fullPath = path.join(rootDir, entry.name);
        if (entry.isDirectory()) {
          const children = await this.listAllRelativeFiles(fullPath);
          return children.map((child) => path.join(entry.name, child).replace(/\\/g, '/'));
        }
        return [entry.name];
      })
    );

    return entries.flat().sort((a, b) => a.localeCompare(b));
  }

  private buildWarnings({
    changes,
    currentManagedFiles,
    allExistingFiles,
    desiredFiles,
    mode,
  }: {
    changes: SkillExecutionChange[];
    currentManagedFiles: Map<string, ManagedCurrentFile>;
    allExistingFiles: string[];
    desiredFiles: Set<string>;
    mode: 'upsert' | 'import';
  }): string[] {
    const warnings: string[] = [];
    const deleteCount = changes.filter((change) => change.action === 'delete').length;
    const updateCount = changes.filter((change) => change.action === 'update').length;
    const binaryCount = changes.filter((change) => change.isBinary).length;

    if (deleteCount > 0) {
      warnings.push(
        deleteCount === 1
          ? '1 managed file will be removed to match this reviewed plan.'
          : `${deleteCount} managed files will be removed to match this reviewed plan.`
      );
    }

    if (updateCount > 0) {
      warnings.push(
        updateCount === 1
          ? '1 existing file will be overwritten.'
          : `${updateCount} existing files will be overwritten.`
      );
    }

    if (binaryCount > 0) {
      warnings.push(
        binaryCount === 1
          ? '1 binary file will be copied as-is.'
          : `${binaryCount} binary files will be copied as-is.`
      );
    }

    const managedPaths = new Set(currentManagedFiles.keys());
    const unmanagedFiles = allExistingFiles.filter(
      (relativePath) => !managedPaths.has(relativePath) && !desiredFiles.has(relativePath)
    );
    if (unmanagedFiles.length > 0) {
      warnings.push(
        mode === 'import'
          ? 'Existing files outside the imported plan will be kept as-is.'
          : 'Existing files outside the managed skill set will be kept as-is.'
      );
    }

    return warnings;
  }

  private buildPlanId(
    targetSkillDir: string,
    changes: SkillExecutionChange[],
    warnings: string[]
  ): string {
    const hash = createHash('sha256');
    hash.update(targetSkillDir);
    hash.update('\n');
    for (const change of changes) {
      hash.update(
        JSON.stringify({
          relativePath: change.relativePath,
          action: change.action,
          oldContent: change.oldContent,
          expectedSHA256: change.expectedSHA256,
          newContent: change.newContent,
          isBinary: change.isBinary,
          sourceAbsolutePath: change.sourceAbsolutePath ?? null,
        })
      );
      hash.update('\n');
    }
    for (const warning of warnings) {
      hash.update(warning);
      hash.update('\n');
    }
    return hash.digest('hex');
  }

  private async readBytesIfExists(filePath: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }
}
