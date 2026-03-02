import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteAsync } from './atomicWrite';

import type { HunkDecision } from '@shared/types';

const logger = createLogger('ReviewDecisionStore');

export interface ReviewDecisionsData {
  hunkDecisions: Record<string, HunkDecision>;
  fileDecisions: Record<string, HunkDecision>;
  /** filePath -> (hunkIndex -> contextHash) */
  hunkContextHashesByFile?: Record<string, Record<number, string>>;
  updatedAt: string;
}

export class ReviewDecisionStore {
  private getDirPath(teamName: string): string {
    return path.join(getTeamsBasePath(), teamName, 'review-decisions');
  }

  private getFilePath(teamName: string, scopeKey: string): string {
    return path.join(this.getDirPath(teamName), `${scopeKey}.json`);
  }

  async load(
    teamName: string,
    scopeKey: string
  ): Promise<{
    hunkDecisions: Record<string, HunkDecision>;
    fileDecisions: Record<string, HunkDecision>;
    hunkContextHashesByFile?: Record<string, Record<number, string>>;
  } | null> {
    const filePath = this.getFilePath(teamName, scopeKey);

    let raw: string;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      logger.error(`Failed to read review decisions for ${teamName}/${scopeKey}: ${String(error)}`);
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      logger.error(`Corrupted review decisions file for ${teamName}/${scopeKey}`);
      return null;
    }

    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const data = parsed as Partial<ReviewDecisionsData>;

    const hunkDecisions: Record<string, HunkDecision> =
      data.hunkDecisions && typeof data.hunkDecisions === 'object' ? data.hunkDecisions : {};
    const fileDecisions: Record<string, HunkDecision> =
      data.fileDecisions && typeof data.fileDecisions === 'object' ? data.fileDecisions : {};
    const hunkContextHashesByFile: Record<string, Record<number, string>> | undefined =
      data.hunkContextHashesByFile && typeof data.hunkContextHashesByFile === 'object'
        ? data.hunkContextHashesByFile
        : undefined;

    return { hunkDecisions, fileDecisions, hunkContextHashesByFile };
  }

  async save(
    teamName: string,
    scopeKey: string,
    data: {
      hunkDecisions: Record<string, HunkDecision>;
      fileDecisions: Record<string, HunkDecision>;
      hunkContextHashesByFile?: Record<string, Record<number, string>>;
    }
  ): Promise<void> {
    try {
      const payload: ReviewDecisionsData = {
        hunkDecisions: data.hunkDecisions,
        fileDecisions: data.fileDecisions,
        hunkContextHashesByFile: data.hunkContextHashesByFile,
        updatedAt: new Date().toISOString(),
      };
      await atomicWriteAsync(
        this.getFilePath(teamName, scopeKey),
        JSON.stringify(payload, null, 2)
      );
    } catch (error) {
      logger.error(`Failed to save review decisions for ${teamName}/${scopeKey}: ${String(error)}`);
    }
  }

  async clear(teamName: string, scopeKey: string): Promise<void> {
    try {
      await fs.promises.unlink(this.getFilePath(teamName, scopeKey));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error(
          `Failed to clear review decisions for ${teamName}/${scopeKey}: ${String(error)}`
        );
      }
    }
  }
}
