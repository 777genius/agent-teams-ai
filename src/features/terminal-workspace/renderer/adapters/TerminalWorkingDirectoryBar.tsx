import { useCallback } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Folder, GitBranch, Github } from 'lucide-react';

import { formatWorkingDirectory } from '../model/terminalPathPresentation';

const TERMINAL_PLATFORM_GITHUB_URL = 'https://github.com/777genius/terminal-platform';

export const TerminalWorkingDirectoryBar = ({
  projectPath,
  gitBranch,
}: {
  projectPath?: string | null;
  gitBranch?: string | null;
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const label = formatWorkingDirectory(projectPath, t('terminalWorkspace.shellDefaultDirectory'));
  const openTerminalPlatformRepository = useCallback((): void => {
    if (window.electronAPI?.openExternal) {
      void window.electronAPI.openExternal(TERMINAL_PLATFORM_GITHUB_URL);
      return;
    }

    window.open(TERMINAL_PLATFORM_GITHUB_URL, '_blank', 'noopener,noreferrer');
  }, []);

  return (
    <div
      className="flex min-h-6 min-w-0 items-center justify-between gap-3 bg-transparent px-3 text-[11px] text-slate-400"
      data-testid="agent-team-terminal-working-directory"
      title={projectPath || t('terminalWorkspace.shellDefaultDirectory')}
    >
      <div className="flex min-w-0 items-center gap-1">
        <Folder size={12} className="shrink-0 text-slate-500" />
        <span className="sr-only">{t('terminalWorkspace.currentWorkingDirectory')}</span>
        <span className="min-w-0 truncate font-mono text-slate-300">{label}</span>
        {gitBranch ? (
          <span
            className="inline-flex max-w-[14rem] shrink-0 items-center gap-1 rounded-full border border-white/10 bg-white/[0.035] px-1.5 py-0.5 font-mono text-[10px] text-slate-300"
            title={t('terminalWorkspace.gitBranchTitle', { branch: gitBranch })}
          >
            <GitBranch size={11} className="shrink-0 text-slate-500" />
            <span className="min-w-0 truncate">{gitBranch}</span>
          </span>
        ) : null}
      </div>
      <button
        type="button"
        className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.025] px-2 py-0.5 text-[10px] font-medium text-slate-400 transition-colors hover:border-sky-300/30 hover:bg-sky-300/10 hover:text-slate-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-300/60"
        aria-label={t('terminalWorkspace.openTerminalPlatformRepository')}
        title={t('terminalWorkspace.openTerminalPlatformRepository')}
        onClick={openTerminalPlatformRepository}
      >
        <span>{t('terminalWorkspace.poweredByTerminalPlatform')}</span>
        <Github size={11} className="shrink-0" />
      </button>
    </div>
  );
};
