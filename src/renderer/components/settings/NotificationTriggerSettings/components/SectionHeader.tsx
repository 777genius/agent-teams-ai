/**
 * Section header component - Linear style.
 */

interface SectionHeaderProps {
  title: string;
}

export const SectionHeader = ({ title }: Readonly<SectionHeaderProps>): React.JSX.Element => {
  return (
    <h3 className="mb-2 mt-6 text-xs font-medium uppercase tracking-widest text-text-muted first:mt-0">
      {title}
    </h3>
  );
};
