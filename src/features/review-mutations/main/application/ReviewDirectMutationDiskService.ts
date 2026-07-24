import type {
  ReviewMutationJournalDiskStep,
  ReviewMutationJournalRecord,
} from '../../core/application/ReviewMutationJournalTypes';
import type {
  DirectReviewMutationState,
  ReviewDirectMutationDiskDependencies,
  ReviewDirectMutationDiskPort,
  ReviewMutationPathAuthorization,
} from './ReviewMutationRecoveryPorts';
import type {
  ReviewDirectDiskMutationStep,
  ReviewFileScope,
  ReviewMutationDiskPostimage,
} from '@shared/types/review';

export class ReviewDirectMutationDiskService implements ReviewDirectMutationDiskPort {
  constructor(private readonly dependencies: ReviewDirectMutationDiskDependencies) {}

  async normalize(
    steps: readonly ReviewDirectDiskMutationStep[],
    scope: ReviewFileScope,
    authorization: ReviewMutationPathAuthorization
  ): Promise<ReviewMutationJournalDiskStep[]> {
    const ids = new Set<string>();
    const normalized: ReviewMutationJournalDiskStep[] = [];
    for (const step of steps) {
      if (
        !step ||
        typeof step.id !== 'string' ||
        step.id.length === 0 ||
        step.id.length > 256 ||
        ids.has(step.id)
      ) {
        throw new Error('Invalid or duplicate review mutation step id');
      }
      ids.add(step.id);
      const filePath = await this.dependencies.scope.validateFilePath(
        authorization,
        step.filePath,
        { requireReviewedFile: true, rejectHardlinks: true }
      );
      if (step.type === 'write') {
        if (
          typeof step.content !== 'string' ||
          (step.expectedContent !== null && typeof step.expectedContent !== 'string')
        ) {
          throw new Error('Invalid review write mutation');
        }
        normalized.push({ ...step, filePath, status: 'pending' });
        continue;
      }
      if (step.type === 'delete') {
        if (typeof step.expectedContent !== 'string') {
          throw new Error('Invalid review delete mutation');
        }
        normalized.push({ ...step, filePath, status: 'pending' });
        continue;
      }
      if (step.type !== 'restore-rejected-rename' && step.type !== 'reapply-rejected-rename') {
        throw new Error('Invalid review mutation step');
      }
      const expectation = this.dependencies.scope.parseRenameExpectation(step.expectation);
      const authoritativeContent = await this.dependencies.scope.resolveAuthoritativeContent(
        scope,
        authorization,
        filePath
      );
      await this.dependencies.scope.validateSnippets(authorization, authoritativeContent.snippets, {
        requireReviewedFile: true,
        rejectHardlinks: true,
      });
      this.dependencies.scope.assertExpectedRename(authoritativeContent, expectation);
      normalized.push({
        ...step,
        filePath,
        expectation,
        authoritativeContent,
        status: 'pending',
      });
    }
    return normalized;
  }

  async buildPostimages(
    steps: readonly ReviewMutationJournalDiskStep[]
  ): Promise<ReviewMutationDiskPostimage[]> {
    const postimages = new Map<string, ReviewMutationDiskPostimage>();
    for (const step of steps) {
      if (step.type === 'write') {
        this.mergePostimages(postimages, [{ filePath: step.filePath, content: step.content }]);
        continue;
      }
      if (step.type === 'delete') {
        this.mergePostimages(postimages, [{ filePath: step.filePath, content: null }]);
        continue;
      }
      const content = step.authoritativeContent;
      if (!content) throw new Error('Rename recovery content is unavailable');
      this.mergePostimages(
        postimages,
        await this.dependencies.applier.getRejectedRenamePostimages(
          content.originalFullContent,
          content.modifiedFullContent,
          content.snippets,
          step.type === 'restore-rejected-rename' ? 'restore' : 'reapply'
        )
      );
    }
    return [...postimages.values()];
  }

  async buildRecoveryPostimages(
    record: ReviewMutationJournalRecord
  ): Promise<ReviewMutationDiskPostimage[]> {
    if (record.diskSteps) return this.buildPostimages(record.diskSteps);

    const postimages = new Map<string, ReviewMutationDiskPostimage>();
    for (const [index, content] of record.fileContents.entries()) {
      const transitions = (record.decisionTransitions?.[index] ?? []).filter(
        (transition) => transition.beforeContent !== transition.afterContent || transition.operation
      );
      const hasRename = content.snippets.some(
        (snippet) => snippet.ledger?.relation?.kind === 'rename' && !snippet.isError
      );
      if (hasRename && transitions.length > 0) {
        this.mergePostimages(
          postimages,
          await this.dependencies.applier.getRejectedRenamePostimages(
            content.originalFullContent,
            content.modifiedFullContent,
            content.snippets,
            'reapply'
          )
        );
        continue;
      }
      for (const transition of transitions) {
        if (transition.operation === 'move' && transition.relatedFilePath) {
          this.mergePostimages(postimages, [
            { filePath: transition.filePath, content: null },
            { filePath: transition.relatedFilePath, content: transition.afterContent },
          ]);
        } else {
          this.mergePostimages(postimages, [
            { filePath: transition.filePath, content: transition.afterContent },
          ]);
        }
      }
    }
    return [...postimages.values()];
  }

  async classify(step: ReviewMutationJournalDiskStep): Promise<DirectReviewMutationState> {
    if (step.type === 'write') {
      return this.dependencies.applier.classifyEditedFileTransition(
        step.filePath,
        step.expectedContent,
        step.content
      );
    }
    if (step.type === 'delete') {
      return this.dependencies.applier.classifyEditedFileTransition(
        step.filePath,
        step.expectedContent,
        null
      );
    }
    const content = step.authoritativeContent;
    if (!content) throw new Error('Rename recovery content is unavailable');
    const state = await this.dependencies.applier.classifyRejectedRenameTransition(
      step.filePath,
      content.originalFullContent,
      content.modifiedFullContent,
      content.snippets
    );
    if (state === 'both') return 'both';
    const beforeState = step.type === 'restore-rejected-rename' ? 'rejected' : 'accepted';
    const afterState = step.type === 'restore-rejected-rename' ? 'accepted' : 'rejected';
    if (state === beforeState) return 'before';
    if (state === afterState) return 'after';
    const recoverableIntermediate =
      (step.type === 'restore-rejected-rename' && state === 'restoring') ||
      (step.type === 'reapply-rejected-rename' &&
        (state === 'reapplying' || state === 'legacy-reapplying'));
    if (recoverableIntermediate) return 'intermediate';
    throw new Error('Ledger rename is not in the expected durable mutation state');
  }

  async assertPreimages(steps: readonly ReviewMutationJournalDiskStep[]): Promise<void> {
    for (const step of steps) {
      const state = await this.classify(step);
      if (state !== 'before' && state !== 'both') {
        throw new Error('Review mutation preflight failed; no files were changed');
      }
    }
  }

  async apply(record: ReviewMutationJournalRecord): Promise<ReviewMutationJournalRecord> {
    let current = record;
    const steps = current.diskSteps;
    if (!steps?.length) return current;

    try {
      const alreadyAtPostimage = new Set<number>();
      for (const [index, step] of steps.entries()) {
        const state = await this.classify(step);
        if (step.status === 'applied') {
          if (state !== 'after' && state !== 'both') {
            throw new Error('Applied review mutation changed after crash; refusing recovery');
          }
        } else if (state === 'after' || state === 'both') {
          alreadyAtPostimage.add(index);
        }
      }
      if (alreadyAtPostimage.size > 0) {
        current = await this.dependencies.journal.checkpoint({
          ...current,
          diskSteps: current.diskSteps!.map((step, index) =>
            alreadyAtPostimage.has(index) ? { ...step, status: 'applied' as const } : step
          ),
        });
        for (const index of alreadyAtPostimage) {
          const appliedStep = current.diskSteps?.[index];
          if (appliedStep) await this.finalizeArtifacts(appliedStep);
        }
      }
    } catch (error) {
      await this.dependencies.journal.markFailed(current, error).catch((journalError) => {
        this.dependencies.logger.error(
          'Unable to preserve drifted direct review mutation:',
          journalError
        );
      });
      throw error;
    }

    for (let index = 0; index < steps.length; index++) {
      const step = current.diskSteps?.[index];
      if (!step || step.status === 'applied') continue;
      try {
        await this.applyStep(step);
        const postState = await this.classify(step);
        if (postState !== 'after' && postState !== 'both') {
          throw new Error('Review mutation did not reach its durable postimage');
        }
      } catch (error) {
        await this.dependencies.journal.markFailed(current, error).catch((journalError) => {
          this.dependencies.logger.error(
            'Unable to mark failed direct review mutation:',
            journalError
          );
        });
        throw error;
      }
      current = await this.dependencies.journal.checkpoint({
        ...current,
        diskSteps: current.diskSteps!.map((candidate, candidateIndex) =>
          candidateIndex === index ? { ...candidate, status: 'applied' as const } : candidate
        ),
      });
      await this.finalizeArtifacts(step);
      if (step.authoritativeContent) {
        this.dependencies.cache.invalidateAuthoritativeContent(step.authoritativeContent);
      } else {
        this.dependencies.cache.invalidateFile(step.filePath);
      }
    }
    return current;
  }

  private async applyStep(step: ReviewMutationJournalDiskStep): Promise<void> {
    if (step.type === 'write') {
      await this.dependencies.applier.saveEditedFile(
        step.filePath,
        step.content,
        step.expectedContent
      );
      return;
    }
    if (step.type === 'delete') {
      await this.dependencies.applier.deleteEditedFile(step.filePath, step.expectedContent);
      return;
    }
    const content = step.authoritativeContent;
    if (!content) throw new Error('Rename recovery content is unavailable');
    if (step.type === 'restore-rejected-rename') {
      await this.dependencies.applier.restoreRejectedRename(
        step.filePath,
        content.originalFullContent,
        content.modifiedFullContent,
        content.snippets
      );
    } else {
      await this.dependencies.applier.reapplyRejectedRename(
        step.filePath,
        content.originalFullContent,
        content.snippets
      );
    }
  }

  private async finalizeArtifacts(step: ReviewMutationJournalDiskStep): Promise<void> {
    if (step.type === 'write') {
      await this.dependencies.applier.finalizeEditedFileTransaction?.(
        step.filePath,
        step.expectedContent,
        step.content
      );
      return;
    }
    if (step.type === 'delete') {
      await this.dependencies.applier.finalizeEditedFileTransaction?.(
        step.filePath,
        step.expectedContent,
        null
      );
      return;
    }
    const content = step.authoritativeContent;
    if (!content) return;
    await this.dependencies.applier.finalizeRejectedRenameTransaction?.(
      step.filePath,
      content.originalFullContent,
      content.modifiedFullContent,
      content.snippets,
      step.type === 'restore-rejected-rename' ? 'restore' : 'reapply'
    );
  }

  private mergePostimages(
    target: Map<string, ReviewMutationDiskPostimage>,
    postimages: readonly ReviewMutationDiskPostimage[]
  ): void {
    for (const postimage of postimages) {
      target.set(this.dependencies.scope.normalizeIdentityPath(postimage.filePath), postimage);
    }
  }
}
