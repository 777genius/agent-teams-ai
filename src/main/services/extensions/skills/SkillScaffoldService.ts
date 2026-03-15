import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { isPathWithinRoot, validateFileName } from '@main/utils/pathValidation';
import type { SkillDraftFile, SkillRootKind, SkillScope } from '@shared/types/extensions';

import { SkillRootsResolver } from './SkillRootsResolver';

export class SkillScaffoldService {
  constructor(private readonly rootsResolver = new SkillRootsResolver()) {}

  async resolveUpsertTarget(
    scope: SkillScope,
    rootKind: SkillRootKind,
    projectPath: string | undefined,
    folderName: string,
    existingSkillId?: string
  ): Promise<string> {
    const root = this.resolveWritableRoot(scope, rootKind, projectPath);
    await fs.mkdir(root.rootPath, { recursive: true });

    const folderValidation = validateFileName(folderName);
    if (!folderValidation.valid) {
      throw new Error(folderValidation.error ?? 'Invalid folder name');
    }

    const targetSkillDir = existingSkillId
      ? path.resolve(existingSkillId)
      : path.join(root.rootPath, folderName);
    if (!isPathWithinRoot(targetSkillDir, root.rootPath)) {
      throw new Error('Target skill directory is outside the allowed root');
    }

    return targetSkillDir;
  }

  normalizeDraftFiles(files: SkillDraftFile[]): SkillDraftFile[] {
    return files.map((file) => ({
      ...file,
      relativePath: this.normalizeRelativePath(file.relativePath),
    }));
  }

  async writeTextFiles(targetSkillDir: string, files: SkillDraftFile[]): Promise<void> {
    for (const file of files) {
      const absolutePath = path.join(targetSkillDir, file.relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, file.content, 'utf8');
    }
  }

  private resolveWritableRoot(scope: SkillScope, rootKind: SkillRootKind, projectPath?: string) {
    const roots = this.rootsResolver.resolve(projectPath);
    const match = roots.find((root) => root.scope === scope && root.rootKind === rootKind);
    if (!match) {
      throw new Error('Requested skill root is unavailable');
    }
    if (scope === 'project' && !projectPath) {
      throw new Error('projectPath is required for project-scoped skills');
    }
    return match;
  }

  private normalizeRelativePath(relativePath: string): string {
    if (!relativePath || typeof relativePath !== 'string') {
      throw new Error('relativePath is required');
    }

    const normalized = path.normalize(relativePath).replace(/\\/g, '/');
    if (normalized.startsWith('../') || normalized === '..' || path.isAbsolute(normalized)) {
      throw new Error(`Invalid relative path: ${relativePath}`);
    }

    const parts = normalized.split('/').filter(Boolean);
    if (parts.length === 0) {
      throw new Error(`Invalid relative path: ${relativePath}`);
    }

    for (const part of parts) {
      const validation = validateFileName(part);
      if (!validation.valid) {
        throw new Error(validation.error ?? `Invalid path segment: ${part}`);
      }
    }

    return parts.join('/');
  }
}
