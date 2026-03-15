import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { SkillCatalogItem, SkillDirectoryFlags } from '@shared/types/extensions';

import { SkillMetadataParser, type SkillRelatedFiles } from './SkillMetadataParser';
import type { ResolvedSkillRoot } from './SkillRootsResolver';

const SKILL_FILE_CANDIDATES = ['SKILL.md', 'Skill.md', 'skill.md'] as const;

export class SkillScanner {
  constructor(private readonly parser = new SkillMetadataParser()) {}

  async scanRoot(root: ResolvedSkillRoot): Promise<SkillCatalogItem[]> {
    try {
      const rootStat = await fs.stat(root.rootPath);
      if (!rootStat.isDirectory()) return [];
    } catch {
      return [];
    }

    const dirEntries = await fs.readdir(root.rootPath, { withFileTypes: true });
    const skillDirs = dirEntries.filter((entry) => entry.isDirectory());

    const skills = await Promise.all(
      skillDirs.map(async (entry) => {
        const skillDir = path.join(root.rootPath, entry.name);
        const skillFile = await this.detectSkillFile(skillDir);
        if (!skillFile) return null;

        const [rawContent, stat, flags] = await Promise.all([
          fs.readFile(skillFile, 'utf8'),
          fs.stat(skillFile),
          this.readFlags(skillDir),
        ]);

        return this.parser.parseCatalogItem({
          skillDir,
          folderName: entry.name,
          skillFile,
          rawContent,
          modifiedAt: stat.mtimeMs,
          flags,
          root,
        });
      })
    );

    return skills.filter((entry): entry is SkillCatalogItem => entry !== null);
  }

  async detectSkillFile(skillDir: string): Promise<string | null> {
    for (const candidate of SKILL_FILE_CANDIDATES) {
      const filePath = path.join(skillDir, candidate);
      try {
        const stat = await fs.stat(filePath);
        if (stat.isFile()) return filePath;
      } catch {
        // ignore
      }
    }

    return null;
  }

  async readFlags(skillDir: string): Promise<SkillDirectoryFlags> {
    const [hasScripts, hasReferences, hasAssets] = await Promise.all([
      this.directoryExists(path.join(skillDir, 'scripts')),
      this.directoryExists(path.join(skillDir, 'references')),
      this.directoryExists(path.join(skillDir, 'assets')),
    ]);

    return { hasScripts, hasReferences, hasAssets };
  }

  async readRelatedFiles(skillDir: string): Promise<SkillRelatedFiles> {
    const [referencesFiles, scriptFiles, assetFiles] = await Promise.all([
      this.listRelativeFiles(path.join(skillDir, 'references')),
      this.listRelativeFiles(path.join(skillDir, 'scripts')),
      this.listRelativeFiles(path.join(skillDir, 'assets')),
    ]);

    return { referencesFiles, scriptFiles, assetFiles };
  }

  private async listRelativeFiles(targetDir: string, prefix = ''): Promise<string[]> {
    try {
      const stat = await fs.stat(targetDir);
      if (!stat.isDirectory()) return [];
    } catch {
      return [];
    }

    const dirEntries = await fs.readdir(targetDir, { withFileTypes: true });
    const files = await Promise.all(
      dirEntries.map(async (entry) => {
        const relativePath = prefix ? path.join(prefix, entry.name) : entry.name;
        const fullPath = path.join(targetDir, entry.name);
        if (entry.isDirectory()) {
          return this.listRelativeFiles(fullPath, relativePath);
        }
        return [relativePath];
      })
    );

    return files.flat().sort((a, b) => a.localeCompare(b));
  }

  private async directoryExists(targetDir: string): Promise<boolean> {
    try {
      const stat = await fs.stat(targetDir);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }
}
