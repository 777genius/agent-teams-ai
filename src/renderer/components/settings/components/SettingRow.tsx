/**
 * SettingRow - Setting row component for consistent layout.
 * Linear-style clean row with optional icon.
 */

interface SettingRowProps {
  readonly label: string;
  readonly description?: string;
  readonly icon?: React.ReactNode;
  readonly children: React.ReactNode;
}

export const SettingRow = ({
  label,
  description,
  icon,
  children,
}: SettingRowProps): React.JSX.Element => {
  return (
    <div
      className="flex items-center justify-between border-b py-3"
      style={{ borderColor: 'var(--color-border-subtle)' }}
    >
      <div className="flex items-start gap-2.5">
        {icon ? (
          <div className="mt-0.5 shrink-0" style={{ color: 'var(--color-text-muted)' }}>
            {icon}
          </div>
        ) : null}
        <div>
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
      <div className="shrink-0">{children}</div>
    </div>
  );
};
