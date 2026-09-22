import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createLogger } from '@shared/utils/logger';

import { SkillMetadataParser } from './SkillMetadataParser';
import { type ResolvedSkillRoot, SkillRootsResolver } from './SkillRootsResolver';
import { SkillScanner } from './SkillScanner';
import { SkillValidator } from './SkillValidator';

import type { SkillCatalogItem, SkillDetail } from '@shared/types/extensions';

const logger = createLogger('Extensions:SkillsCatalog');

export class SkillsCatalogService {
  constructor(
    private readonly rootsResolver = new SkillRootsResolver(),
    private readonly parser = new SkillMetadataParser(),
    private readonly scanner = new SkillScanner(parser),
    private readonly validator = new SkillValidator()
  ) {}

  async list(projectPath?: string): Promise<SkillCatalogItem[]> {
    const roots = this.rootsResolver.resolve(projectPath);
    const scannedItems = (
      await Promise.all(roots.map((root) => this.readSkillsFromRoot(root)))
    ).flat();
    return this.validator.annotateCatalog(scannedItems);
  }

  async getDetail(skillId: string, projectPath?: string): Promise<SkillDetail | null> {
    const roots = this.rootsResolver.resolve(projectPath);
    const allowedRoots = new Set(roots.map((root) => path.resolve(root.rootPath)));
    const normalizedSkillDir = path.resolve(skillId);

    const owningRoot = roots.find((root) => this.isWithinRoot(normalizedSkillDir, root.rootPath));
    if (!owningRoot || !allowedRoots.has(path.resolve(owningRoot.rootPath))) {
      return null;
    }

    const folderName = path.basename(normalizedSkillDir);
    const skillFile = await this.scanner.detectSkillFile(normalizedSkillDir);
    if (!skillFile) return null;

    try {
      const [rawContent, stat, flags, relatedFiles] = await Promise.all([
        fs.readFile(skillFile, 'utf8'),
        fs.stat(skillFile),
        this.scanner.readFlags(normalizedSkillDir),
        this.scanner.readRelatedFiles(normalizedSkillDir),
      ]);

      const item = this.parser.parseCatalogItem({
        skillDir: normalizedSkillDir,
        folderName,
        skillFile,
        rawContent,
        modifiedAt: stat.mtimeMs,
        flags,
        root: owningRoot,
      });

      return this.parser.parseDetail(item, rawContent, relatedFiles);
    } catch (error) {
      logger.warn(`Failed to read skill detail for ${skillId}`, error);
      return null;
    }
  }

  private async readSkillsFromRoot(root: ResolvedSkillRoot): Promise<SkillCatalogItem[]> {
    try {
      return await this.scanner.scanRoot(root);
    } catch (error) {
      logger.warn(`Failed to scan skills root ${root.rootPath}`, error);
      return [];
    }
  }

  private isWithinRoot(targetPath: string, rootPath: string): boolean {
    const normalizedTarget = this.normalizeForContainment(targetPath);
    const normalizedRoot = this.normalizeForContainment(rootPath);
    const relativePath = path.relative(normalizedRoot, normalizedTarget);
    return (
      relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
    );
  }

  private normalizeForContainment(value: string): string {
    const resolved = path.resolve(path.normalize(value));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }
}
