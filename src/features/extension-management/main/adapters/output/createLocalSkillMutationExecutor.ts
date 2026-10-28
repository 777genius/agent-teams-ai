import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { isDefinitiveManagementRefusal } from '../../infrastructure/managementErrorPolicy';

import type { LocalSkillChange, ManagementOperation, ManagementPlan } from '../../../contracts';
import type { ExtensionManagementFeature } from '../../../core/application/ports';
import type {
  LocalSkillMutationExecutor,
  LocalSkillReviewRequest,
} from '@main/services/extensions/skills/LocalSkillMutationExecutor';
import type { SkillExecutionPlan } from '@main/services/extensions/skills/SkillPlanService';

interface RetainedLocalReview {
  contextId: string;
  plan: ManagementPlan;
  requestId: string;
  requestDigest: string;
  attempted: boolean;
  discarding?: Promise<void>;
}
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function requestDigest(request: LocalSkillReviewRequest): string {
  const { reviewPlanId: _reviewPlanId, ...input } = request;
  return digest(
    JSON.stringify(input, (_key, value: unknown) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return Object.fromEntries(
          Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
        );
      }
      return value;
    })
  );
}
export async function exactChanges(
  plan: SkillExecutionPlan
): Promise<NonNullable<LocalSkillChange['files']>> {
  if (plan.changes.length > 200)
    throw new Error('A local Skill review supports at most 200 files.');
  let bytes = 0;
  const files: NonNullable<LocalSkillChange['files']> = [];
  for (const change of plan.changes) {
    const next =
      change.action === 'delete'
        ? null
        : change.isBinary
          ? await readFile(change.sourceAbsolutePath ?? '')
          : Buffer.from(change.newContent ?? '', 'utf8');
    bytes += next?.byteLength ?? 0;
    if (bytes > 10 * 1024 * 1024) throw new Error('A local Skill review supports at most 10 MiB.');
    files.push({
      relativePath: change.relativePath,
      expectedSHA256: change.expectedSHA256,
      contentBase64: next === null ? null : next.toString('base64'),
    });
  }
  return files;
}
const terminal = (operation: ManagementOperation) =>
  !['queued', 'running'].includes(operation.state);

export function createLocalSkillMutationExecutor(
  feature: ExtensionManagementFeature
): LocalSkillMutationExecutor {
  const reviews = new Map<string, RetainedLocalReview>();
  const deletions = new Map<string, RetainedLocalReview>();
  async function contextFor(skillPath: string, projectPath?: string) {
    const context = await feature.capture({
      client: 'claude',
      scope: 'user',
      ...(projectPath ? { authoringProject: projectPath } : {}),
    });
    const status = await feature.localSkillStatus({ contextId: context.contextId, skillPath });
    if (status.ownership === 'managed') {
      throw new Error(
        `This Skill is managed by UAP (${status.alias}). Use Managed Skills actions or make a separate local copy.`
      );
    }
    return { contextId: context.contextId, status };
  }
  async function retain(
    contextId: string,
    plan: ManagementPlan,
    inputDigest: string
  ): Promise<RetainedLocalReview> {
    try {
      if (!plan.confirmable)
        throw new Error(
          plan.conflicts.map((item) => item.message).join('\n') ||
            'The local Skill change cannot be applied.'
        );
      for (const [id, entry] of reviews) {
        if (!entry.attempted && Date.parse(entry.plan.expiresAt) <= Date.now()) {
          reviews.delete(id);
          void feature.discardPlan({ contextId: entry.contextId, planId: id }).catch(() => {});
        }
      }
      if (reviews.size >= 128)
        throw new Error('Finish or close existing Skill reviews before preparing more changes.');
      const retained = {
        contextId,
        plan,
        requestId: randomUUID(),
        requestDigest: inputDigest,
        attempted: false,
      };
      reviews.set(plan.planId, retained);
      return retained;
    } catch (error) {
      await feature.discardPlan({ contextId, planId: plan.planId }).catch(() => {});
      throw error;
    }
  }
  async function apply(retained: RetainedLocalReview): Promise<void> {
    if (retained.discarding)
      throw new Error('This Skill review is closing. Review the changes again.');
    retained.attempted = true;
    let operation: ManagementOperation;
    try {
      operation = await feature.apply({
        contextId: retained.contextId,
        planId: retained.plan.planId,
        requestId: retained.requestId,
      });
    } catch (error) {
      if (isDefinitiveManagementRefusal(error)) reviews.delete(retained.plan.planId);
      throw error;
    }
    const deadline = Date.now() + 120_000;
    while (!terminal(operation)) {
      if (Date.now() >= deadline)
        throw new Error(
          'The Skill change is still running. Open Extensions → Skills to inspect its result.'
        );
      await new Promise((resolve) => setTimeout(resolve, 100));
      operation = await feature.operation({
        contextId: retained.contextId,
        operationId: operation.operationId,
      });
    }
    if (operation.state !== 'succeeded') {
      const unchanged =
        (operation.state === 'failed' || operation.state === 'canceled') &&
        operation.result?.mutated === false &&
        !operation.result.nextActions.some((action) => /recover|repair|inspect/.test(action.kind));
      if (unchanged || operation.resolvedBy) reviews.delete(retained.plan.planId);
      throw new Error(
        `${operation.result?.message || `Skill change ${operation.state}.`} Open Extensions → Skills to inspect recovery.`
      );
    }
    reviews.delete(retained.plan.planId);
  }
  return {
    async preview(plan, request) {
      const { contextId, status } = await contextFor(
        plan.preview.targetSkillDir,
        request.projectPath
      );
      const prepared = await feature.prepareLocalSkill({
        contextId,
        change: {
          action: 'upsert',
          rootId: status.rootId,
          skillName: status.skillName,
          files: await exactChanges(plan),
        },
      });
      await retain(contextId, prepared, requestDigest(request));
      return {
        ...plan.preview,
        planId: prepared.planId,
        warnings: [...plan.preview.warnings, ...prepared.warnings.map((item) => item.message)],
      };
    },
    async discardReview(reviewPlanId) {
      const retained = reviews.get(reviewPlanId);
      if (!retained || retained.attempted) return;
      retained.discarding ??= feature
        .discardPlan({ contextId: retained.contextId, planId: reviewPlanId })
        .then(() => {
          if (reviews.get(reviewPlanId) === retained) reviews.delete(reviewPlanId);
        })
        .catch((error: unknown) => {
          retained.discarding = undefined;
          throw error;
        });
      await retained.discarding;
    },
    async apply(reviewPlanId, request) {
      const retained = reviews.get(reviewPlanId);
      if (!retained || retained.requestDigest !== requestDigest(request)) {
        throw new Error(
          'The Skill request changed after review. Review the current changes again.'
        );
      }
      await apply(retained);
    },
    async deleteSkill(skillDir, projectPath) {
      let retained = deletions.get(skillDir);
      if (!retained) {
        const { contextId, status } = await contextFor(skillDir, projectPath);
        const plan = await feature.prepareLocalSkill({
          contextId,
          change: { action: 'delete', rootId: status.rootId, skillName: status.skillName },
        });
        retained = await retain(contextId, plan, skillDir);
        deletions.set(skillDir, retained);
      }
      try {
        await apply(retained);
      } catch (error) {
        if (!reviews.has(retained.plan.planId)) deletions.delete(skillDir);
        throw error;
      }
      deletions.delete(skillDir);
    },
  };
}
