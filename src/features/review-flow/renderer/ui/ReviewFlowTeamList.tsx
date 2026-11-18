import { useState } from 'react';

import { Button } from '@renderer/components/ui/button';

import { toReadableMessage } from '../state/createReviewFlowStore';

export interface ReviewFlowTeamListRow {
  teamName: string;
  displayName: string;
  /** Second line, for example the team's flow. */
  detail?: string;
}

interface ReviewFlowTeamListProps {
  /** Already translated, including the count. */
  heading: string;
  rows: ReviewFlowTeamListRow[];
  /** Shown instead of the list when there are no rows; the whole section is hidden when omitted. */
  emptyText?: string;
  resetLabel: string;
  resetAriaLabel: (displayName: string) => string;
  errorText: (message: string) => string;
  /** Makes a row open that team; rows are plain text when omitted. */
  onSelect?: (teamName: string) => void;
  onReset: (teamName: string) => Promise<void>;
  testIdPrefix: string;
}

/** Teams that need attention in the review-flow settings, each with a one-click reset to the default. */
export const ReviewFlowTeamList = ({
  heading,
  rows,
  emptyText,
  resetLabel,
  resetAriaLabel,
  errorText,
  onSelect,
  onReset,
  testIdPrefix,
}: Readonly<ReviewFlowTeamListProps>): React.JSX.Element | null => {
  const [busyTeam, setBusyTeam] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (rows.length === 0 && emptyText === undefined) return null;

  const handleReset = (teamName: string): void => {
    setBusyTeam(teamName);
    setError(null);
    onReset(teamName)
      .catch((cause: unknown) => setError(toReadableMessage(cause)))
      .finally(() => setBusyTeam(null));
  };

  const headingId = `${testIdPrefix}-heading`;
  return (
    <section className="space-y-2" aria-labelledby={headingId} data-testid={`${testIdPrefix}-list`}>
      <h3 id={headingId} className="text-sm font-semibold">
        {heading}
      </h3>
      {rows.length === 0 ? (
        <p className="text-xs text-[var(--color-text-muted)]">{emptyText}</p>
      ) : (
        <ul className="divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)]">
          {rows.map((row) => {
            const content = (
              <>
                <span className="block truncate font-medium text-[var(--color-text)]">
                  {row.displayName}
                </span>
                {row.detail ? (
                  <span className="block truncate text-xs text-[var(--color-text-muted)]">
                    {row.detail}
                  </span>
                ) : null}
              </>
            );
            return (
              <li
                key={row.teamName}
                className="flex items-center justify-between gap-2 px-2.5 py-1.5"
              >
                {onSelect ? (
                  <button
                    type="button"
                    className="min-w-0 flex-1 rounded text-start text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-border-emphasis)]"
                    data-testid={`${testIdPrefix}-open-${row.teamName}`}
                    onClick={() => onSelect(row.teamName)}
                  >
                    {content}
                  </button>
                ) : (
                  <div className="min-w-0 flex-1 text-sm">{content}</div>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busyTeam === row.teamName}
                  aria-label={resetAriaLabel(row.displayName)}
                  data-testid={`${testIdPrefix}-reset-${row.teamName}`}
                  onClick={() => handleReset(row.teamName)}
                >
                  {resetLabel}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {error ? (
        <p role="alert" className="text-xs text-red-400">
          {errorText(error)}
        </p>
      ) : null}
    </section>
  );
};
