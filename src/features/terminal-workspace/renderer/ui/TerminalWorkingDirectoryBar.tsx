import { useAppTranslation } from '@features/localization/renderer';
import { Folder, GitBranch, Github } from 'lucide-react';

import { formatWorkingDirectory } from '../model/terminalPathPresentation';

import { TerminalButtonTooltip } from './TerminalButtonTooltip';

export interface TerminalWorkingDirectoryBarProps {
  projectPath?: string | null;
  gitBranch?: string | null;
  onOpenTerminalPlatformRepository: () => void;
}

export const TerminalWorkingDirectoryBar = ({
  projectPath,
  gitBranch,
  onOpenTerminalPlatformRepository,
}: TerminalWorkingDirectoryBarProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const defaultDirectory = t('terminalWorkspace.shellDefaultDirectory');
  const label = formatWorkingDirectory(projectPath, defaultDirectory);

  return (
    <div
      className="flex min-h-6 min-w-0 items-center justify-between gap-3 bg-transparent px-3 text-[11px] text-slate-400"
      data-testid="agent-team-terminal-working-directory"
    >
      <div className="flex min-w-0 items-center gap-1">
        <Folder size={12} className="shrink-0 text-slate-500" />
        <span className="sr-only">{t('terminalWorkspace.currentWorkingDirectory')}</span>
        <TerminalButtonTooltip label={projectPath || defaultDirectory}>
          <span className="min-w-0 truncate font-mono text-slate-300">{label}</span>
        </TerminalButtonTooltip>
        {gitBranch ? (
          <TerminalButtonTooltip
            label={t('terminalWorkspace.gitBranchTitle', { branch: gitBranch })}
          >
            <span className="inline-flex max-w-[14rem] shrink-0 items-center gap-1 rounded-full border border-white/10 bg-white/[0.035] px-1.5 py-0.5 font-mono text-[10px] text-slate-300">
              <GitBranch size={11} className="shrink-0 text-slate-500" />
              <span className="min-w-0 truncate">{gitBranch}</span>
            </span>
          </TerminalButtonTooltip>
        ) : null}
      </div>
      <TerminalButtonTooltip label={t('terminalWorkspace.openTerminalPlatformRepository')}>
        <button
          type="button"
          className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.025] px-2 py-0.5 text-[10px] font-medium text-slate-400 transition-colors hover:border-sky-300/30 hover:bg-sky-300/10 hover:text-slate-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-300/60"
          aria-label={t('terminalWorkspace.openTerminalPlatformRepository')}
          onClick={onOpenTerminalPlatformRepository}
        >
          <span>{t('terminalWorkspace.poweredByTerminalPlatform')}</span>
          <Github size={11} className="shrink-0" />
        </button>
      </TerminalButtonTooltip>
    </div>
  );
};
