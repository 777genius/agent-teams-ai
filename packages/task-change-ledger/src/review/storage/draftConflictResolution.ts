import { unlinkPathDurably } from '../io/atomicPersistence.js';
import { quarantineConstrainedPersistenceFile } from '../io/safePersistenceDirectory.js';
import * as fs from 'fs';
import * as path from 'path';
import type {
  ReviewDraftHistoryConflictCandidate,
  ReviewDraftHistoryConflictCandidateSummary,
  ReviewDraftHistoryEntry,
  ReviewDraftHistorySnapshot,
} from './draftContracts.js';
import type { ReviewConflictResolution } from '../../contracts.js';
import {
  type SaveReviewDraftHistoryEntryInput,
  InvalidReviewDraftHistoryError,
  shouldQuarantineDraftConflictCandidate,
  getScopeTokenHash,
  conflictEntriesEqual,
  isValidGeneration,
  type DraftContext,
} from './DraftTypes.js';

export function createDraftConflictResolution(getContext: () => DraftContext) {
  return {
    async load(
      teamName: string,
      scopeKey: string,
      scopeToken: string
    ): Promise<ReviewDraftHistorySnapshot | null> {
      const ctx = getContext();
      ctx.assertSafeScope(teamName, scopeKey, scopeToken);
      const stored = await ctx.readStored(teamName, scopeKey, scopeToken);
      return stored ? { entries: stored.entries } : null;
    },
    async mapConflictCandidates<T extends { id: string; capturedAt: string }>(
      teamName: string,
      scopeKey: string,
      scopeToken: string,
      mapCandidate: (candidate: ReviewDraftHistoryConflictCandidate) => T
    ): Promise<T[]> {
      const ctx = getContext();
      ctx.assertSafeScope(teamName, scopeKey, scopeToken);
      const currentScopeHash = getScopeTokenHash(scopeToken);
      const conflictScopes = await ctx.inspectConflictScopes(teamName, scopeKey);
      const stored = await ctx.readStored(teamName, scopeKey, scopeToken);
      const candidates: T[] = [];
      let quarantinedCount = 0;
      for (const sourceScopeHash of [...conflictScopes.scopeHashes].sort()) {
        const dirPath = ctx.getConflictCandidateDirByScopeHash(teamName, scopeKey, sourceScopeHash);
        const entries = await fs.promises.readdir(dirPath);
        for (const entry of entries.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
          const candidatePath = path.join(dirPath, entry);
          try {
            const candidate = await ctx.loadConflictCandidateFromPath(
              candidatePath,
              scopeKey,
              sourceScopeHash,
              currentScopeHash
            );
            const current = stored?.entries[candidate.filePath];
            candidates.push(
              mapCandidate({
                ...candidate,
                observedCurrentRevision: current?.revision ?? 0,
                observedCurrentGeneration: current?.generation ?? null,
              })
            );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            if (!shouldQuarantineDraftConflictCandidate(error)) throw error;
            try {
              await quarantineConstrainedPersistenceFile(
                ctx.teamsRoot,
                candidatePath,
                path.join(dirPath, 'quarantine')
              );
            } catch (quarantineError) {
              if ((quarantineError as NodeJS.ErrnoException).code === 'ENOENT') continue;
              throw quarantineError;
            }
            quarantinedCount += 1;
            ctx.logger.warn(`Quarantined unreadable manual-edit recovery copy: ${String(error)}`);
          }
        }
      }
      if (quarantinedCount > 0) {
        throw new InvalidReviewDraftHistoryError(
          `${quarantinedCount} unreadable manual-edit recovery copy was quarantined; retry recovery check`
        );
      }
      return candidates.sort(
        (left, right) =>
          Date.parse(right.capturedAt) - Date.parse(left.capturedAt) ||
          left.id.localeCompare(right.id)
      );
    },
    async loadConflictCandidates(
      teamName: string,
      scopeKey: string,
      scopeToken: string
    ): Promise<ReviewDraftHistoryConflictCandidate[]> {
      const ctx = getContext();
      return ctx.mapConflictCandidates(teamName, scopeKey, scopeToken, (candidate) => candidate);
    },
    async loadConflictCandidateSummaries(
      teamName: string,
      scopeKey: string,
      scopeToken: string
    ): Promise<ReviewDraftHistoryConflictCandidateSummary[]> {
      const ctx = getContext();
      return ctx.mapConflictCandidates(teamName, scopeKey, scopeToken, (candidate) => ({
        id: candidate.id,
        capturedAt: candidate.capturedAt,
        origin: candidate.origin,
        recoverability: 'recoverable',
        filePath: candidate.filePath,
        expectedRevision: candidate.expectedRevision,
        expectedGeneration: candidate.expectedGeneration,
        observedCurrentRevision: candidate.observedCurrentRevision,
        observedCurrentGeneration: candidate.observedCurrentGeneration,
        entryRevision: candidate.entry?.revision ?? null,
      }));
    },
    async locateConflictCandidate(
      teamName: string,
      scopeKey: string,
      scopeToken: string,
      candidateId: string
    ): Promise<{ candidatePath: string; candidate: ReviewDraftHistoryConflictCandidate }> {
      const ctx = getContext();
      if (!/^[a-f0-9]{64}$/.test(candidateId)) {
        throw new Error('Invalid review draft history conflict candidate id');
      }
      const currentScopeHash = getScopeTokenHash(scopeToken);
      const conflictScopes = await ctx.inspectConflictScopes(teamName, scopeKey);
      let located: {
        candidatePath: string;
        candidate: ReviewDraftHistoryConflictCandidate;
      } | null = null;
      for (const sourceScopeHash of conflictScopes.scopeHashes) {
        const candidatePath = path.join(
          ctx.getConflictCandidateDirByScopeHash(teamName, scopeKey, sourceScopeHash),
          `${candidateId}.json`
        );
        try {
          const candidate = await ctx.loadConflictCandidateFromPath(
            candidatePath,
            scopeKey,
            sourceScopeHash,
            currentScopeHash
          );
          if (located) throw new Error('Ambiguous review draft history conflict candidate');
          located = { candidatePath, candidate };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
      }
      if (!located) throw new Error('Manual-edit recovery copy is unavailable');
      return located;
    },
    async loadConflictCandidate(
      teamName: string,
      scopeKey: string,
      scopeToken: string,
      candidateId: string
    ): Promise<ReviewDraftHistoryConflictCandidate> {
      const ctx = getContext();
      ctx.assertSafeScope(teamName, scopeKey, scopeToken);
      const { candidate } = await ctx.locateConflictCandidate(
        teamName,
        scopeKey,
        scopeToken,
        candidateId
      );
      const stored = await ctx.readStored(teamName, scopeKey, scopeToken);
      const current = stored?.entries[candidate.filePath];
      return {
        ...candidate,
        observedCurrentRevision: current?.revision ?? 0,
        observedCurrentGeneration: current?.generation ?? null,
      };
    },
    async resolveConflictCandidate(
      teamName: string,
      scopeKey: string,
      scopeToken: string,
      candidateId: string,
      resolution: ReviewConflictResolution,
      expectedCurrentRevision: number,
      expectedCurrentGeneration: string | null
    ): Promise<ReviewDraftHistoryEntry | null> {
      const ctx = getContext();
      ctx.assertSafeScope(teamName, scopeKey, scopeToken);
      if (
        (resolution !== 'recover-candidate' && resolution !== 'keep-current') ||
        !Number.isSafeInteger(expectedCurrentRevision) ||
        expectedCurrentRevision < 0 ||
        (expectedCurrentRevision === 0
          ? expectedCurrentGeneration !== null
          : !isValidGeneration(expectedCurrentGeneration))
      ) {
        throw new Error('Invalid review draft conflict resolution');
      }
      const { candidatePath, candidate } = await ctx.locateConflictCandidate(
        teamName,
        scopeKey,
        scopeToken,
        candidateId
      );
      const stored = await ctx.readStored(teamName, scopeKey, scopeToken);
      const current = stored?.entries[candidate.filePath];
      if (
        (current?.revision ?? 0) !== expectedCurrentRevision ||
        (current?.generation ?? null) !== expectedCurrentGeneration
      ) {
        throw new Error('Saved manual edit history changed again; reload recovery choices');
      }
      if (resolution === 'keep-current') {
        await unlinkPathDurably(candidatePath);
        return current ?? null;
      }
      if (candidate.entry === null) {
        if (!current) {
          await unlinkPathDurably(candidatePath);
          return null;
        }
        await ctx.writeConflictCandidate(
          teamName,
          scopeKey,
          scopeToken,
          {
            filePath: current.filePath,
            codec: current.codec,
            revision: current.revision + 1,
            diskBaseline: current.diskBaseline,
            editorState: current.editorState,
            expectedRevision: current.revision,
            expectedGeneration: current.generation,
          },
          current.revision + 1,
          current.generation,
          candidatePath
        );
        await ctx.clearEntry(
          teamName,
          scopeKey,
          scopeToken,
          current.filePath,
          current.revision,
          current.generation
        );
        await unlinkPathDurably(candidatePath);
        return null;
      }
      if (
        current &&
        current.filePath === candidate.entry.filePath &&
        current.codec === candidate.entry.codec &&
        current.diskBaseline === candidate.entry.diskBaseline &&
        JSON.stringify(current.editorState) === JSON.stringify(candidate.entry.editorState)
      ) {
        await unlinkPathDurably(candidatePath);
        return current;
      }
      if (current) {
        // Preserve the canonical editor branch before publishing the selected recovery
        // branch. The backup is itself a normal candidate, so switching remains reversible.
        await ctx.writeConflictCandidate(
          teamName,
          scopeKey,
          scopeToken,
          {
            filePath: current.filePath,
            codec: current.codec,
            revision: current.revision + 1,
            diskBaseline: current.diskBaseline,
            editorState: current.editorState,
            expectedRevision: current.revision,
            expectedGeneration: current.generation,
          },
          current.revision + 1,
          current.generation,
          candidatePath
        );
      } else {
        await ctx.writeEmptyConflictCandidate(
          teamName,
          scopeKey,
          scopeToken,
          candidate.filePath,
          candidatePath
        );
      }
      const recovered = await ctx.saveEntry(teamName, scopeKey, scopeToken, {
        ...candidate.entry,
        expectedRevision: expectedCurrentRevision,
        expectedGeneration: expectedCurrentGeneration,
        revision: expectedCurrentRevision + 1,
      });
      await unlinkPathDurably(candidatePath);
      return recovered;
    },
    async replaceConflictCandidate(
      teamName: string,
      scopeKey: string,
      scopeToken: string,
      expectedEntry: Omit<ReviewDraftHistoryEntry, 'updatedAt' | 'generation'>,
      replacementEntry: Omit<ReviewDraftHistoryEntry, 'updatedAt' | 'generation'>,
      expectedCurrentRevision: number,
      expectedCurrentGeneration: string | null
    ): Promise<ReviewDraftHistoryConflictCandidate> {
      const ctx = getContext();
      ctx.assertSafeScope(teamName, scopeKey, scopeToken);
      const candidate = (
        await ctx.mapConflictCandidates(teamName, scopeKey, scopeToken, (entry) => ({
          id: entry.id,
          capturedAt: entry.capturedAt,
          candidate:
            entry.origin === 'current-snapshot' &&
            entry.entry &&
            conflictEntriesEqual(entry.entry, expectedEntry)
              ? entry
              : null,
        }))
      ).find((entry) => entry.candidate)?.candidate;
      if (!candidate) throw new Error('Manual-edit recovery predecessor is unavailable');
      const candidateId = candidate.id;
      const candidatePath = ctx.getConflictCandidatePath(
        teamName,
        scopeKey,
        scopeToken,
        candidateId
      );
      await ctx.ensureConflictCandidateDir(teamName, scopeKey, scopeToken);
      if (replacementEntry.filePath !== candidate.filePath) {
        throw new Error('Manual-edit recovery update changed file identity');
      }
      const input: SaveReviewDraftHistoryEntryInput = {
        ...replacementEntry,
        expectedRevision: candidate.expectedRevision,
        expectedGeneration: candidate.expectedGeneration,
      };
      ctx.assertEntry(input);
      const stored = await ctx.readStored(teamName, scopeKey, scopeToken);
      const current = stored?.entries[candidate.filePath];
      if (
        (current?.revision ?? 0) !== expectedCurrentRevision ||
        (current?.generation ?? null) !== expectedCurrentGeneration
      ) {
        throw new Error('Saved manual edit history changed again; reload recovery choices');
      }
      const replacement = await ctx.writeConflictCandidate(
        teamName,
        scopeKey,
        scopeToken,
        input,
        expectedCurrentRevision,
        expectedCurrentGeneration,
        candidatePath
      );
      if (replacement.id !== candidateId) {
        await unlinkPathDurably(candidatePath);
      }
      return replacement;
    },
  };
}
