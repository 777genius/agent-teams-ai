import { Fragment, type ReactNode } from 'react';

import type { TeamDirectoryRow } from '../core/domain/teamDirectory';

export interface TeamDirectoryRowsProps<T extends TeamDirectoryRow> {
  readonly rows: readonly T[];
  readonly renderRow: (row: T) => ReactNode;
  readonly className?: string;
  readonly ariaLabel?: string;
  readonly as: 'div' | 'ul';
}

/** Presentation only. The source and shell retain read and navigation ownership. */
export const TeamDirectoryRows = <T extends TeamDirectoryRow>({
  rows,
  renderRow,
  className,
  ariaLabel,
  as,
}: TeamDirectoryRowsProps<T>): React.JSX.Element => {
  const children = rows.map((row) => (
    <Fragment key={`${row.scopeKey}:${row.targetKey}`}>{renderRow(row)}</Fragment>
  ));
  return as === 'ul' ? (
    <ul aria-label={ariaLabel} className={className}>
      {children}
    </ul>
  ) : (
    <div aria-label={ariaLabel} className={className}>
      {children}
    </div>
  );
};
