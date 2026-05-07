import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  type MemberLogPreviewMember,
  type MemberLogPreviewRequestOptions,
  normalizeMemberLogPreviewResponse,
} from '@features/member-log-stream/contracts';
import { api } from '@renderer/api';

import type { ResolvedTeamMember, TeamChangeEvent } from '@shared/types/team';

const LIVE_RELOAD_DEBOUNCE_MS = 650;
const PREVIEW_CACHE_TTL_MS = 3_500;
const DEFAULT_MAX_ITEMS = 3;
const DEFAULT_TEXT_LIMIT = 200;

function normalizeMemberName(value: string): string {
  return value.trim().toLowerCase();
}

function buildRequestKey(input: {
  teamName: string;
  memberNames: readonly string[];
  laneIdsByMember: Readonly<Record<string, string>>;
  maxItemsPerMember: number;
  textLimit: number;
  forceRefresh?: boolean;
}): string {
  const laneEntries = Object.entries(input.laneIdsByMember)
    .map(([memberName, laneId]) => [normalizeMemberName(memberName), laneId.trim()] as const)
    .filter(([, laneId]) => laneId.length > 0)
    .sort((left, right) => left[0].localeCompare(right[0]));
  return JSON.stringify([
    input.teamName,
    input.memberNames.map(normalizeMemberName),
    laneEntries,
    input.maxItemsPerMember,
    input.textLimit,
    input.forceRefresh === true,
  ]);
}

function memberMapFromResponse(
  members: readonly MemberLogPreviewMember[]
): Map<string, MemberLogPreviewMember> {
  return new Map(members.map((member) => [normalizeMemberName(member.memberName), member]));
}

function mergeMemberPreviews(
  base: Map<string, MemberLogPreviewMember>,
  members: Iterable<MemberLogPreviewMember>
): Map<string, MemberLogPreviewMember> {
  const next = new Map(base);
  for (const member of members) {
    next.set(normalizeMemberName(member.memberName), member);
  }
  return next;
}

function laneIdForMember(
  memberName: string,
  laneIdsByMember: Readonly<Record<string, string>>
): string {
  return (
    laneIdsByMember[memberName]?.trim() ??
    laneIdsByMember[normalizeMemberName(memberName)]?.trim() ??
    ''
  );
}

function buildMemberCacheKey(input: {
  teamName: string;
  memberName: string;
  laneIdsByMember: Readonly<Record<string, string>>;
  maxItemsPerMember: number;
  textLimit: number;
}): string {
  return JSON.stringify([
    input.teamName,
    normalizeMemberName(input.memberName),
    laneIdForMember(input.memberName, input.laneIdsByMember),
    input.maxItemsPerMember,
    input.textLimit,
  ]);
}

export function getSafeGraphLogPreviewLaneId(
  member: ResolvedTeamMember | undefined
): string | undefined {
  if (!member) return undefined;
  if (member.providerId !== 'opencode') return undefined;
  if (member.laneOwnerProviderId !== 'opencode') return undefined;
  const laneId = member.laneId?.trim();
  return laneId ? laneId : undefined;
}

export function buildGraphLogPreviewLaneIdsByMember(
  members: readonly ResolvedTeamMember[]
): Record<string, string> {
  const laneIdsByMember: Record<string, string> = {};
  for (const member of members) {
    const laneId = getSafeGraphLogPreviewLaneId(member);
    if (!laneId) continue;
    laneIdsByMember[member.name] = laneId;
    laneIdsByMember[normalizeMemberName(member.name)] = laneId;
  }
  return laneIdsByMember;
}

export function useGraphMemberLogPreviews(input: {
  teamName: string;
  memberNames: readonly string[];
  laneIdsByMember?: Readonly<Record<string, string>>;
  enabled?: boolean;
  maxItemsPerMember?: number;
  textLimit?: number;
}): {
  previewsByMember: Map<string, MemberLogPreviewMember>;
  loading: boolean;
  error: string | null;
  reload: (options?: { forceRefresh?: boolean; background?: boolean }) => Promise<void>;
} {
  const enabled = input.enabled ?? true;
  const maxItemsPerMember = Math.max(
    1,
    Math.min(3, Math.floor(input.maxItemsPerMember ?? DEFAULT_MAX_ITEMS))
  );
  const textLimit = Math.max(80, Math.min(240, Math.floor(input.textLimit ?? DEFAULT_TEXT_LIMIT)));
  const laneIdsByMember = useMemo(
    () => ({ ...(input.laneIdsByMember ?? {}) }),
    [input.laneIdsByMember]
  );
  const memberNames = useMemo(() => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const memberName of input.memberNames) {
      const trimmed = memberName.trim();
      if (!trimmed) continue;
      const key = normalizeMemberName(trimmed);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(trimmed);
    }
    return result;
  }, [input.memberNames]);
  const memberKey = useMemo(() => memberNames.map(normalizeMemberName).join('|'), [memberNames]);
  const [previewsByMember, setPreviewsByMember] = useState(
    new Map<string, MemberLogPreviewMember>()
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cacheRef = useRef(new Map<string, { expiresAt: number; member: MemberLogPreviewMember }>());
  const previewsByMemberRef = useRef(previewsByMember);
  const inFlightRef = useRef(new Map<string, Promise<Map<string, MemberLogPreviewMember>>>());
  const reloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const teamNameRef = useRef(input.teamName);

  useEffect(() => {
    previewsByMemberRef.current = previewsByMember;
  }, [previewsByMember]);

  useEffect(() => {
    if (teamNameRef.current !== input.teamName) {
      teamNameRef.current = input.teamName;
      cacheRef.current.clear();
      inFlightRef.current.clear();
      setPreviewsByMember(new Map());
    }
    if (!enabled || memberNames.length === 0) {
      setLoading(false);
    }
    setError(null);
  }, [enabled, input.teamName, memberKey, memberNames.length]);

  const loadPreviews = useCallback(
    async (options?: { forceRefresh?: boolean; background?: boolean }): Promise<void> => {
      if (!enabled || memberNames.length === 0) {
        setLoading(false);
        setError(null);
        return;
      }
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }

      const now = Date.now();
      const membersToRequest: string[] = [];
      const cachedMembers: MemberLogPreviewMember[] = [];
      let hasMissingPreview = false;

      for (const memberName of memberNames) {
        const cacheKey = buildMemberCacheKey({
          teamName: input.teamName,
          memberName,
          laneIdsByMember,
          maxItemsPerMember,
          textLimit,
        });
        const cached = cacheRef.current.get(cacheKey);
        if (cached) {
          cachedMembers.push(cached.member);
        }
        if (options?.forceRefresh || !cached || cached.expiresAt <= now) {
          membersToRequest.push(memberName);
        }
        const normalizedMemberName = normalizeMemberName(memberName);
        if (!cached && !previewsByMemberRef.current.has(normalizedMemberName)) {
          hasMissingPreview = true;
        }
      }

      if (cachedMembers.length > 0) {
        setPreviewsByMember((current) => mergeMemberPreviews(current, cachedMembers));
      }

      if (membersToRequest.length === 0) {
        setLoading(false);
        setError(null);
        return;
      }

      const requestKey = buildRequestKey({
        teamName: input.teamName,
        memberNames: membersToRequest,
        laneIdsByMember,
        maxItemsPerMember,
        textLimit,
        forceRefresh: options?.forceRefresh,
      });
      const requestTeamName = input.teamName;

      if (!options?.background && hasMissingPreview) {
        setLoading(true);
        setError(null);
      }

      try {
        let request = inFlightRef.current.get(requestKey);
        if (!request) {
          const requestOptions: MemberLogPreviewRequestOptions = {
            maxItemsPerMember,
            textLimit,
            ...(Object.keys(laneIdsByMember).length > 0 ? { laneIdsByMember } : {}),
            ...(options?.forceRefresh ? { forceRefresh: true } : {}),
          };
          request = api.memberLogStream
            .getMemberLogPreviews(input.teamName, membersToRequest, requestOptions)
            .then((response) => {
              const normalized = normalizeMemberLogPreviewResponse(response);
              const members = memberMapFromResponse(normalized.members);
              for (const member of members.values()) {
                cacheRef.current.set(
                  buildMemberCacheKey({
                    teamName: input.teamName,
                    memberName: member.memberName,
                    laneIdsByMember,
                    maxItemsPerMember,
                    textLimit,
                  }),
                  {
                    expiresAt: Date.now() + PREVIEW_CACHE_TTL_MS,
                    member,
                  }
                );
              }
              return members;
            })
            .finally(() => {
              inFlightRef.current.delete(requestKey);
            });
          inFlightRef.current.set(requestKey, request);
        }

        const members = await request;
        if (teamNameRef.current !== requestTeamName) {
          return;
        }
        setPreviewsByMember((current) => mergeMemberPreviews(current, members.values()));
        setError(null);
      } catch (loadError) {
        if (teamNameRef.current !== requestTeamName) {
          return;
        }
        setError(
          loadError instanceof Error ? loadError.message : 'Failed to load graph log previews'
        );
      } finally {
        if (teamNameRef.current === requestTeamName) {
          setLoading(false);
        }
      }
    },
    [enabled, input.teamName, laneIdsByMember, maxItemsPerMember, memberNames, textLimit]
  );

  useEffect(() => {
    if (!enabled || memberNames.length === 0) {
      setLoading(false);
      setError(null);
      return;
    }
    if (reloadTimerRef.current) {
      clearTimeout(reloadTimerRef.current);
    }
    reloadTimerRef.current = setTimeout(() => {
      reloadTimerRef.current = null;
      void loadPreviews();
    }, LIVE_RELOAD_DEBOUNCE_MS);
    return () => {
      if (reloadTimerRef.current) {
        clearTimeout(reloadTimerRef.current);
        reloadTimerRef.current = null;
      }
    };
  }, [enabled, loadPreviews, memberKey, memberNames.length]);

  useEffect(() => {
    if (!enabled) return;

    const scheduleReload = (forceRefresh: boolean): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (memberNames.length === 0) return;
      if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
      reloadTimerRef.current = setTimeout(() => {
        reloadTimerRef.current = null;
        void loadPreviews({ background: true, forceRefresh });
      }, LIVE_RELOAD_DEBOUNCE_MS);
    };

    const unsubscribe = api.teams.onTeamChange?.((_event: unknown, event: TeamChangeEvent) => {
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
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [enabled, input.teamName, loadPreviews, memberNames.length]);

  return { previewsByMember, loading, error, reload: loadPreviews };
}
