import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useEffectiveCliProviderStatus } from '@renderer/hooks/useEffectiveCliProviderStatus';
import { useStore } from '@renderer/store';

import { canRunExternalAgent, sameExternalAgentRunContext } from '../core/domain/runReadiness';

import type {
  AppConnectionContext,
  ExternalAgentRunApi,
  ExternalAgentRunAvailability,
  ExternalAgentRunProvider,
  ExternalAgentRunSnapshot,
} from '../contracts';

export function useExternalAgentRun(
  api: ExternalAgentRunApi,
  task: string,
  context: AppConnectionContext
) {
  const [receivedSnapshot, setSnapshot] = useState<ExternalAgentRunSnapshot | null>(null);
  const [nativeAvailability, setNativeAvailability] = useState<{
    api: ExternalAgentRunApi;
    scope: string;
    values: ExternalAgentRunAvailability;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [now, setNow] = useState(Date.now());
  const mounted = useRef(false);
  const revision = useRef(0);
  const pending = useRef(false);
  const actionPending = useRef(false);
  const codex = useEffectiveCliProviderStatus('codex');
  const claude = useEffectiveCliProviderStatus('anthropic');
  const fetchStatus = useStore((state) => state.fetchCliProviderStatus);
  const boundContext = useMemo(
    () => ({
      appInstanceId: context.appInstanceId,
      dataRootFingerprint: context.dataRootFingerprint,
      connectionGeneration: context.connectionGeneration,
    }),
    [context.appInstanceId, context.dataRootFingerprint, context.connectionGeneration]
  );
  // Derive before effects: an old context must never render for even one paint.
  const snapshot =
    receivedSnapshot && sameExternalAgentRunContext(receivedSnapshot.context, boundContext)
      ? receivedSnapshot
      : null;
  const active = snapshot?.status === 'preparing' || snapshot?.status === 'running';
  const snapshotUnknown = error === 'snapshot';
  const codexAuthority = !codex.codexSnapshotPending && canRunExternalAgent(codex.providerStatus);
  const claudeAuthority = canRunExternalAgent(claude.providerStatus);
  const availabilityScope = JSON.stringify([boundContext, codexAuthority, claudeAuthority]);
  const availability =
    nativeAvailability?.api === api && nativeAvailability.scope === availabilityScope
      ? nativeAvailability.values
      : null;

  useEffect(() => {
    let obsolete = false;
    setNativeAvailability(null);
    void api
      .getAvailability()
      .then((next) => {
        if (!obsolete) setNativeAvailability({ api, scope: availabilityScope, values: next });
      })
      .catch(() => undefined);
    return () => {
      obsolete = true;
    };
    // Binary discovery is separate from run polling, and only follows mount/authority changes.
  }, [api, availabilityScope]);

  useEffect(() => {
    void fetchStatus('codex');
    void fetchStatus('anthropic');
  }, [fetchStatus]);

  const read = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    const version = revision.current;
    try {
      const next = await api.getSnapshot();
      if (mounted.current && version === revision.current) {
        setSnapshot(next && sameExternalAgentRunContext(next.context, boundContext) ? next : null);
        setError(null);
      }
    } catch {
      if (mounted.current && version === revision.current) setError('snapshot');
    } finally {
      pending.current = false;
      if (mounted.current && version === revision.current) setLoading(false);
    }
  }, [api, boundContext]);

  useEffect(() => {
    mounted.current = true;
    setSnapshot(null);
    setError(null);
    setSubmitting(false);
    setCancelling(false);
    setLoading(true);
    void read();
    return () => {
      mounted.current = false;
      revision.current++;
    };
  }, [read]);
  useEffect(() => {
    if (!active && !loading && !snapshotUnknown) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      void read();
    }, 900);
    return () => clearInterval(timer);
  }, [active, loading, read, snapshotUnknown]);

  const start = async (providerId: ExternalAgentRunProvider) => {
    if (
      actionPending.current ||
      active ||
      loading ||
      snapshotUnknown ||
      !availability?.[providerId] ||
      !(providerId === 'codex' ? codexAuthority : claudeAuthority)
    )
      return;
    actionPending.current = true;
    const version = ++revision.current;
    setSubmitting(true);
    setError(null);
    try {
      const next = await api.start({ providerId, task, expectedContext: boundContext });
      if (mounted.current && version === revision.current) {
        setSnapshot(sameExternalAgentRunContext(next.context, boundContext) ? next : null);
        setNow(Date.now());
      }
    } catch {
      if (mounted.current && version === revision.current) setError('start');
    } finally {
      actionPending.current = false;
      if (mounted.current && version === revision.current) {
        setSubmitting(false);
        void read();
      }
    }
  };
  const cancel = async () => {
    if (!snapshot || !active || actionPending.current) return;
    actionPending.current = true;
    const version = ++revision.current;
    const runId = snapshot.runId;
    setCancelling(true);
    try {
      const next = await api.cancel({ runId });
      if (mounted.current && version === revision.current)
        setSnapshot(next && sameExternalAgentRunContext(next.context, boundContext) ? next : null);
    } catch {
      if (mounted.current && version === revision.current) setError('cancel');
    } finally {
      actionPending.current = false;
      if (mounted.current && version === revision.current) {
        setCancelling(false);
        void read();
      }
    }
  };
  return {
    snapshot,
    error,
    loading,
    submitting,
    cancelling,
    active,
    snapshotUnknown,
    availabilityKnown: availability !== null,
    start,
    cancel,
    elapsed: snapshot
      ? Math.max(
          0,
          Math.floor(
            ((snapshot.finishedAt ? Date.parse(snapshot.finishedAt) : now) -
              Date.parse(snapshot.startedAt)) /
              1000
          )
        )
      : 0,
    codexReady: availability?.codex === true && codexAuthority,
    claudeReady: availability?.anthropic === true && claudeAuthority,
    codexDetected: availability ? availability.codex : codex.providerStatus?.supported === true,
    claudeDetected: availability
      ? availability.anthropic
      : claude.providerStatus?.supported === true,
  };
}
