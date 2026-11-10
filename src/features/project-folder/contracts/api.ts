/**
 * `unknown` covers inaccessible folders and shells without filesystem access;
 * callers must not treat it as missing.
 */
export type ProjectFolderState = 'exists' | 'missing' | 'not_directory' | 'invalid' | 'unknown';

export type ProjectFolderCreateError =
  | 'invalid_path'
  | 'permission_denied'
  | 'path_conflict'
  | 'failed';

export interface ProjectFolderRequest {
  path: string;
}

export interface ProjectFolderStateResult {
  state: ProjectFolderState;
}

export interface ProjectFolderCreateResult extends ProjectFolderStateResult {
  error?: ProjectFolderCreateError;
}

export interface ProjectFolderElectronApi {
  projectFolder: {
    getState(request: ProjectFolderRequest): Promise<ProjectFolderStateResult>;
    create(request: ProjectFolderRequest): Promise<ProjectFolderCreateResult>;
  };
}
