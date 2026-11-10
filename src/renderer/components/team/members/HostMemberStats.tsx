import type { HostMemberActivityStats } from '@shared/types/teamActivity';
/** Existing Stats surface reports only available normalized Runtime facts. */
export const HostMemberStats = ({ stats }: { stats: HostMemberActivityStats }) => {
  const value = (amount: number | null) => (amount === null ? 'Unknown' : amount.toLocaleString());
  const cards = [
    ['Reported input tokens', value(stats.inputTokens)],
    ['Reported output tokens', value(stats.outputTokens)],
    ['Reported cost (USD)', stats.costUsd === null ? 'Unknown' : stats.costUsd.toFixed(6)],
    ['Observed messages', value(stats.observedMessages)],
    [
      'Observed tool calls',
      value(Object.values(stats.toolUsage).reduce((sum, count) => sum + count, 0)),
    ],
    ['Compaction observations', value(stats.compactions)],
  ];
  return (
    <div className="space-y-3 text-xs">
      <p className="text-[var(--color-text-muted)]">
        Retained runtime activity across {stats.generations} captured generations. Native
        timestamps, cache tokens, file/line totals and complete lifetime usage are unavailable.
        Child activity stays separate in Logs; parent usage reports may already include child work.
      </p>
      {stats.gaps.length > 0 && (
        <p role="status" className="text-amber-500">
          Activity is partial: {stats.gaps.join('; ')}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {cards.map(([label, count]) => (
          <div key={label} className="rounded-md border border-[var(--color-border)] p-3">
            <div className="text-lg">{count}</div>
            <div>{label}</div>
          </div>
        ))}
      </div>
      {Object.entries(stats.toolUsage).map(([name, count]) => (
        <div key={name}>
          {name}: {count} observed calls
        </div>
      ))}
    </div>
  );
};
