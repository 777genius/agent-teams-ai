import type { SettingsSection } from './SettingsTabs';

interface SettingsLoadingSkeletonProps {
  label: string;
  activeSection: SettingsSection;
}

export const SettingsLoadingSkeleton = ({
  label,
  activeSection,
}: SettingsLoadingSkeletonProps): React.JSX.Element => {
  return (
    <div
      role="status"
      aria-label={label}
      aria-busy="true"
      className="flex min-h-0 min-w-0 flex-1 bg-[var(--color-surface)]"
    >
      <div aria-hidden="true" className="min-w-0 flex-1 overflow-hidden">
        <div
          className={`mx-auto w-full px-6 py-8 ${
            activeSection === 'notifications'
              ? 'max-w-7xl'
              : activeSection === 'providers'
                ? 'max-w-5xl'
                : 'max-w-2xl'
          }`}
        >
          {[0, 1, 2].map((group) => (
            <div key={group} className={group === 0 ? '' : 'mt-6'}>
              <div className="skeleton-shimmer mb-3 h-3 w-24 rounded bg-[var(--skeleton-base)] motion-reduce:after:animate-none" />
              <div className="flex min-h-16 items-center justify-between gap-4 border-b border-[var(--color-border)] py-3">
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="skeleton-shimmer h-3 w-36 max-w-full rounded bg-[var(--skeleton-base)] motion-reduce:after:animate-none" />
                  <div className="skeleton-shimmer h-2.5 w-64 max-w-full rounded bg-[var(--skeleton-base)] motion-reduce:after:animate-none" />
                </div>
                <div className="skeleton-shimmer h-7 w-24 shrink-0 rounded-md bg-[var(--skeleton-base)] motion-reduce:after:animate-none max-sm:w-12" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
