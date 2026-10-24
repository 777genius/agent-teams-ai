import * as path from 'node:path';

import { isPathWithinRoot, validateFileName } from '@main/utils/pathValidation';

import { SkillImportService } from './SkillImportService';
import { SkillPlanService } from './SkillPlanService';
import { SkillRootsResolver } from './SkillRootsResolver';
import { SkillScaffoldService } from './SkillScaffoldService';
import { SkillsCatalogService } from './SkillsCatalogService';

import type { LocalSkillMutationExecutor } from './LocalSkillMutationExecutor';
import type {
  SkillDeleteRequest,
  SkillDetail,
  SkillImportRequest,
  SkillReviewPreview,
  SkillUpsertRequest,
} from '@shared/types/extensions';

export class SkillsMutationService {
  constructor(
    private readonly executor: LocalSkillMutationExecutor,
    private readonly rootsResolver = new SkillRootsResolver(),
    private readonly catalogService = new SkillsCatalogService(),
    private readonly scaffoldService = new SkillScaffoldService(rootsResolver),
    private readonly importService = new SkillImportService(),
    private readonly planService = new SkillPlanService()
  ) {}

  async previewUpsert(request: SkillUpsertRequest): Promise<SkillReviewPreview> {
    const targetSkillDir = await this.scaffoldService.resolveUpsertTarget(
      request.scope,
      request.rootKind,
      request.projectPath,
      request.folderName,
      request.existingSkillId
    );
    const files = this.scaffoldService.normalizeDraftFiles(request.files);
    const plan = await this.planService.buildUpsertPlan(targetSkillDir, files);
    return this.executor.preview(plan, request);
  }

  async applyUpsert(request: SkillUpsertRequest): Promise<SkillDetail | null> {
    if (!request.reviewPlanId) {
      throw new Error('Review the skill changes before saving.');
    }

    const targetSkillDir = await this.scaffoldService.resolveUpsertTarget(
      request.scope,
      request.rootKind,
      request.projectPath,
      request.folderName,
      request.existingSkillId
    );
    await this.executor.apply(request.reviewPlanId, request);

    return this.catalogService.getDetail(targetSkillDir, request.projectPath);
  }

  async previewImport(request: SkillImportRequest): Promise<SkillReviewPreview> {
    const { sourceDir, targetSkillDir } = await this.resolveImportTarget(request);
    const inspection = await this.importService.inspectSourceDir(sourceDir);
    const plan = await this.planService.buildImportPlan(targetSkillDir, inspection.files);
    return this.executor.preview(
      {
        ...plan,
        preview: {
          ...plan.preview,
          warnings: [...new Set([...inspection.warnings, ...plan.preview.warnings])],
        },
      },
      request
    );
  }

  async applyImport(request: SkillImportRequest): Promise<SkillDetail | null> {
    if (!request.reviewPlanId) {
      throw new Error('Review the import changes before saving.');
    }

    const { targetSkillDir } = await this.resolveImportTarget(request);
    await this.executor.apply(request.reviewPlanId, request);

    return this.catalogService.getDetail(targetSkillDir, request.projectPath);
  }

  async deleteSkill(request: SkillDeleteRequest): Promise<void> {
    const skillDir = this.resolveExistingSkill(request.skillId, request.projectPath);
    await this.executor.deleteSkill(skillDir, request.projectPath);
  }

  private async resolveImportTarget(
    request: SkillImportRequest
  ): Promise<{ sourceDir: string; targetSkillDir: string }> {
    const sourceDir = await this.importService.validateSourceDir(request.sourceDir);

    const root = this.resolveWritableRoot(request.scope, request.rootKind, request.projectPath);

    const folderName = request.folderName?.trim() || path.basename(sourceDir);
    const folderValidation = validateFileName(folderName);
    if (!folderValidation.valid) {
      throw new Error(folderValidation.error ?? 'Invalid folder name');
    }

    const targetSkillDir = path.join(root.rootPath, folderName);
    if (!isPathWithinRoot(targetSkillDir, root.rootPath)) {
      throw new Error('Import destination is outside the allowed root');
    }

    return { sourceDir, targetSkillDir };
  }

  private resolveWritableRoot(
    scope: SkillUpsertRequest['scope'],
    rootKind: SkillUpsertRequest['rootKind'],
    projectPath?: string
  ) {
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

  private resolveExistingSkill(skillId: string, projectPath?: string): string {
    const normalizedSkillDir = path.resolve(skillId);
    const roots = this.rootsResolver.resolve(projectPath);
    const owningRoot = roots.find((root) => isPathWithinRoot(normalizedSkillDir, root.rootPath));
    if (!owningRoot) {
      throw new Error('Skill is outside the allowed roots');
    }
    return normalizedSkillDir;
  }
}
