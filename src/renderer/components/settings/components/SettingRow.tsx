/**
 * SettingRow - Setting row component for consistent layout.
 * Linear-style clean row with optional icon.
 */

interface SettingRowProps {
  readonly label: string;
  readonly description?: string;
  readonly icon?: React.ReactNode;
  readonly children: React.ReactNode;
  readonly wrapControls?: boolean;
}

export const SettingRow = ({
  label,
  description,
  icon,
  children,
  wrapControls = false,
}: SettingRowProps): React.JSX.Element => {
  return (
    <div
      className={wrapControls ? "flex flex-wrap items-center justify-between gap-2 border-b py-3" : "flex items-center justify-between border-b py-3"}
      style={{ borderColor: 'var(--color-border-subtle)' }}
    >
      <div className={wrapControls ? "flex min-w-0 basis-44 flex-1 items-start gap-2.5" : "flex items-start gap-2.5"}>
        {icon ? (
          <div className="mt-0.5 shrink-0" style={{ color: 'var(--color-text-muted)' }}>
            {icon}
          </div>
        ) : null}
        <div className={wrapControls ? "min-w-0 break-words" : undefined}>
          <div className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
            {label}
          </div>
          {description && (
            <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              {description}
            </div>
          )}
        </div>
      </div>
      <div className={wrapControls ? "min-w-0 max-w-full" : "shrink-0"}>{children}</div>
    </div>
  );
};
