import { useEffect, useMemo, useRef, useState } from 'react';

import {
  formatOpenCodeRuntimeDeliveryDebugDetails,
  type OpenCodeRuntimeDeliveryDebugDetails,
} from '@renderer/utils/openCodeRuntimeDeliveryDiagnostics';
import { AlertCircle } from 'lucide-react';

import type { JSX } from 'react';

interface OpenCodeDeliveryWarningProps {
  warning: string | null;
  debugDetails?: OpenCodeRuntimeDeliveryDebugDetails | null;
}

export function OpenCodeDeliveryWarning({
  warning,
  debugDetails,
}: OpenCodeDeliveryWarningProps): JSX.Element | null {
  const detailsKey = `${warning ?? ''}:${debugDetails?.messageId ?? ''}`;
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const copiedResetTimerRef = useRef<number | null>(null);
  const expanded = expandedKey === detailsKey;
  const copied = copiedKey === detailsKey;
  const copyText = useMemo(
    () => (debugDetails ? formatOpenCodeRuntimeDeliveryDebugDetails(debugDetails) : ''),
    [debugDetails]
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (copiedResetTimerRef.current !== null) {
        window.clearTimeout(copiedResetTimerRef.current);
      }
    };
  }, []);

  if (!warning) return null;

  const handleCopy = async (): Promise<void> => {
    if (!copyText || !navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(copyText);
    } catch {
      return;
    }
    if (!mountedRef.current) return;
    setCopiedKey(detailsKey);
    if (copiedResetTimerRef.current !== null) {
      window.clearTimeout(copiedResetTimerRef.current);
    }
    copiedResetTimerRef.current = window.setTimeout(() => {
      copiedResetTimerRef.current = null;
      if (mountedRef.current) {
        setCopiedKey(null);
      }
    }, 1500);
  };

  return (
    <span className="relative inline-flex flex-col items-start gap-1">
      <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300">
        <AlertCircle size={10} className="shrink-0" />
        <span>{warning}</span>
        {debugDetails ? (
          <button
            type="button"
            className="ml-1 rounded px-1 text-[10px] font-medium text-amber-200 underline decoration-amber-300/50 underline-offset-2 hover:text-amber-100"
            aria-expanded={expanded}
            onClick={() =>
              setExpandedKey((currentKey) => (currentKey === detailsKey ? null : detailsKey))
            }
          >
            Details
          </button>
        ) : null}
      </span>
      {expanded && debugDetails ? (
        <span className="z-10 block max-w-[min(34rem,calc(100vw-3rem))] rounded border border-amber-500/20 bg-[var(--color-bg-primary)] p-2 text-left text-[10px] text-[var(--color-text-secondary)] shadow-xl">
          <span className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
            <span className="text-[var(--color-text-muted)]">messageId</span>
            <span className="break-all">{debugDetails.messageId}</span>
            <span className="text-[var(--color-text-muted)]">providerId</span>
            <span>{debugDetails.providerId}</span>
            <span className="text-[var(--color-text-muted)]">delivered</span>
            <span>{String(debugDetails.delivered)}</span>
            <span className="text-[var(--color-text-muted)]">responsePending</span>
            <span>{String(debugDetails.responsePending)}</span>
            <span className="text-[var(--color-text-muted)]">responseState</span>
            <span>{debugDetails.responseState ?? 'null'}</span>
            <span className="text-[var(--color-text-muted)]">ledgerStatus</span>
            <span>{debugDetails.ledgerStatus ?? 'null'}</span>
            <span className="text-[var(--color-text-muted)]">acceptanceUnknown</span>
            <span>{String(debugDetails.acceptanceUnknown)}</span>
            <span className="text-[var(--color-text-muted)]">reason</span>
            <span>{debugDetails.reason ?? 'null'}</span>
            <span className="text-[var(--color-text-muted)]">diagnostics</span>
            <span>
              {debugDetails.diagnostics.length ? debugDetails.diagnostics.join('; ') : '[]'}
            </span>
          </span>
          <button
            type="button"
            className="mt-2 rounded border border-amber-500/20 px-2 py-1 text-[10px] text-amber-200 hover:border-amber-400/40 hover:text-amber-100"
            onClick={() => void handleCopy()}
          >
            {copied ? 'Copied' : 'Copy debug details'}
          </button>
        </span>
      ) : null}
    </span>
  );
}
