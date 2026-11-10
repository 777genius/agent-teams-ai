import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { validateOpenPathUserSelected } from '@main/utils/pathValidation';
import { isBinaryFile } from 'isbinaryfile';

import { SkillScanner } from './SkillScanner';

export interface ImportedSkillSourceFile {
  relativePath: string;
  absolutePath: string;
  content: string | null;
  isBinary: boolean;
}

export interface SkillImportInspection {
  files: ImportedSkillSourceFile[];
  warnings: string[];
  hiddenEntriesSkipped: number;
}

const MAX_IMPORT_FILE_COUNT = 200;
const MAX_IMPORT_TOTAL_BYTES = 10 * 1024 * 1024;

export class SkillImportService {
  constructor(private readonly scanner = new SkillScanner()) {}

  async validateSourceDir(sourceDir: string): Promise<string> {
    const validatedSource = validateOpenPathUserSelected(sourceDir);
    if (!validatedSource.valid || !validatedSource.normalizedPath) {
      throw new Error(validatedSource.error ?? 'Invalid import source');
    }

    const normalizedSourceDir = validatedSource.normalizedPath;
    const sourceStat = await fs.stat(normalizedSourceDir);
    if (!sourceStat.isDirectory()) {
      throw new Error('Import source must be a directory');
    }

    const detectedSkillFile = await this.scanner.detectSkillFile(normalizedSourceDir);
    if (!detectedSkillFile) {
      throw new Error('Import source does not contain a valid skill file');
    }

    return normalizedSourceDir;
  }

  async inspectSourceDir(sourceDir: string): Promise<SkillImportInspection> {
    const normalizedSourceDir = await this.validateSourceDir(sourceDir);
    const walked = await this.walkDirectory(normalizedSourceDir);
    const files = await Promise.all(
      walked.files.map(async ({ absolutePath, relativePath }) => {
        const binary = await isBinaryFile(absolutePath);
        return {
          relativePath,
          absolutePath,
          content: binary ? null : await fs.readFile(absolutePath, 'utf8'),
          isBinary: binary,
        };
      })
    );

    const warnings: string[] = [];
    if (walked.hiddenEntriesSkipped > 0) {
      warnings.push('Hidden files and folders were skipped during import.');
    }
    if (files.some((file) => file.isBinary)) {
      warnings.push('This import includes binary files. Binary files will be copied as-is.');
    }
    if (
      files.some(
        (file) => file.relativePath === 'scripts' || file.relativePath.startsWith('scripts/')
      )
    ) {
      warnings.push('This import includes scripts. Review them carefully before importing.');
    }

    return {
      files,
      warnings,
      hiddenEntriesSkipped: walked.hiddenEntriesSkipped,
    };
  }

  async readSourceFiles(sourceDir: string): Promise<ImportedSkillSourceFile[]> {
    return (await this.inspectSourceDir(sourceDir)).files;
  }

  async writeImportedFiles(
    targetSkillDir: string,
    files: ImportedSkillSourceFile[]
  ): Promise<void> {
    for (const file of files) {
      const destPath = path.join(targetSkillDir, file.relativePath);
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      if (file.isBinary) {
        await fs.copyFile(file.absolutePath, destPath);
      } else {
        await fs.writeFile(destPath, file.content ?? '', 'utf8');
      }
    }
  }

  private async walkDirectory(rootDir: string): Promise<{
    files: { absolutePath: string; relativePath: string }[];
    hiddenEntriesSkipped: number;
  }> {
    const allFiles: { absolutePath: string; relativePath: string }[] = [];
    let hiddenEntriesSkipped = 0;
    let totalBytes = 0;

    const visit = async (currentDir: string): Promise<void> => {
      const dirEntries = await fs.readdir(currentDir, { withFileTypes: true });
      for (const entry of dirEntries) {
        if (entry.name.startsWith('.')) {
          hiddenEntriesSkipped += 1;
          continue;
        }

        const fullPath = path.join(currentDir, entry.name);
        if (entry.isSymbolicLink()) {
          throw new Error('Import source cannot contain symbolic links');
        }

        if (entry.isDirectory()) {
          await visit(fullPath);
          continue;
        }

        const stat = await fs.stat(fullPath);
        totalBytes += stat.size;
        if (allFiles.length + 1 > MAX_IMPORT_FILE_COUNT) {
          throw new Error(`Import source has too many files (max ${MAX_IMPORT_FILE_COUNT})`);
        }
        if (totalBytes > MAX_IMPORT_TOTAL_BYTES) {
          throw new Error(
            `Import source is too large (max ${Math.floor(MAX_IMPORT_TOTAL_BYTES / (1024 * 1024))} MB)`
          );
        }

        allFiles.push({
          absolutePath: fullPath,
          relativePath: path.relative(rootDir, fullPath).replace(/\\/g, '/'),
        });
      }
    };

    await visit(rootDir);

    return {
      files: allFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
      hiddenEntriesSkipped,
    };
  }
}
