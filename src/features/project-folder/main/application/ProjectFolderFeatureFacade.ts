import type { ProjectFolderCreateResult, ProjectFolderStateResult } from '../../contracts';

export interface ProjectFolderFeatureFacade {
  getState(input: unknown): Promise<ProjectFolderStateResult>;
  create(input: unknown): Promise<ProjectFolderCreateResult>;
}
