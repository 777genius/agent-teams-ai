import { useCallback, useEffect, useRef, useState } from 'react';

import { useEffectiveCliProviderStatus } from '@renderer/hooks/useEffectiveCliProviderStatus';
import { useStore } from '@renderer/store';

import { canRunExternalAgent } from '../core/domain/runReadiness';

import type {
  AppConnectionContext,
  ExternalAgentRunApi,
  ExternalAgentRunProvider,
  ExternalAgentRunSnapshot,
} from '../contracts';

export function useExternalAgentRun(
  api: ExternalAgentRunApi,
  task: string,
  context: AppConnectionContext
) {
  const [snapshot, setSnapshot] = useState<ExternalAgentRunSnapshot | null>(null);
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
  const active = snapshot?.status === 'preparing' || snapshot?.status === 'running';
  const snapshotUnknown = error === 'snapshot';

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
        setSnapshot(next);
        setError(null);
      }
    } catch {
      if (mounted.current && version === revision.current) setError('snapshot');
    } finally {
      pending.current = false;
      if (mounted.current && version === revision.current) setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    mounted.current = true;
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
    if (actionPending.current || active || loading || snapshotUnknown) return;
    actionPending.current = true;
    const version = ++revision.current;
    setSubmitting(true);
    setError(null);
    try {
      const next = await api.start({ providerId, task, expectedContext: context });
      if (mounted.current && version === revision.current) {
        setSnapshot(next);
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
      if (mounted.current && version === revision.current) setSnapshot(next);
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
    codexReady: !codex.codexSnapshotPending && canRunExternalAgent(codex.providerStatus),
    claudeReady: canRunExternalAgent(claude.providerStatus),
    codexDetected: codex.providerStatus?.supported === true,
    claudeDetected: claude.providerStatus?.supported === true,
  };
}
