import { useCallback, useEffect, useRef, useState } from 'react';

import {
  type MemberLogStreamRequestOptions,
  type MemberLogStreamResponse,
  normalizeMemberLogStreamResponse,
} from '../../contracts';
import { productionMemberLogObservationRendererPorts } from '../adapters/createMemberLogObservationRendererPorts';
import { normalizeExecutionLogStream } from '../ui/executionLogStreamUtils';

import type { MemberLogObservationRendererPorts } from '../ports/MemberLogObservationRendererPorts';
import type { ResolvedTeamMember } from '@shared/types';

const LIVE_RELOAD_DEBOUNCE_MS = 650;

function getSafeOpenCodeLaneId(member: ResolvedTeamMember): string | undefined {
  if (member.providerId !== 'opencode') return undefined;
  if (member.laneOwnerProviderId !== 'opencode') return undefined;
  const laneId = member.laneId?.trim();
  return laneId ? laneId : undefined;
}

export interface UseMemberLogStreamInput {
  teamName: string;
  member: ResolvedTeamMember;
  enabled?: boolean;
  ports?: MemberLogObservationRendererPorts;
}

export interface UseMemberLogStreamResult {
  stream: MemberLogStreamResponse | null;
  loading: boolean;
  error: string | null;
  reload: (options?: { forceRefresh?: boolean; background?: boolean }) => Promise<void>;
}

export function useMemberLogStream(input: UseMemberLogStreamInput): UseMemberLogStreamResult {
  const enabled = input.enabled ?? true;
  const ports = input.ports ?? productionMemberLogObservationRendererPorts;
  const [stream, setStream] = useState<MemberLogStreamResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<MemberLogStreamResponse | null>(null);
  const activeLoadKeyRef = useRef<string | null>(null);
  const pendingReloadRef = useRef<{ key: string; forceRefresh?: boolean } | null>(null);
  const reloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeqRef = useRef(0);
  const memberName = input.member.name;
  const openCodeLaneId = getSafeOpenCodeLaneId(input.member);
  const streamKey = `${input.teamName}:${memberName}:${openCodeLaneId ?? ''}`;

  useEffect(() => {
    streamRef.current = stream;
  }, [stream]);

  const loadStream = useCallback(
    async (options?: { forceRefresh?: boolean; background?: boolean }): Promise<void> => {
      if (!enabled) return;

      if (activeLoadKeyRef.current === streamKey) {
        const existingPending = pendingReloadRef.current;
        pendingReloadRef.current = {
          key: streamKey,
          forceRefresh:
            (existingPending?.key === streamKey && existingPending.forceRefresh) ||
            options?.forceRefresh,
        };
        return;
      }

      activeLoadKeyRef.current = streamKey;
      const background = options?.background ?? false;
      const hadExistingStream = streamRef.current != null;
      const requestSeq = requestSeqRef.current + 1;
      requestSeqRef.current = requestSeq;

      if (!background) setLoading(true);
      setError((prev) => (background ? prev : null));

      try {
        const requestOptions: MemberLogStreamRequestOptions = {
          limitSegments: 30,
          ...(options?.forceRefresh ? { forceRefresh: true } : {}),
        };
        if (openCodeLaneId) {
          requestOptions.laneId = openCodeLaneId;
        }

        const response = normalizeExecutionLogStream(
          normalizeMemberLogStreamResponse(
            await ports.readMemberLogStream({
              teamName: input.teamName,
              memberName,
              options: requestOptions,
            })
          )
        );
        if (requestSeqRef.current !== requestSeq) return;

        setStream(response);
        setError(null);
      } catch (loadError) {
        if (requestSeqRef.current !== requestSeq) return;
        if (!background || streamRef.current == null) {
          setError(
            loadError instanceof Error ? loadError.message : 'Failed to load member log stream'
          );
          setStream(null);
        }
      } finally {
        const isCurrentRequest =
          requestSeqRef.current === requestSeq && activeLoadKeyRef.current === streamKey;
        if (isCurrentRequest && (!background || !hadExistingStream)) {
          setLoading(false);
        }
        if (isCurrentRequest) {
          activeLoadKeyRef.current = null;
        }
        const pending = pendingReloadRef.current;
        if (pending?.key === streamKey) {
          pendingReloadRef.current = null;
        }
        if (isCurrentRequest && pending?.key === streamKey && enabled) {
          void loadStream({ background: true, forceRefresh: pending.forceRefresh });
        }
      }
    },
    [enabled, input.teamName, memberName, openCodeLaneId, ports, streamKey]
  );

  useEffect(() => {
    requestSeqRef.current += 1;
    setStream(null);
    streamRef.current = null;
    setError(null);
    setLoading(enabled);
    pendingReloadRef.current = null;
    activeLoadKeyRef.current = null;
    if (reloadTimerRef.current) {
      clearTimeout(reloadTimerRef.current);
      reloadTimerRef.current = null;
    }
    if (enabled) {
      void loadStream();
    }
  }, [enabled, streamKey, loadStream]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void ports.setStreamTracking(input.teamName, true).catch(() => undefined);
    return () => {
      if (cancelled) return;
      cancelled = true;
      void ports.setStreamTracking(input.teamName, false).catch(() => undefined);
    };
  }, [enabled, input.teamName, ports]);

  useEffect(() => {
    if (!enabled) return;

    const scheduleReload = (forceRefresh: boolean): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
      reloadTimerRef.current = setTimeout(() => {
        reloadTimerRef.current = null;
        void loadStream({ background: true, forceRefresh });
      }, LIVE_RELOAD_DEBOUNCE_MS);
    };

    const unsubscribe = ports.subscribeToChanges((event) => {
      if (event.teamName !== input.teamName) return;
      if (event.type === 'log-source-change') {
        scheduleReload(true);
        return;
      }
      if (event.type === 'task-log-change') {
        scheduleReload(false);
      }
    });

    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') scheduleReload(false);
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    return () => {
      if (reloadTimerRef.current) {
        clearTimeout(reloadTimerRef.current);
        reloadTimerRef.current = null;
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
      unsubscribe();
    };
  }, [enabled, input.teamName, loadStream, ports]);

  return { stream, loading, error, reload: loadStream };
}
