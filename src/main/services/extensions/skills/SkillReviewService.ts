import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createLogger } from '@shared/utils/logger';

import type { ImportedSkillSourceFile } from './SkillImportService';
import type { SkillDraftFile, SkillReviewFileChange } from '@shared/types/extensions';

const logger = createLogger('Extensions:SkillReview');

export class SkillReviewService {
  async buildTextChanges(
    targetSkillDir: string,
    files: SkillDraftFile[]
  ): Promise<SkillReviewFileChange[]> {
    return Promise.all(
      files.map(async (file) => {
        const absolutePath = path.join(targetSkillDir, file.relativePath);
        const oldContent = await this.readUtf8IfExists(absolutePath);
        return {
          relativePath: file.relativePath,
          absolutePath,
          action: oldContent === null ? 'create' : 'update',
          oldContent,
          newContent: file.content,
          isBinary: false,
        } satisfies SkillReviewFileChange;
      })
    );
  }

  async buildImportChanges(
    targetSkillDir: string,
    files: ImportedSkillSourceFile[]
  ): Promise<SkillReviewFileChange[]> {
    return Promise.all(
      files.map(async (file) => {
        const destPath = path.join(targetSkillDir, file.relativePath);
        const exists = await this.pathExists(destPath);
        const oldContent = file.isBinary ? null : await this.readUtf8IfExists(destPath);
        return {
          relativePath: file.relativePath,
          absolutePath: destPath,
          action: exists ? 'update' : 'create',
          oldContent,
          newContent: file.isBinary ? null : file.content,
          isBinary: file.isBinary,
        } satisfies SkillReviewFileChange;
      })
    );
  }

  private async readUtf8IfExists(filePath: string): Promise<string | null> {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      logger.warn(`Failed to read existing file ${filePath}`, error);
      return null;
    }
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await fs.stat(targetPath);
      return true;
    } catch {
      return false;
    }
  }
}
