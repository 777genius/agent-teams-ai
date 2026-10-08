import { useAppTranslation } from '@features/localization/renderer';

export const TerminalTabContentSkeleton = (): React.JSX.Element => {
  const { t } = useAppTranslation('team');

  return (
    <div
      className="pointer-events-none absolute inset-0 z-20 border-t border-white/10 bg-[#080c14] px-6 py-5 backdrop-blur-xl"
      data-testid="agent-team-terminal-content-skeleton"
      aria-label={t('terminalWorkspace.loadingTerminalTab')}
    >
      <div className="flex h-full flex-col justify-end gap-6">
        {[0, 1, 2].map((sectionIndex) => (
          <div key={sectionIndex} className="space-y-3 border-t border-white/[0.06] pt-4">
            <div className="h-3 w-2/3 max-w-[34rem] animate-pulse rounded bg-white/10" />
            <div className="h-4 w-1/2 max-w-[24rem] animate-pulse rounded bg-white/[0.15]" />
            <div className="h-3 w-1/3 max-w-[18rem] animate-pulse rounded bg-white/[0.08]" />
          </div>
        ))}
      </div>
    </div>
  );
};
