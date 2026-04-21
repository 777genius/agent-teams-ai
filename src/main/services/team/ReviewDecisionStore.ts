import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteAsync } from './atomicWrite';

import type { HunkDecision } from '@shared/types';

const logger = createLogger('ReviewDecisionStore');

export interface ReviewDecisionsData {
  scopeToken?: string;
  hunkDecisions: Record<string, HunkDecision>;
  fileDecisions: Record<string, HunkDecision>;
  /** filePath -> (hunkIndex -> contextHash) */
  hunkContextHashesByFile?: Record<string, Record<number, string>>;
  updatedAt: string;
}

interface ReviewDecisionsDataV2 extends ReviewDecisionsData {
  version: 2;
  scopeKey: string;
  scopeToken: string;
}

export class ReviewDecisionStore {
  private getLegacyDirPath(teamName: string): string {
    return path.join(getTeamsBasePath(), teamName, 'review-decisions');
  }

  private getLegacyFilePath(teamName: string, scopeKey: string): string {
    return path.join(this.getLegacyDirPath(teamName), `${scopeKey}.json`);
  }

  private getV2DirPath(teamName: string, scopeKey: string): string {
    return path.join(
      this.getLegacyDirPath(teamName),
      'v2',
      encodeURIComponent(scopeKey)
    );
  }

  private getV2FilePath(teamName: string, scopeKey: string, scopeToken: string): string {
    const scopeHash = createHash('sha256').update(scopeToken).digest('hex');
    return path.join(this.getV2DirPath(teamName, scopeKey), `${scopeHash}.json`);
  }

  private parseStoredData(parsed: unknown): ReviewDecisionsData | ReviewDecisionsDataV2 | null {
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const data = parsed as Partial<ReviewDecisionsDataV2>;
    const isV2 =
      data.version === 2 &&
      typeof data.scopeKey === 'string' &&
      typeof data.scopeToken === 'string';

    if (data.version !== undefined && !isV2) {
      return null;
    }

    return data as ReviewDecisionsData | ReviewDecisionsDataV2;
  }

  private extractDecisions(
    data: ReviewDecisionsData | ReviewDecisionsDataV2,
    scopeToken?: string
  ): {
    hunkDecisions: Record<string, HunkDecision>;
    fileDecisions: Record<string, HunkDecision>;
    hunkContextHashesByFile?: Record<string, Record<number, string>>;
  } | null {
    const hunkDecisions: Record<string, HunkDecision> =
      data.hunkDecisions && typeof data.hunkDecisions === 'object' ? data.hunkDecisions : {};
    const fileDecisions: Record<string, HunkDecision> =
      data.fileDecisions && typeof data.fileDecisions === 'object' ? data.fileDecisions : {};
    const hunkContextHashesByFile: Record<string, Record<number, string>> | undefined =
      data.hunkContextHashesByFile && typeof data.hunkContextHashesByFile === 'object'
        ? data.hunkContextHashesByFile
        : undefined;

    if (scopeToken) {
      if (typeof data.scopeToken !== 'string' || data.scopeToken !== scopeToken) {
        return null;
      }
    }

    return { hunkDecisions, fileDecisions, hunkContextHashesByFile };
  }

  private async loadFromPath(
    filePath: string,
    scopeToken?: string
  ): Promise<{
    hunkDecisions: Record<string, HunkDecision>;
    fileDecisions: Record<string, HunkDecision>;
    hunkContextHashesByFile?: Record<string, Record<number, string>>;
  } | null> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      logger.error(`Failed to read review decisions at ${filePath}: ${String(error)}`);
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      logger.error(`Corrupted review decisions file at ${filePath}`);
      return null;
    }

    const data = this.parseStoredData(parsed);
    return data ? this.extractDecisions(data, scopeToken) : null;
  }

  private async pruneScopeDir(teamName: string, scopeKey: string): Promise<void> {
    const dirPath = this.getV2DirPath(teamName, scopeKey);
    let entries: string[];
    try {
      entries = await fs.promises.readdir(dirPath);
    } catch {
      return;
    }

    if (entries.length <= 16) {
      return;
    }

    const files = await Promise.all(
      entries
        .filter((entry) => entry.endsWith('.json'))
        .map(async (entry) => {
          const filePath = path.join(dirPath, entry);
          try {
            const stats = await fs.promises.stat(filePath);
            return { filePath, mtimeMs: stats.mtimeMs };
          } catch {
            return null;
          }
        })
    );

    const staleFiles = files
      .filter((entry): entry is { filePath: string; mtimeMs: number } => !!entry)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(16);

    await Promise.all(
      staleFiles.map((entry) =>
        fs.promises.unlink(entry.filePath).catch(() => undefined)
      )
    );
  }

  async load(
    teamName: string,
    scopeKey: string,
    scopeToken?: string
  ): Promise<{
    hunkDecisions: Record<string, HunkDecision>;
      fileDecisions: Record<string, HunkDecision>;
      hunkContextHashesByFile?: Record<string, Record<number, string>>;
  } | null> {
    if (scopeToken) {
      const exact = await this.loadFromPath(
        this.getV2FilePath(teamName, scopeKey, scopeToken),
        scopeToken
      );
      if (exact) {
        return exact;
      }
    }

    return this.loadFromPath(this.getLegacyFilePath(teamName, scopeKey), scopeToken);
  }

  async save(
    teamName: string,
    scopeKey: string,
    data: {
      scopeToken: string;
      hunkDecisions: Record<string, HunkDecision>;
      fileDecisions: Record<string, HunkDecision>;
      hunkContextHashesByFile?: Record<string, Record<number, string>>;
    }
  ): Promise<void> {
    try {
      const payload: ReviewDecisionsDataV2 = {
        version: 2,
        scopeKey,
        scopeToken: data.scopeToken,
        hunkDecisions: data.hunkDecisions,
        fileDecisions: data.fileDecisions,
        hunkContextHashesByFile: data.hunkContextHashesByFile,
        updatedAt: new Date().toISOString(),
      };
      const filePath = this.getV2FilePath(teamName, scopeKey, data.scopeToken);
      await atomicWriteAsync(
        filePath,
        JSON.stringify(payload, null, 2)
      );
      await this.pruneScopeDir(teamName, scopeKey);
    } catch (error) {
      logger.error(`Failed to save review decisions for ${teamName}/${scopeKey}: ${String(error)}`);
    }
  }

  async clear(teamName: string, scopeKey: string, scopeToken?: string): Promise<void> {
    try {
      if (scopeToken) {
        await fs.promises
          .unlink(this.getV2FilePath(teamName, scopeKey, scopeToken))
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
        const legacyPath = this.getLegacyFilePath(teamName, scopeKey);
        const legacy = await this.loadFromPath(legacyPath, scopeToken);
        if (legacy) {
          await fs.promises.unlink(legacyPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
        }
        return;
      }
      await fs.promises.unlink(this.getLegacyFilePath(teamName, scopeKey)).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
      await fs.promises.rm(this.getV2DirPath(teamName, scopeKey), {
        recursive: true,
        force: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error(
          `Failed to clear review decisions for ${teamName}/${scopeKey}: ${String(error)}`
        );
      }
    }
  }
}
