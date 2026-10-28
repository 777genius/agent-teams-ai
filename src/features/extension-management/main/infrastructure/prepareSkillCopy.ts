import path from 'node:path';

import { SkillImportService } from '@main/services/extensions/skills/SkillImportService';
import { SkillPlanService } from '@main/services/extensions/skills/SkillPlanService';
import { SkillRootsResolver } from '@main/services/extensions/skills/SkillRootsResolver';
import { validateFileName } from '@main/utils/pathValidation';

import { exactChanges } from '../adapters/output/createLocalSkillMutationExecutor';

import { canonicalExtensionPath } from './captureAuthoringRoots';
import { resolveSkillCopySources } from './resolveSkillCopySources';

import type {
  LocalSkillChange,
  ManagementSession,
  SkillCopyDestination,
  SkillCopyReview,
} from '../../contracts';

/** Reuses local import inspection; only the chosen inventoried Skill may supply bytes. */
export async function prepareSkillCopy(
  managedPaths: readonly string[],
  authoringRoots: NonNullable<ManagementSession['authoringRoots']>,
  destination: SkillCopyDestination
): Promise<{ preview: SkillCopyReview; change: LocalSkillChange }> {
  const source = (await resolveSkillCopySources(managedPaths, authoringRoots)).find(
    (item) => item.id === destination.candidateId
  );
  if (!source) throw new Error('The installed Skill copy source changed. Choose it again.');
  if (!validateFileName(destination.folderName).valid)
    throw new Error('Choose a valid destination folder name.');
  const selected = new SkillRootsResolver()
    .resolve()
    .find((root) => root.rootKind === destination.rootKind);
  if (!selected) throw new Error('The requested local Skill root is unavailable.');
  const physical = await canonicalExtensionPath(selected.rootPath);
  const root = authoringRoots.find((item) => item.path === physical && item.scope === 'user');
  if (!root) throw new Error('The destination is outside the captured authoring roots.');
  const target = await canonicalExtensionPath(path.join(root.path, destination.folderName));
  if (path.dirname(target) !== root.path || target === source.sourceDir)
    throw new Error('Choose a separate local folder for the copy.');
  const imports = new SkillImportService();
  const inspection = await imports.inspectSourceDir(
    await imports.validateSourceDir(source.sourceDir)
  );
  const plan = await new SkillPlanService().buildImportPlan(target, inspection.files);
  return {
    preview: { ...plan.preview, warnings: [...inspection.warnings, ...plan.preview.warnings] },
    change: {
      action: 'upsert',
      rootId: root.id,
      skillName: path.basename(target),
      files: await exactChanges(plan),
    },
  };
}
