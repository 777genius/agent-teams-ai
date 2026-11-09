import { useEffect, useRef } from 'react';

import { api } from '@renderer/api';

import { isOpenCodeRuntimeUsable } from '../../core/domain';
import { countCompleteDirectoryConnections } from '../connectedCountObservationPolicy';
import {
  beginRuntimeProviderConnectedCountCheck,
  getRuntimeProviderDirectoryReadToken,
  observeRuntimeProviderDirectoryRevision,
  publishRuntimeProviderConnectedCount,
} from '../runtimeProviderDirectoryCache';

import type { OpenCodeRuntimeStatus } from '@shared/types';

/** One in-flight count read per scope/runtime/credential generation, across Dashboard panes. */
const activeReads = new Map<string, Promise<void>>();
const RETRY_AFTER_MS = 2 * 60_000;

interface DashboardConnectedCountProbeOptions {
  enabled: boolean;
  projectPath: string | null;
  runtimeStatus: OpenCodeRuntimeStatus | null;
  connectedCount: number | null;
}

/**
 * Only the connected-source summary; never a full directory or model catalog.
 * Existing generation fences reject results after runtime or credential changes.
 */
export function useOpenCodeDashboardConnectedCountProbe({
  enabled,
  projectPath,
  runtimeStatus,
  connectedCount,
}: DashboardConnectedCountProbeOptions): void {
  const revision =
    runtimeStatus?.state === 'ready' &&
    isOpenCodeRuntimeUsable(runtimeStatus)
      ? JSON.stringify(['ready', runtimeStatus.version ?? null, runtimeStatus.binaryPath ?? null])
      : null;
  // This changes on invalidation; the Dashboard's existing external-store
  // subscription re-renders the hook even when Unknown stays Unknown.
  const readToken = getRuntimeProviderDirectoryReadToken(projectPath);
  const lastAttempt = useRef<{ key: string; startedAt: number } | null>(null);

  useEffect(() => {
    if (!enabled || !revision || connectedCount !== null) return;
    observeRuntimeProviderDirectoryRevision(revision);
    const token = getRuntimeProviderDirectoryReadToken(projectPath);
    const key = JSON.stringify([projectPath?.trim() || null, revision, token]);
    const now = Date.now();
    if (lastAttempt.current?.key === key &&
        now - lastAttempt.current.startedAt < RETRY_AFTER_MS) return;
    lastAttempt.current = { key, startedAt: now };
    if (activeReads.has(key)) return;

    const endCheck = beginRuntimeProviderConnectedCountCheck(projectPath, token);
    const request = api.runtimeProviderManagement.loadProviderDirectory({
      runtimeId: 'opencode',
      summary: true,
      projectPath,
      query: null,
      filter: 'connected',
      limit: 100,
      cursor: null,
      refresh: false,
    })
      .then((response) => {
        if (response.schemaVersion !== 1 || response.runtimeId !== 'opencode' ||
            response.error || !response.directory) return;
        const connected = countCompleteDirectoryConnections(response.directory, 'connected');
        if (connected === null) return;
        publishRuntimeProviderConnectedCount({
          projectPath,
          readToken: token,
          runtimeRevision: revision,
          connected,
          fetchedAt: response.directory.fetchedAt,
          source: 'summary-connected',
        });
      })
      .catch(() => {
        // No false zero and no automatic retry loop on unavailable inventory.
      })
      .finally(() => {
        endCheck();
        if (activeReads.get(key) === request) activeReads.delete(key);
      });
    activeReads.set(key, request);
    // Do not cancel a started read on tab changes: it is already running,
    // and the generation token still prevents publishing stale data.
  }, [enabled, projectPath, revision, connectedCount, readToken]);
}
