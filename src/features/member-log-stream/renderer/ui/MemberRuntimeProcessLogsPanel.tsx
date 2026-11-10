import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Check, Clipboard, Loader2, RefreshCw } from 'lucide-react';

import {
  createEmptyMemberRuntimeLogTailResponse,
  type MemberRuntimeLogKind,
  type MemberRuntimeLogTailResponse,
  normalizeMemberRuntimeLogTailResponse,
} from '../../contracts';

const PROCESS_LOG_KINDS: MemberRuntimeLogKind[] = ['stdout', 'stderr', 'events'];
const PROCESS_LOG_AUTO_REFRESH_MS = 4000;
const PROCESS_LOG_TAIL_BYTES = 128 * 1024;

export interface MemberRuntimeProcessLogsPanelProps {
  readonly enabled: boolean;
  readonly loadRuntimeLogTail: (input: {
    readonly kind: MemberRuntimeLogKind;
    readonly maxBytes: number;
    readonly forceRefresh?: boolean;
  }) => Promise<MemberRuntimeLogTailResponse | null | undefined>;
}

function formatBytes(bytes: number | undefined): string {
  if (!Number.isFinite(bytes ?? NaN)) return '--';
  const safeBytes = Math.max(0, bytes ?? 0);
  if (safeBytes < 1024) return `${safeBytes} B`;
  const kb = safeBytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}

function buildStatusText(
  log: MemberRuntimeLogTailResponse | null,
  labels: {
    empty: string;
    fileEmpty: string;
    showingLast: (bytes: string) => string;
    showing: (bytes: string) => string;
  }
): string | null {
  if (!log) return null;
  if (log.missing) return labels.empty;
  if (!log.content) return labels.fileEmpty;
  if (log.truncated) return labels.showingLast(formatBytes(log.bytesRead));
  return labels.showing(formatBytes(log.bytesRead));
}

function ProcessLogKindTabs({
  selected,
  onSelect,
}: Readonly<{
  readonly selected: MemberRuntimeLogKind;
  readonly onSelect: (kind: MemberRuntimeLogKind) => void;
}>): React.JSX.Element {
  return (
    <div className="flex rounded-lg bg-[var(--color-surface-subtle)] p-1">
      {PROCESS_LOG_KINDS.map((kind) => (
        <button
          key={kind}
          type="button"
          className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
            selected === kind
              ? 'bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm'
              : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
          }`}
          onClick={() => onSelect(kind)}
        >
          {kind}
        </button>
      ))}
    </div>
  );
}

function ProcessLogVirtualList({
  content,
  wrapLines,
}: Readonly<{
  readonly content: string;
  readonly wrapLines: boolean;
}>): React.JSX.Element {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const lines = useMemo(() => content.split(/\r?\n/), [content]);
  const rowVirtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => (wrapLines ? 36 : 20),
    overscan: 20,
  });

  return (
    <div
      ref={parentRef}
      className="h-[360px] overflow-auto rounded-xl border border-[var(--color-border)] bg-black/40 font-mono text-xs text-[var(--color-text)]"
    >
      <div
        className={wrapLines ? 'min-w-0' : 'min-w-max'}
        style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: 'relative' }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualRow) => (
          <div
            key={virtualRow.key}
            data-index={virtualRow.index}
            ref={rowVirtualizer.measureElement}
            className="absolute left-0 top-0 grid w-full grid-cols-[4rem_minmax(0,1fr)] gap-3 px-3 py-0.5 leading-5"
            style={{ transform: `translateY(${virtualRow.start}px)` }}
          >
            <span className="select-none text-right text-[var(--color-text-subtle)]">
              {virtualRow.index + 1}
            </span>
            <span className={wrapLines ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'}>
              {lines[virtualRow.index] || ' '}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function MemberRuntimeProcessLogsPanel({
  enabled,
  loadRuntimeLogTail,
}: Readonly<MemberRuntimeProcessLogsPanelProps>): React.JSX.Element {
  const { t } = useAppTranslation('team');
  const { t: tCommon } = useAppTranslation('common');
  const [kind, setKind] = useState<MemberRuntimeLogKind>('stdout');
  const [log, setLog] = useState<MemberRuntimeLogTailResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [wrapLines, setWrapLines] = useState(false);
  const [copied, setCopied] = useState(false);
  const requestSeqRef = useRef(0);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadLog = useCallback(
    async (options?: { background?: boolean; forceRefresh?: boolean }) => {
      if (!enabled) return;
      const requestSeq = requestSeqRef.current + 1;
      requestSeqRef.current = requestSeq;
      if (!options?.background) {
        setLoading(true);
        setError(null);
      }

      try {
        const response = normalizeMemberRuntimeLogTailResponse(
          await loadRuntimeLogTail({
            kind,
            maxBytes: PROCESS_LOG_TAIL_BYTES,
            ...(options?.forceRefresh ? { forceRefresh: true } : {}),
          })
        );
        if (requestSeqRef.current !== requestSeq) return;
        setLog(response);
        setError(null);
      } catch (loadError) {
        if (requestSeqRef.current !== requestSeq) return;
        if (!options?.background) {
          setLog(createEmptyMemberRuntimeLogTailResponse(kind));
        }
        setError(loadError instanceof Error ? loadError.message : 'Failed to load process logs');
      } finally {
        if (requestSeqRef.current === requestSeq) {
          setLoading(false);
        }
      }
    },
    [enabled, kind, loadRuntimeLogTail]
  );

  useEffect(() => {
    requestSeqRef.current += 1;
    setLog(null);
    setError(null);
    if (enabled) {
      void loadLog({ forceRefresh: true });
    }
  }, [enabled, kind, loadLog]);

  useEffect(() => {
    if (!enabled || !autoRefresh) return undefined;
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void loadLog({ background: true, forceRefresh: true });
    }, PROCESS_LOG_AUTO_REFRESH_MS);
    return () => clearInterval(interval);
  }, [autoRefresh, enabled, loadLog]);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  const copyCurrentLog = useCallback(async () => {
    const content = log?.content ?? '';
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 1600);
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : 'Failed to copy process logs');
    }
  }, [log?.content]);

  const statusText = buildStatusText(log, {
    empty: t('members.runtimeLogs.empty'),
    fileEmpty: t('members.runtimeLogs.fileEmpty'),
    showingLast: (bytes) => t('members.runtimeLogs.showingLast', { bytes }),
    showing: (bytes) => t('members.runtimeLogs.showing', { bytes }),
  });
  const hasContent = Boolean(log?.content);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ProcessLogKindTabs selected={kind} onSelect={setKind} />
          <span className="rounded-full bg-[var(--color-surface-subtle)] px-2 py-1 text-[10px] uppercase tracking-wide text-[var(--color-text-subtle)]">
            {kind}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-text-muted)]">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-[var(--color-accent)]"
              checked={autoRefresh}
              onChange={(event) => setAutoRefresh(event.target.checked)}
            />
            {t('members.runtimeLogs.autoRefresh')}
          </label>
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-text-muted)]">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-[var(--color-accent)]"
              checked={wrapLines}
              onChange={(event) => setWrapLines(event.target.checked)}
            />
            {t('members.runtimeLogs.wrapLines')}
          </label>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => void loadLog({ forceRefresh: true })}
            disabled={loading}
          >
            {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            {tCommon('actions.refresh')}
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => void copyCurrentLog()}
            disabled={!hasContent}
          >
            {copied ? <Check size={13} /> : <Clipboard size={13} />}
            {copied ? tCommon('actions.copied') : t('members.runtimeLogs.copy')}
          </button>
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      {statusText ? (
        <div className="text-xs text-[var(--color-text-muted)]">{statusText}</div>
      ) : null}

      {loading && !log ? (
        <div className="flex items-center gap-2 rounded-xl border border-[var(--color-border)] px-3 py-10 text-sm text-[var(--color-text-muted)]">
          <Loader2 size={16} className="animate-spin" />
          {t('members.runtimeLogs.loadingTail')}
        </div>
      ) : hasContent ? (
        <ProcessLogVirtualList content={log?.content ?? ''} wrapLines={wrapLines} />
      ) : (
        <div className="rounded-xl border border-[var(--color-border)] px-3 py-10 text-sm text-[var(--color-text-muted)]">
          {statusText ?? t('members.runtimeLogs.empty')}
        </div>
      )}
    </div>
  );
}
