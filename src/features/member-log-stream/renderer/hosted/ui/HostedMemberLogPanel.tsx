import { Button } from '@renderer/components/ui/button';
import { Loader2, RefreshCw } from 'lucide-react';

import { useHostedMemberLog } from '../hooks/useHostedMemberLog';

import type { HostedMemberLogSelectionId } from '../../../contracts/hosted';
import type { HostedMemberLogTransport } from '../ports/HostedMemberLogRendererPorts';

export interface HostedMemberLogPanelProps {
  readonly selectionId: HostedMemberLogSelectionId;
  readonly transport: HostedMemberLogTransport;
  readonly enabled?: boolean;
  readonly heading?: string;
}

export const HostedMemberLogPanel = ({
  selectionId,
  transport,
  enabled = true,
  heading = 'Member log',
}: HostedMemberLogPanelProps): React.JSX.Element => {
  const log = useHostedMemberLog({ selectionId, transport, enabled });
  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{heading}</h2>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Refresh member log"
          disabled={!enabled || log.loading || log.loadingMore}
          onClick={() => void log.reload()}
        >
          {log.loading ? (
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
          ) : (
            <RefreshCw aria-hidden="true" className="size-4" />
          )}
        </Button>
      </div>
      {log.loading && log.entries.length === 0 ? (
        <p role="status" className="mt-3 text-sm text-[var(--color-text-muted)]">
          Loading member log…
        </p>
      ) : null}
      {log.error !== null ? (
        <p role="alert" className="mt-3 text-sm text-red-500">
          {log.error}
        </p>
      ) : null}
      {!log.loading && log.error === null && log.entries.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--color-text-muted)]">No member log entries.</p>
      ) : null}
      {log.entries.length > 0 ? (
        <ol aria-label="Member log entries" className="mt-3 space-y-2">
          {log.entries.map((entry) => (
            <li key={entry.entryId} className="rounded-md bg-[var(--color-surface-raised)] p-3">
              <p className="text-xs font-medium uppercase">{entry.level}</p>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm">{entry.text}</p>
            </li>
          ))}
        </ol>
      ) : null}
      {log.nextCursor !== null ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3 w-full"
          disabled={log.loadingMore}
          onClick={() => void log.loadMore()}
        >
          {log.loadingMore ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : null}
          Load more entries
        </Button>
      ) : null}
    </section>
  );
};
