import type { ProjectFolderElectronApi } from '@features/project-folder/contracts';

export async function resolveConfigOnlyCwd(input: {
  cwdMode: 'project' | 'custom';
  cwd: string;
  projectFolder: Pick<ProjectFolderElectronApi['projectFolder'], 'getState'> | undefined;
}): Promise<string | undefined> {
  const cwd = input.cwd.trim();
  if (!cwd) return undefined;
  if (input.cwdMode === 'project') return cwd;

  try {
    const folderState = await input.projectFolder?.getState({ path: cwd });
    if (!folderState || folderState.state === 'invalid' || folderState.state === 'not_directory') {
      return undefined;
    }
    return cwd;
  } catch {
    return undefined;
  }
}
