import type { SkillExecutionPlan } from './SkillPlanService';
import type {
  SkillImportRequest,
  SkillReviewPreview,
  SkillUpsertRequest,
} from '@shared/types/extensions';

export type LocalSkillReviewRequest = SkillUpsertRequest | SkillImportRequest;

/** Existing editor previews stay local; a single engine owns every filesystem effect. */
export interface LocalSkillMutationExecutor {
  preview(plan: SkillExecutionPlan, request: LocalSkillReviewRequest): Promise<SkillReviewPreview>;
  apply(reviewPlanId: string, request: LocalSkillReviewRequest): Promise<void>;
  deleteSkill(skillDir: string, projectPath?: string): Promise<void>;
}
