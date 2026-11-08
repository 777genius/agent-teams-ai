import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { ArrowLeft } from 'lucide-react';

/** Mirrors the Create Team page geometry while the lazy form bundle resolves. */
export const CreateTeamPageLoadingFallback = ({
  isCopy,
  onClose,
}: Readonly<{
  isCopy: boolean;
  onClose: () => void;
}>): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const { t: common } = useAppTranslation('common');
  return (
    <section
      data-testid="create-team-page"
      data-testid-loading="skeleton"
      aria-busy="true"
      aria-label={isCopy ? t('create.title.copy') : t('create.title.create')}
      className="flex size-full min-h-0 min-w-0 flex-col overflow-y-auto overflow-x-hidden"
    >
      <header className="sticky top-0 z-10 flex items-start gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onClose}
          aria-label={t('create.actions.backToTeams', { defaultValue: 'Back to teams' })}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0">
          <h1 className="text-base font-semibold text-[var(--color-text)]">
            {isCopy ? t('create.title.copy') : t('create.title.create')}
          </h1>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            {isCopy ? t('create.description.copy') : t('create.description.create')}
          </p>
        </div>
      </header>
      <div
        role="status"
        aria-label={common('states.loading')}
        className="mx-auto w-full max-w-[64rem] min-w-0 space-y-5 px-4 pb-6 pt-4"
      >
        <span className="sr-only">{common('states.loading')}</span>
        <div aria-hidden="true" className="space-y-5">
          <div className="space-y-2">
            <div className="skeleton-shimmer h-3 w-24 rounded" />
            <div className="skeleton-shimmer h-8 w-full max-w-[24rem] rounded-md border border-[var(--color-border)]" />
          </div>
          <div className="skeleton-shimmer h-9 w-full max-w-[26rem] rounded-md border border-[var(--color-border)]" />

          <div className="space-y-4">
            <div className="skeleton-shimmer h-4 w-20 rounded" />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-4">
                <div className="skeleton-shimmer size-4 rounded" />
                <div className="skeleton-shimmer h-3 w-20 rounded" />
                <div className="skeleton-shimmer h-8 w-24 rounded-md" />
              </div>
              <div className="skeleton-shimmer h-8 w-28 rounded-md" />
            </div>
            <div className="space-y-3 border-t border-[var(--color-border)] pt-4">
              {[0, 1].map((member) => (
                <div
                  key={member}
                  className="flex min-h-12 flex-wrap items-center gap-3"
                  data-testid="create-team-loading-member"
                >
                  <div className="skeleton-shimmer size-9 shrink-0 rounded-full" />
                  <div className="skeleton-shimmer h-8 w-36 max-w-full rounded-md" />
                  <div className="skeleton-shimmer h-8 w-32 max-w-full rounded-md" />
                  <div className="skeleton-shimmer h-8 w-44 max-w-full rounded-md" />
                  <div className="skeleton-shimmer size-5 rounded" />
                </div>
              ))}
            </div>
          </div>
          <div className="space-y-4 rounded-lg border border-[var(--color-border-emphasis)] bg-[var(--color-surface-overlay)] p-4">
            <div className="flex items-center gap-3">
              <div className="skeleton-shimmer size-4 rounded" />
              <div className="skeleton-shimmer h-4 w-48 rounded" />
            </div>
            <div className="skeleton-shimmer h-3 w-64 max-w-full rounded" />
            <div className="space-y-2">
              <div className="skeleton-shimmer h-3 w-16 rounded" />
              <div className="skeleton-shimmer h-9 w-full rounded-md" />
            </div>
            <div className="border-t border-[var(--color-border)] pt-3">
              <div className="skeleton-shimmer h-4 w-48 rounded" />
            </div>
          </div>
          <div className="border-t border-[var(--color-border)] pt-4">
            <div className="skeleton-shimmer h-4 w-52 rounded" />
          </div>
        </div>
      </div>
    </section>
  );
};
