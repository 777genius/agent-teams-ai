/**
 * Remote kill-switches without a backend: `dynamicFlags` from package.json on main
 * is fetched once during the splash screen. On any failure the bundled value is used.
 */
import { useSyncExternalStore } from 'react';

import packageJson from '../../../package.json';

export interface DynamicFlags {
  showSponsorFluxion: boolean;
}

type DynamicFlagsStatus = 'loading' | 'remote' | 'bundled';

interface DynamicFlagsState {
  status: DynamicFlagsStatus;
  flags: DynamicFlags;
}

const REMOTE_PACKAGE_JSON_URL =
  'https://raw.githubusercontent.com/777genius/agent-teams-ai/main/package.json';
const REMOTE_FETCH_TIMEOUT_MS = 5000;

const parseDynamicFlags = (value: unknown): DynamicFlags | null => {
  if (!value || typeof value !== 'object') return null;
  const flags = (value as { dynamicFlags?: unknown }).dynamicFlags;
  if (!flags || typeof flags !== 'object') return null;
  const showSponsorFluxion = (flags as { showSponsorFluxion?: unknown }).showSponsorFluxion;
  if (typeof showSponsorFluxion !== 'boolean') return null;
  return { showSponsorFluxion };
};

const BUNDLED_FLAGS: DynamicFlags = parseDynamicFlags(packageJson) ?? {
  showSponsorFluxion: false,
};

let state: DynamicFlagsState = { status: 'loading', flags: BUNDLED_FLAGS };
let loadStarted = false;
const listeners = new Set<() => void>();

const setState = (next: DynamicFlagsState): void => {
  state = next;
  listeners.forEach((listener) => listener());
};

const fetchRemoteFlags = async (): Promise<DynamicFlags> => {
  const response = await fetch(REMOTE_PACKAGE_JSON_URL, {
    cache: 'no-store',
    signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const flags = parseDynamicFlags(await response.json());
  if (!flags) throw new Error('dynamicFlags is missing or malformed');
  return flags;
};

export const loadDynamicFlags = (): void => {
  if (loadStarted) return;
  loadStarted = true;
  fetchRemoteFlags().then(
    (flags) => setState({ status: 'remote', flags }),
    (error: unknown) => {
      console.warn('[dynamicFlags] remote flags unavailable, using bundled values:', error);
      setState({ status: 'bundled', flags: BUNDLED_FLAGS });
    }
  );
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Returns `false` while the remote value is still loading to avoid a show-then-hide flash. */
export const useDynamicFlag = (name: keyof DynamicFlags): boolean =>
  useSyncExternalStore(subscribe, () => state.status !== 'loading' && state.flags[name]);
