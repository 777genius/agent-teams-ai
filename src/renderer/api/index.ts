/**
 * Unified API adapter.
 *
 * When running inside Electron, the preload script exposes `window.electronAPI`.
 * When running in a browser (e.g. via the HTTP server), we fall back to an
 * HTTP+SSE client that implements the same interface.
 *
 * All renderer code should import `api` from this module instead of
 * accessing `window.electronAPI` directly.
 *
 * The instance is resolved lazily on first property access so that test code
 * can install mocks on `window.electronAPI` before the adapter resolves.
 */

import {
  createBoundHostReviewApi,
  createHostBackendRenderer,
  createHostCrossTeamApi,
  createHostGroupChatsApi,
  createHostReviewApi,
  isHostTeamSelectionKey,
} from '@features/agent-backend/renderer';

import {
  captureContextScopedRequestEpoch,
  isContextScopedRequestEpochCurrent,
} from '../store/utils/contextScopedRequestEpoch';

import { createContextScopedExtensionApi } from './createContextScopedExtensionApi';
import { HttpAPIClient } from './httpClient';

import type { ReviewOriginScope } from '@agent-teams/task-change-ledger/review-transport';
import type { TeamGroupChatsAPI } from '@features/team-group-chats/contracts';
import type { CrossTeamAPI, ElectronAPI, ReviewAPI } from '@shared/types/api';

/**
 * Resolves the base URL for the HTTP API client.
 *
 * - Electron "server mode" (browser opened via ?port=XXXX): use explicit port on 127.0.0.1
 * - Standalone/Docker (page served by the same server): use window.location.origin
 *   to avoid cross-origin issues (localhost vs 127.0.0.1)
 */
function getHttpBaseUrl(): string {
  const params = new URLSearchParams(window.location.search);
  const explicitPort = params.get('port');
  if (explicitPort) {
    return `http://127.0.0.1:${parseInt(explicitPort, 10)}`;
  }
  return window.location.origin;
}

let httpClient: HttpAPIClient | null = null;
const hostAdapters = new WeakMap<ElectronAPI, ReturnType<typeof createHostBackendRenderer>>();

const hostGroupAdapters = new WeakMap<ElectronAPI, TeamGroupChatsAPI>();
const hostCrossTeamAdapters = new WeakMap<ElectronAPI, CrossTeamAPI>();
const hostReviewAdapters = new WeakMap<ElectronAPI, ReviewAPI>();

function captureReviewContext(): () => boolean {
  const epoch = captureContextScopedRequestEpoch();
  return () => isContextScopedRequestEpochCurrent(epoch);
}
function hostAdapter(impl: ElectronAPI): ReturnType<typeof createHostBackendRenderer> {
  let adapter = hostAdapters.get(impl);
  if (!adapter) {
    adapter = createHostBackendRenderer(impl.teams, impl.agentBackend, captureReviewContext);
    hostAdapters.set(impl, adapter);
  }
  return adapter;
}
/** Originating dialog/store request captures its Team and Task before any asynchronous lookup. */
export function reviewApiForTeam(
  teamName: string,
  origin: ReviewOriginScope & { teamName?: string } = {}
): ReviewAPI {
  const impl = getImpl();
  if (origin.teamName !== undefined && origin.teamName !== teamName)
    throw new Error('Review source Team changed');
  if (!isHostTeamSelectionKey(teamName)) return api.review;
  if (!impl.agentBackend) throw new Error('Host review unavailable');
  const scope = {
    ...(origin.taskId === undefined ? {} : { taskId: origin.taskId }),
    ...(origin.memberName === undefined ? {} : { memberName: origin.memberName }),
  };
  return createBoundHostReviewApi(
    impl.review,
    hostAdapter(impl).backend,
    teamName,
    scope,
    captureReviewContext
  );
}

function getImpl(): ElectronAPI {
  if (window.electronAPI) return window.electronAPI;
  // Lazily create the HTTP client only when actually needed (browser mode).
  // Caching avoids creating multiple EventSource connections.
  if (!httpClient) {
    httpClient = new HttpAPIClient(getHttpBaseUrl());
  }
  return httpClient;
}

/**
 * Proxy that lazily resolves the underlying ElectronAPI on first property access.
 * In Electron: delegates to `window.electronAPI` (set by preload).
 * In browser: delegates to `HttpAPIClient` (created on first use).
 * In tests: delegates to whatever mock is installed on `window.electronAPI`.
 */
/**
 * Whether the app is running inside Electron (true) or in a browser via HTTP server (false).
 * Use this to hide Electron-only UI (settings, traffic lights, etc.) in browser mode.
 */
export const isElectronMode = (): boolean => !!window.electronAPI;

const extensionAdapters = new WeakMap<object, object>();

export const api: ElectronAPI = new Proxy({} as ElectronAPI, {
  get(_target, prop, receiver) {
    const impl = getImpl();
    if (
      (prop === 'teams' ||
        prop === 'agentBackend' ||
        prop === 'review' ||
        prop === 'crossTeam' ||
        prop === 'teamGroupChats') &&
      impl.agentBackend
    ) {
      const adapter = hostAdapter(impl);
      if (prop === 'teamGroupChats') {
        let groups = hostGroupAdapters.get(impl);
        if (!groups) {
          groups = createHostGroupChatsApi(
            impl.teamGroupChats,
            adapter.backend,
            captureReviewContext
          );
          hostGroupAdapters.set(impl, groups);
        }
        return groups;
      }
      if (prop === 'crossTeam') {
        let crossTeam = hostCrossTeamAdapters.get(impl);
        if (!crossTeam) {
          crossTeam = createHostCrossTeamApi(impl.crossTeam, adapter.backend, captureReviewContext);
          hostCrossTeamAdapters.set(impl, crossTeam);
        }
        return crossTeam;
      }
      if (prop === 'review') {
        let review = hostReviewAdapters.get(impl);
        if (!review) {
          review = createHostReviewApi(impl.review, adapter.backend, captureReviewContext);
          hostReviewAdapters.set(impl, review);
        }
        return review;
      }
      return prop === 'teams' ? adapter.teams : adapter.backend;
    }
    if (prop === 'plugins' || prop === 'mcpRegistry') {
      const original = impl[prop];
      if (!original) return undefined;
      let adapter = extensionAdapters.get(original);
      if (!adapter) {
        adapter = createContextScopedExtensionApi(original, captureReviewContext);
        extensionAdapters.set(original, adapter);
      }
      return adapter;
    }
    const value = Reflect.get(impl, prop, receiver) as unknown;
    if (typeof value === 'function') {
      return (value as (...args: unknown[]) => unknown).bind(impl);
    }
    return value;
  },
});
