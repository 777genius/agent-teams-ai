import type { HostActivityFact, HostMemberActivityLog as Log } from '@shared/types/teamActivity';
function latestFacts(events: HostActivityFact[]): HostActivityFact[] {
  const latest = new Map<string, HostActivityFact>();
  for (const event of events) {
    const data = event.data;
    const key =
      data.kind === 'text'
        ? `${event.inputId}:text:${data.messageRef}:${data.block}`
        : data.kind === 'tool' || data.kind === 'tool-result'
          ? `${event.inputId}:${data.kind}:${data.toolRef}`
          : data.kind === 'usage'
            ? `${event.inputId}:usage`
            : event.eventId;
    latest.set(key, event);
  }
  return [...latest.values()].sort((a, b) => a.sequence - b.sequence);
}
export const HostMemberActivityLog = ({
  log,
  expanded,
  onToggle,
}: {
  log: Log;
  expanded: boolean;
  onToggle(): void;
}) => {
  return (
    <div className="rounded-md border border-[var(--color-border)] text-xs">
      <button
        type="button"
        className="w-full px-3 py-2 text-left"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        {log.memberName || 'Task'} · Captured runtime activity{' '}
        {log.generation ? `· generation ${log.generation}` : ''}
        <span className="ml-2 text-[var(--color-text-muted)]">
          {log.messageCount} observed messages · timestamps unavailable
        </span>
      </button>
      {log.gaps.length > 0 && (
        <p role="status" className="px-3 pb-2 text-amber-500">
          Partial activity: {log.gaps.join('; ')}
        </p>
      )}
      {expanded && (
        <div className="space-y-2 border-t border-[var(--color-border)] p-3">
          {latestFacts(log.events).map((event) => (
            <div key={event.eventId} className="break-words">
              <span className="text-[var(--color-text-muted)]">
                #{event.sequence} {event.data.kind}
              </span>
              <pre className="whitespace-pre-wrap">
                {event.data.kind === 'text' ? event.data.text : JSON.stringify(event.data, null, 2)}
              </pre>
            </div>
          ))}
          {log.events.length === 0 && <p>No retained content facts are available.</p>}
        </div>
      )}
    </div>
  );
};
