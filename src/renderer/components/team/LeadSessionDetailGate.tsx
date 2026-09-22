import { memo, useEffect, useRef } from 'react';

import { useStore } from '@renderer/store';
import { useShallow } from 'zustand/react/shallow';

import {
  buildLeadSessionDetailRequestKey,
  shouldFetchLeadSessionDetail,
  shouldLoadLeadSessionDetail,
} from './leadContextLoadGuards';

interface LeadSessionDetailGateProps {
  tabId: string | null;
  projectId: string | null;
  leadSessionId: string | null;
  enabled: boolean;
}

export const LeadSessionDetailGate = memo(function LeadSessionDetailGate({
  tabId,
  projectId,
  leadSessionId,
  enabled,
}: LeadSessionDetailGateProps): null {
  const fetchSessionDetail = useStore((s) => s.fetchSessionDetail);
  const { loadedSessionId, loading } = useStore(
    useShallow((s) => {
      const tabData = tabId ? (s.tabSessionData[tabId] ?? null) : null;
      return {
        loadedSessionId: tabData?.sessionDetail?.session?.id ?? null,
        loading: tabData?.sessionDetailLoading ?? false,
      };
    })
  );
  const startedRequestKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      startedRequestKeyRef.current = null;
    }
  }, [enabled]);

  useEffect(() => {
    const input = { tabId, projectId, leadSessionId, enabled };
    if (!shouldLoadLeadSessionDetail(input)) {
      return;
    }

    const requestKey = buildLeadSessionDetailRequestKey(input);
    if (
      !shouldFetchLeadSessionDetail({
        requestedSessionId: input.leadSessionId,
        loadedSessionId,
        loading,
        inFlightOrAttemptedRequestKey: startedRequestKeyRef.current,
        nextRequestKey: requestKey,
      })
    ) {
      return;
    }

    startedRequestKeyRef.current = requestKey;
    void fetchSessionDetail(input.projectId, input.leadSessionId, input.tabId, { silent: false });
  }, [enabled, fetchSessionDetail, leadSessionId, loadedSessionId, loading, projectId, tabId]);

  useEffect(() => {
    if (loadedSessionId === leadSessionId) {
      startedRequestKeyRef.current = null;
    }
  }, [leadSessionId, loadedSessionId]);

  return null;
});
