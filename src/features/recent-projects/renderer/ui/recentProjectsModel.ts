import type { CliProviderId } from '@shared/types';

/** Browser-safe presentation facts. Desktop paths may appear only in display text. */
export type Fact<T> =
  | { kind: 'known'; value: T }
  | { kind: 'unknown'; reason: 'not_provided' | 'partial' | 'read_failed' };

export type ActionState =
  | { support: 'unsupported'; reason: 'native_only' | 'outside_scope' }
  | { support: 'supported'; availability: 'checking' }
  | { support: 'supported'; availability: 'unavailable'; reason: string; cause?: 'deleted' }
  | { support: 'supported'; availability: 'available' };

export interface RecentProjectIdentity {
  scopeKey: string;
  targetKey: string;
  readEpoch: number;
}

export interface RecentProjectCardModel {
  identity: RecentProjectIdentity;
  name: string;
  subtitle?: string;
  activity: Fact<{ label: string; observedAt: number; freshness: 'fresh' | 'stale' }>;
  providers: Fact<readonly { id: CliProviderId | 'opencode'; freshness: 'fresh' | 'stale' }[]>;
  branch: Fact<string>;
  taskCounts: Fact<{ pending: number; inProgress: number; completed: number }>;
  tasksLoading: boolean;
  activeTeams: Fact<readonly { targetKey: string; displayName: string }[]>;
  open: ActionState;
  reveal: ActionState;
  desktopPathDetails?: readonly { label: string; text: string }[];
  pathBadge?: { label: string; description: string };
}

export type OpenResult =
  | { kind: 'opened' }
  | { kind: 'cancelled' }
  | { kind: 'stale_target' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'failed'; message: string };
