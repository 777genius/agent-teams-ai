import { useEffect, useMemo, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import {
  formatOpenCodeRuntimeDeliveryDebugDetails,
  type OpenCodeRuntimeDeliveryDebugDetails,
} from '@renderer/utils/openCodeRuntimeDeliveryDiagnostics';
import { AlertCircle } from 'lucide-react';

import type { JSX } from 'react';

interface OpenCodeDeliveryWarningProps {
  warning: string | null;
  debugDetails?: OpenCodeRuntimeDeliveryDebugDetails | null;
  pendingDelayMs?: number;
}

export const OpenCodeDeliveryWarning = ({
  warning,
  debugDetails,
  pendingDelayMs = 10_000,
}: OpenCodeDeliveryWarningProps): JSX.Element | null => {
  const { t } = useAppTranslation('team');
  const detailsKey = `${warning ?? ''}:${debugDetails?.messageId ?? ''}:${debugDetails?.statusMessageId ?? ''}:${debugDetails?.userVisibleState ?? ''}`;
  const delayPendingWarning =
    debugDetails?.userVisibleState === 'checking' ||
    (!debugDetails?.userVisibleState &&
      debugDetails?.responsePending === true &&
      debugDetails.delivered !== false);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [pendingVisibleKey, setPendingVisibleKey] = useState<string | null>(() =>
    delayPendingWarning ? null : detailsKey
  );
  const mountedRef = useRef(true);
  const copiedResetTimerRef = useRef<number | null>(null);
  const pendingTimerRef = useRef<number | null>(null);
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
      if (pendingTimerRef.current !== null) {
        window.clearTimeout(pendingTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (pendingTimerRef.current !== null) {
      window.clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }
    if (!warning) {
      setPendingVisibleKey(null);
      return;
    }
    if (!delayPendingWarning || pendingDelayMs <= 0) {
      setPendingVisibleKey(detailsKey);
      return;
    }
    setPendingVisibleKey(null);
    pendingTimerRef.current = window.setTimeout(() => {
      pendingTimerRef.current = null;
      if (mountedRef.current) {
        setPendingVisibleKey(detailsKey);
      }
    }, pendingDelayMs);
  }, [delayPendingWarning, detailsKey, pendingDelayMs, warning]);

  if (!warning) return null;
  if (delayPendingWarning && pendingVisibleKey !== detailsKey) return null;

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
            {t('messages.delivery.details')}
          </button>
        ) : null}
      </span>
      {expanded && debugDetails ? (
        <span className="z-10 block max-w-[min(34rem,calc(100vw-3rem))] rounded border border-amber-500/20 bg-[var(--color-bg-primary)] p-2 text-left text-[10px] text-[var(--color-text-secondary)] shadow-xl">
          <span className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
            <span className="text-[var(--color-text-muted)]">
              {t('messages.delivery.fields.messageId')}
            </span>
            <span className="break-all">{debugDetails.messageId}</span>
            <span className="text-[var(--color-text-muted)]">
              {t('messages.delivery.fields.statusMessageId')}
            </span>
            <span className="break-all">{debugDetails.statusMessageId}</span>
            <span className="text-[var(--color-text-muted)]">
              {t('messages.delivery.fields.providerId')}
            </span>
            <span>{debugDetails.providerId}</span>
            <span className="text-[var(--color-text-muted)]">
              {t('messages.delivery.fields.delivered')}
            </span>
            <span>{String(debugDetails.delivered)}</span>
            <span className="text-[var(--color-text-muted)]">
              {t('messages.delivery.fields.responsePending')}
            </span>
            <span>{String(debugDetails.responsePending)}</span>
            <span className="text-[var(--color-text-muted)]">
              {t('messages.delivery.fields.responseState')}
            </span>
            <span>{debugDetails.responseState ?? 'null'}</span>
            <span className="text-[var(--color-text-muted)]">
              {t('messages.delivery.fields.ledgerStatus')}
            </span>
            <span>{debugDetails.ledgerStatus ?? 'null'}</span>
            <span className="text-[var(--color-text-muted)]">
              {t('messages.delivery.fields.visibleReplyMessageId')}
            </span>
            <span className="break-all">{debugDetails.visibleReplyMessageId ?? 'null'}</span>
            <span className="text-[var(--color-text-muted)]">
              {t('messages.delivery.fields.visibleReplyCorrelation')}
            </span>
            <span>{debugDetails.visibleReplyCorrelation ?? 'null'}</span>
            <span className="text-[var(--color-text-muted)]">
              {t('messages.delivery.fields.queuedBehindMessageId')}
            </span>
            <span className="break-all">{debugDetails.queuedBehindMessageId ?? 'null'}</span>
            <span className="text-[var(--color-text-muted)]">
              {t('messages.delivery.fields.acceptanceUnknown')}
            </span>
            <span>{String(debugDetails.acceptanceUnknown)}</span>
            <span className="text-[var(--color-text-muted)]">
              {t('messages.delivery.fields.userVisibleState')}
            </span>
            <span>{debugDetails.userVisibleState ?? 'null'}</span>
            <span className="text-[var(--color-text-muted)]">
              {t('messages.delivery.fields.userVisibleReasonCode')}
            </span>
            <span>{debugDetails.userVisibleReasonCode ?? 'null'}</span>
            <span className="text-[var(--color-text-muted)]">
              {t('messages.delivery.fields.userVisibleNextReviewAt')}
            </span>
            <span>{debugDetails.userVisibleNextReviewAt ?? 'null'}</span>
            <span className="text-[var(--color-text-muted)]">
              {t('messages.delivery.fields.userVisibleMessage')}
            </span>
            <span>{debugDetails.userVisibleMessage ?? 'null'}</span>
            <span className="text-[var(--color-text-muted)]">
              {t('messages.delivery.fields.reason')}
            </span>
            <span>{debugDetails.reason ?? 'null'}</span>
            <span className="text-[var(--color-text-muted)]">
              {t('messages.delivery.fields.diagnostics')}
            </span>
            <span>
              {debugDetails.diagnostics.length ? debugDetails.diagnostics.join('; ') : '[]'}
            </span>
          </span>
          <button
            type="button"
            className="mt-2 rounded border border-amber-500/20 px-2 py-1 text-[10px] text-amber-200 hover:border-amber-400/40 hover:text-amber-100"
            onClick={() => void handleCopy()}
          >
            {copied ? t('messages.delivery.copied') : t('messages.delivery.copyDebugDetails')}
          </button>
        </span>
      ) : null}
    </span>
  );
};
