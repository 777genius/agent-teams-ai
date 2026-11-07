import { GitDiffFallback as PortableGitDiffFallback } from '@agent-teams/task-change-ledger/review-git';
import { canUseGitWithoutMacInstallerPrompt } from '@main/utils/gitAvailability';
import { createManagedGitEnv, getManagedGitExecutable } from '@main/utils/managedGit';

/** Keep the extracted review adapter independent of Electron's Git distribution. */
export class GitDiffFallback extends PortableGitDiffFallback {
  constructor() {
    super(async () => {
      const executable = getManagedGitExecutable();
      if (executable === 'git' && !(await canUseGitWithoutMacInstallerPrompt())) return null;
      return { executable, env: createManagedGitEnv(process.env, { gitCommand: true }) };
    });
  }
}
