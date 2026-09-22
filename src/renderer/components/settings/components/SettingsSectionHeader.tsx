/**
 * SettingsSectionHeader - Section header component.
 * Linear-style subtle label with optional icon.
 */

interface SettingsSectionHeaderProps {
  readonly title: string;
  readonly icon?: React.ReactNode;
}

export const SettingsSectionHeader = ({
  title,
  icon,
}: SettingsSectionHeaderProps): React.JSX.Element => {
  return (
    <h3
      className="mb-2 mt-6 flex items-center gap-1.5 text-xs font-medium uppercase tracking-widest first:mt-0"
      style={{ color: 'var(--color-text-muted)' }}
    >
      {icon}
      {title}
    </h3>
  );
};
