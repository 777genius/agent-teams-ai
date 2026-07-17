import { atomicWriteAsync, unlinkPathDurably } from '@main/utils/atomicWrite';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { FileReviewDecision, HunkDecision } from '@shared/types';

const logger = createLogger('ReviewDecisionStore');
const TEAM_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
const SCOPE_KEY_PATTERN = /^(?:task|agent)-[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/;
const MAX_STORED_DECISIONS_BYTES = 32 * 1024 * 1024;
const MAX_STORED_DECISION_ENTRIES = 200_000;
const MAX_STORED_CONTEXT_FILES = 2_000;
const MAX_STORED_KEY_LENGTH = 32_768;

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

class InvalidReviewDecisionDataError extends Error {}

export class ReviewDecisionStore {
  private assertSafeScope(teamName: string, scopeKey: string, scopeToken?: string): void {
    if (typeof teamName !== 'string' || !TEAM_NAME_PATTERN.test(teamName)) {
      throw new Error('Invalid review decision team name');
    }
    if (typeof scopeKey !== 'string' || !SCOPE_KEY_PATTERN.test(scopeKey)) {
      throw new Error('Invalid review decision scope key');
    }
    if (
      scopeToken !== undefined &&
      (typeof scopeToken !== 'string' ||
        scopeToken.length === 0 ||
        scopeToken.length > MAX_STORED_DECISIONS_BYTES ||
        scopeToken.includes('\0'))
    ) {
      throw new Error('Invalid review decision scope token');
    }
  }

  private getLegacyDirPath(teamName: string): string {
    return path.join(getTeamsBasePath(), teamName, 'review-decisions');
  }

  private getLegacyFilePath(teamName: string, scopeKey: string): string {
    return path.join(this.getLegacyDirPath(teamName), `${scopeKey}.json`);
  }

  private getV2DirPath(teamName: string, scopeKey: string): string {
    return path.join(this.getLegacyDirPath(teamName), 'v2', encodeURIComponent(scopeKey));
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

    if (
      !this.isDecisionRecord(data.hunkDecisions) ||
      !this.isDecisionRecord(data.fileDecisions) ||
      !this.isContextHashRecord(data.hunkContextHashesByFile)
    ) {
      return null;
    }

    return data as ReviewDecisionsData | ReviewDecisionsDataV2;
  }

  private isDecisionRecord(value: unknown): value is Record<string, HunkDecision> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const entries = Object.entries(value);
    return (
      entries.length <= MAX_STORED_DECISION_ENTRIES &&
      entries.every(
        ([key, decision]) =>
          key.length > 0 &&
          key.length <= MAX_STORED_KEY_LENGTH &&
          (decision === 'accepted' || decision === 'rejected' || decision === 'pending')
      )
    );
  }

  private isContextHashRecord(
    value: unknown
  ): value is Record<string, Record<number, string>> | undefined {
    if (value === undefined) return true;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const files = Object.entries(value as Record<string, unknown>);
    if (files.length > MAX_STORED_CONTEXT_FILES) return false;
    let totalHashes = 0;
    for (const [filePath, hashes] of files) {
      if (
        filePath.length === 0 ||
        filePath.length > MAX_STORED_KEY_LENGTH ||
        !hashes ||
        typeof hashes !== 'object' ||
        Array.isArray(hashes)
      ) {
        return false;
      }
      const entries = Object.entries(hashes);
      totalHashes += entries.length;
      if (totalHashes > MAX_STORED_DECISION_ENTRIES) return false;
      if (
        entries.some(
          ([index, hash]) =>
            !/^(0|[1-9]\d*)$/.test(index) || typeof hash !== 'string' || hash.length > 256
        )
      ) {
        return false;
      }
    }
    return true;
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
    scopeToken?: string,
    expectedScopeKey?: string
  ): Promise<{
    hunkDecisions: Record<string, HunkDecision>;
    fileDecisions: Record<string, HunkDecision>;
    hunkContextHashesByFile?: Record<string, Record<number, string>>;
  } | null> {
    let handle: fs.promises.FileHandle | null = null;
    let raw: string;
    try {
      const pathStats = await fs.promises.lstat(filePath);
      if (pathStats.isSymbolicLink()) {
        throw new Error('Unsafe review decisions symlink');
      }
      handle = await fs.promises.open(filePath, 'r');
      const stats = await handle.stat();
      if (
        !stats.isFile() ||
        stats.nlink !== 1 ||
        stats.size > MAX_STORED_DECISIONS_BYTES ||
        stats.dev !== pathStats.dev ||
        stats.ino !== pathStats.ino
      ) {
        throw new Error('Unsafe or oversized review decisions file');
      }
      raw = await handle.readFile({ encoding: 'utf8' });
      const latestPathStats = await fs.promises.lstat(filePath);
      if (
        latestPathStats.isSymbolicLink() ||
        latestPathStats.dev !== stats.dev ||
        latestPathStats.ino !== stats.ino
      ) {
        throw new Error('Review decisions changed while being read');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      logger.error(`Failed to read review decisions at ${filePath}: ${String(error)}`);
      throw error;
    } finally {
      try {
        await handle?.close();
      } catch {
        // The read is complete; close failure does not make the parsed snapshot ambiguous.
      }
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      logger.error(`Corrupted review decisions file at ${filePath}`);
      throw new InvalidReviewDecisionDataError(`Corrupted review decisions file at ${filePath}`, {
        cause: error,
      });
    }

    const data = this.parseStoredData(parsed);
    if (!data) {
      throw new InvalidReviewDecisionDataError(`Invalid review decisions payload at ${filePath}`);
    }
    if ('version' in data && data.version === 2 && data.scopeKey !== expectedScopeKey) {
      throw new InvalidReviewDecisionDataError(`Mismatched review decision scope at ${filePath}`);
    }
    return this.extractDecisions(data, scopeToken);
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
      staleFiles.map((entry) => fs.promises.unlink(entry.filePath).catch(() => undefined))
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
    this.assertSafeScope(teamName, scopeKey, scopeToken);
    if (scopeToken) {
      const exact = await this.loadFromPath(
        this.getV2FilePath(teamName, scopeKey, scopeToken),
        scopeToken,
        scopeKey
      );
      if (exact) {
        return exact;
      }
    }

    return this.loadFromPath(this.getLegacyFilePath(teamName, scopeKey), scopeToken, scopeKey);
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
    this.assertSafeScope(teamName, scopeKey, data.scopeToken);
    if (
      !this.isDecisionRecord(data.hunkDecisions) ||
      !this.isDecisionRecord(data.fileDecisions) ||
      !this.isContextHashRecord(data.hunkContextHashesByFile)
    ) {
      throw new Error('Invalid review decisions payload');
    }
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
      const serialized = JSON.stringify(payload, null, 2);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_STORED_DECISIONS_BYTES) {
        throw new Error('Review decisions payload exceeds the durable storage limit');
      }
      await atomicWriteAsync(filePath, serialized, {
        durability: 'strict',
        syncDirectory: true,
      });
      await this.pruneScopeDir(teamName, scopeKey);
    } catch (error) {
      logger.error(`Failed to save review decisions for ${teamName}/${scopeKey}: ${String(error)}`);
      throw error;
    }
  }

  async mergeFileDecisionPatch(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    decision: FileReviewDecision & { reviewKey: string }
  ): Promise<void> {
    this.assertSafeScope(teamName, scopeKey, scopeToken);
    if (
      !decision.reviewKey ||
      decision.reviewKey.length > MAX_STORED_KEY_LENGTH ||
      decision.reviewKey.includes('\0')
    ) {
      throw new Error('Invalid review decision patch key');
    }
    const current = (await this.load(teamName, scopeKey, scopeToken)) ?? {
      hunkDecisions: {},
      fileDecisions: {},
      hunkContextHashesByFile: {},
    };
    const hunkDecisions = { ...current.hunkDecisions };
    const fileDecisions = { ...current.fileDecisions };
    const hunkContextHashesByFile = { ...(current.hunkContextHashesByFile ?? {}) };
    const prefixes = [`${decision.reviewKey}:`, `${decision.filePath}:`];
    for (const key of Object.keys(hunkDecisions)) {
      if (prefixes.some((prefix) => key.startsWith(prefix))) delete hunkDecisions[key];
    }
    delete fileDecisions[decision.reviewKey];
    delete fileDecisions[decision.filePath];
    delete hunkContextHashesByFile[decision.reviewKey];
    delete hunkContextHashesByFile[decision.filePath];

    for (const [index, value] of Object.entries(decision.hunkDecisions)) {
      if (value !== 'pending') hunkDecisions[`${decision.reviewKey}:${index}`] = value;
    }
    if (decision.fileDecision !== 'pending') {
      fileDecisions[decision.reviewKey] = decision.fileDecision;
    }
    if (decision.hunkContextHashes) {
      hunkContextHashesByFile[decision.reviewKey] = decision.hunkContextHashes;
    }

    await this.save(teamName, scopeKey, {
      scopeToken,
      hunkDecisions,
      fileDecisions,
      hunkContextHashesByFile,
    });
  }

  async clear(teamName: string, scopeKey: string, scopeToken?: string): Promise<void> {
    this.assertSafeScope(teamName, scopeKey, scopeToken);
    try {
      if (scopeToken) {
        await unlinkPathDurably(this.getV2FilePath(teamName, scopeKey, scopeToken)).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          }
        );
        const legacyPath = this.getLegacyFilePath(teamName, scopeKey);
        let legacy;
        try {
          legacy = await this.loadFromPath(legacyPath, scopeToken, scopeKey);
        } catch (error) {
          if (!(error instanceof InvalidReviewDecisionDataError)) throw error;
          // Explicit recovery: a corrupt coarse legacy snapshot cannot safely serve
          // any exact token, so discarding it is the only deterministic clear action.
          await unlinkPathDurably(legacyPath).catch((unlinkError: NodeJS.ErrnoException) => {
            if (unlinkError.code !== 'ENOENT') throw unlinkError;
          });
          return;
        }
        if (legacy) {
          await unlinkPathDurably(legacyPath).catch((error: NodeJS.ErrnoException) => {
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
        throw error;
      }
    }
  }
}
