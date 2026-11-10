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

interface PendingReloadOptions {
  forceRefresh: boolean;
  background: boolean;
}

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
  const laneEntriesByMember = new Map<string, string>();
  for (const [memberName, laneId] of Object.entries(input.laneIdsByMember)) {
    const normalizedMemberName = normalizeMemberName(memberName);
    const trimmedLaneId = laneId.trim();
    if (!normalizedMemberName || !trimmedLaneId || laneEntriesByMember.has(normalizedMemberName)) {
      continue;
    }
    laneEntriesByMember.set(normalizedMemberName, trimmedLaneId);
  }
  const laneEntries = Array.from(laneEntriesByMember.entries()).sort((left, right) =>
    left[0].localeCompare(right[0])
  );
  return JSON.stringify([
    input.teamName,
    input.memberNames.map(normalizeMemberName).sort((left, right) => left.localeCompare(right)),
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

function hasUnloadedMemberPreview(
  memberNames: readonly string[],
  previewsByMember: ReadonlyMap<string, MemberLogPreviewMember>
): boolean {
  return memberNames.some((memberName) => !previewsByMember.has(normalizeMemberName(memberName)));
}

function hasEmptyOrUnloadedMemberPreview(
  memberNames: readonly string[],
  previewsByMember: ReadonlyMap<string, MemberLogPreviewMember>
): boolean {
  return memberNames.some((memberName) => {
    const preview = previewsByMember.get(normalizeMemberName(memberName));
    return !preview || preview.items.length === 0;
  });
}

function hasInFlightMemberPreviewRequest(
  memberNames: readonly string[],
  activeRequestKeyByMember: ReadonlyMap<string, string>,
  inFlightRequests: ReadonlyMap<string, unknown>
): boolean {
  return memberNames.some((memberName) => {
    const activeRequestKey = activeRequestKeyByMember.get(normalizeMemberName(memberName));
    return activeRequestKey ? inFlightRequests.has(activeRequestKey) : false;
  });
}

function hasPendingLoadingReload(
  pendingReload: PendingReloadOptions | null,
  memberNames: readonly string[],
  previewsByMember: ReadonlyMap<string, MemberLogPreviewMember>
): boolean {
  return (
    pendingReload?.forceRefresh === true &&
    hasEmptyOrUnloadedMemberPreview(memberNames, previewsByMember)
  );
}

function hasActiveMemberPreviewRequest(
  memberNames: readonly string[],
  requestKey: string,
  activeRequestKeyByMember: ReadonlyMap<string, string>
): boolean {
  return memberNames.some(
    (memberName) => activeRequestKeyByMember.get(normalizeMemberName(memberName)) === requestKey
  );
}

function hasVisibleActiveMemberPreviewRequest(
  requestedMemberNames: readonly string[],
  visibleMemberNames: readonly string[],
  requestKey: string,
  activeRequestKeyByMember: ReadonlyMap<string, string>
): boolean {
  const visibleMemberNameSet = new Set(visibleMemberNames.map(normalizeMemberName));
  return requestedMemberNames.some((memberName) => {
    const normalizedMemberName = normalizeMemberName(memberName);
    return (
      visibleMemberNameSet.has(normalizedMemberName) &&
      activeRequestKeyByMember.get(normalizedMemberName) === requestKey
    );
  });
}

function laneIdForMember(
  memberName: string,
  laneIdsByMember: Readonly<Record<string, string>>
): string {
  const directLaneId = laneIdsByMember[memberName]?.trim();
  if (directLaneId) return directLaneId;
  const normalizedLaneId = laneIdsByMember[normalizeMemberName(memberName)]?.trim();
  return normalizedLaneId || '';
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

function buildLaneIdsKey(laneIdsByMember: Readonly<Record<string, string>>): string {
  const laneEntriesByMember = new Map<string, string>();
  for (const [memberName, laneId] of Object.entries(laneIdsByMember)) {
    const normalizedMemberName = normalizeMemberName(memberName);
    const trimmedLaneId = laneId.trim();
    if (!normalizedMemberName || !trimmedLaneId || laneEntriesByMember.has(normalizedMemberName)) {
      continue;
    }
    laneEntriesByMember.set(normalizedMemberName, trimmedLaneId);
  }
  return JSON.stringify(
    Array.from(laneEntriesByMember.entries()).sort((left, right) => {
      const byMember = left[0].localeCompare(right[0]);
      return byMember !== 0 ? byMember : left[1].localeCompare(right[1]);
    })
  );
}

function buildLaneIdsForMembers(
  memberNames: readonly string[],
  laneIdsByMember: Readonly<Record<string, string>>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const memberName of memberNames) {
    const laneId = laneIdForMember(memberName, laneIdsByMember);
    if (!laneId) continue;
    result[memberName] = laneId;
    const normalizedMemberName = normalizeMemberName(memberName);
    if (normalizedMemberName && normalizedMemberName !== memberName) {
      result[normalizedMemberName] = laneId;
    }
  }
  return result;
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
  const laneKey = useMemo(
    () => buildLaneIdsKey(buildLaneIdsForMembers(memberNames, laneIdsByMember)),
    [laneIdsByMember, memberNames]
  );
  const memberKey = useMemo(
    () =>
      memberNames
        .map(normalizeMemberName)
        .sort((left, right) => left.localeCompare(right))
        .join('|'),
    [memberNames]
  );
  const [previewsByMember, setPreviewsByMember] = useState(
    new Map<string, MemberLogPreviewMember>()
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cacheRef = useRef(new Map<string, { expiresAt: number; member: MemberLogPreviewMember }>());
  const previewsByMemberRef = useRef(previewsByMember);
  const inFlightRef = useRef(new Map<string, Promise<Map<string, MemberLogPreviewMember>>>());
  const activeRequestKeyByMemberRef = useRef(new Map<string, string>());
  const reloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingReloadRef = useRef<PendingReloadOptions | null>(null);
  const requestGenerationRef = useRef(0);
  const teamNameRef = useRef(input.teamName);
  const laneKeyRef = useRef(laneKey);
  const memberNamesRef = useRef(memberNames);
  const mountedRef = useRef(true);

  previewsByMemberRef.current = previewsByMember;
  memberNamesRef.current = memberNames;

  const clearScheduledReload = useCallback((): void => {
    if (reloadTimerRef.current) {
      clearTimeout(reloadTimerRef.current);
      reloadTimerRef.current = null;
    }
    pendingReloadRef.current = null;
  }, []);

  useEffect(() => {
    if (teamNameRef.current !== input.teamName) {
      teamNameRef.current = input.teamName;
      laneKeyRef.current = laneKey;
      requestGenerationRef.current += 1;
      clearScheduledReload();
      cacheRef.current.clear();
      inFlightRef.current.clear();
      activeRequestKeyByMemberRef.current.clear();
      const emptyPreviews = new Map<string, MemberLogPreviewMember>();
      previewsByMemberRef.current = emptyPreviews;
      setPreviewsByMember(emptyPreviews);
    }
    if (!enabled || memberNames.length === 0) {
      setLoading(false);
    }
    setError(null);
  }, [clearScheduledReload, enabled, input.teamName, laneKey, memberKey, memberNames.length]);

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
      let hasEmptyOrMissingPreviewForForceRefresh = false;

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
        const existingPreview = previewsByMemberRef.current.get(normalizedMemberName);
        if (!cached && !existingPreview) {
          hasMissingPreview = true;
        }
        if (options?.forceRefresh && (!existingPreview || existingPreview.items.length === 0)) {
          hasEmptyOrMissingPreviewForForceRefresh = true;
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

      const requestedLaneIdsByMember = buildLaneIdsForMembers(membersToRequest, laneIdsByMember);
      const requestKey = buildRequestKey({
        teamName: input.teamName,
        memberNames: membersToRequest,
        laneIdsByMember: requestedLaneIdsByMember,
        maxItemsPerMember,
        textLimit,
        forceRefresh: options?.forceRefresh,
      });
      const requestTeamName = input.teamName;
      const requestGeneration = requestGenerationRef.current;
      for (const memberName of membersToRequest) {
        activeRequestKeyByMemberRef.current.set(normalizeMemberName(memberName), requestKey);
      }
      const requestStillActive = (): boolean =>
        mountedRef.current &&
        teamNameRef.current === requestTeamName &&
        requestGenerationRef.current === requestGeneration &&
        hasActiveMemberPreviewRequest(
          membersToRequest,
          requestKey,
          activeRequestKeyByMemberRef.current
        );
      const requestStillVisible = (): boolean =>
        mountedRef.current &&
        teamNameRef.current === requestTeamName &&
        requestGenerationRef.current === requestGeneration &&
        hasVisibleActiveMemberPreviewRequest(
          membersToRequest,
          memberNamesRef.current,
          requestKey,
          activeRequestKeyByMemberRef.current
        );

      if ((!options?.background && hasMissingPreview) || hasEmptyOrMissingPreviewForForceRefresh) {
        setLoading(true);
        setError(null);
      }

      try {
        let request = inFlightRef.current.get(requestKey);
        if (!request) {
          const requestOptions: MemberLogPreviewRequestOptions = {
            maxItemsPerMember,
            textLimit,
            ...(Object.keys(requestedLaneIdsByMember).length > 0
              ? { laneIdsByMember: requestedLaneIdsByMember }
              : {}),
            ...(options?.forceRefresh ? { forceRefresh: true } : {}),
          };
          request = api.memberLogStream
            .getMemberLogPreviews(input.teamName, membersToRequest, requestOptions)
            .then((response) => {
              const normalized = normalizeMemberLogPreviewResponse(response);
              const members = memberMapFromResponse(normalized.members);
              if (
                mountedRef.current &&
                teamNameRef.current === requestTeamName &&
                requestGenerationRef.current === requestGeneration
              ) {
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
              }
              return members;
            })
            .finally(() => {
              if (inFlightRef.current.get(requestKey) === request) {
                inFlightRef.current.delete(requestKey);
              }
            });
          inFlightRef.current.set(requestKey, request);
        }

        const members = await request;
        if (!requestStillActive()) {
          return;
        }
        const currentMembers = Array.from(members.values()).filter((member) => {
          return (
            activeRequestKeyByMemberRef.current.get(normalizeMemberName(member.memberName)) ===
            requestKey
          );
        });
        if (currentMembers.length > 0) {
          setPreviewsByMember((current) => mergeMemberPreviews(current, currentMembers));
        }
        if (requestStillVisible()) {
          setError(null);
        }
      } catch (loadError) {
        if (!requestStillVisible()) {
          return;
        }
        setError(
          loadError instanceof Error ? loadError.message : 'Failed to load graph log previews'
        );
      } finally {
        if (
          requestStillVisible() &&
          !hasInFlightMemberPreviewRequest(
            memberNamesRef.current,
            activeRequestKeyByMemberRef.current,
            inFlightRef.current
          ) &&
          !hasPendingLoadingReload(
            pendingReloadRef.current,
            memberNamesRef.current,
            previewsByMemberRef.current
          )
        ) {
          setLoading(false);
        }
      }
    },
    [enabled, input.teamName, laneIdsByMember, maxItemsPerMember, memberNames, textLimit]
  );
  const loadPreviewsRef = useRef(loadPreviews);
  loadPreviewsRef.current = loadPreviews;

  const scheduleReload = useCallback(
    (options?: { forceRefresh?: boolean; background?: boolean }) => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (memberNamesRef.current.length === 0) return;

      if (
        options?.forceRefresh === true &&
        hasEmptyOrUnloadedMemberPreview(memberNamesRef.current, previewsByMemberRef.current)
      ) {
        setLoading(true);
        setError(null);
      }

      const current = pendingReloadRef.current;
      pendingReloadRef.current = {
        forceRefresh: (current?.forceRefresh ?? false) || options?.forceRefresh === true,
        background: (current?.background ?? true) && options?.background === true,
      };

      if (reloadTimerRef.current) {
        clearTimeout(reloadTimerRef.current);
      }
      reloadTimerRef.current = setTimeout(() => {
        reloadTimerRef.current = null;
        const pending = pendingReloadRef.current;
        pendingReloadRef.current = null;
        void loadPreviewsRef.current({
          background: pending?.background,
          forceRefresh: pending?.forceRefresh,
        });
      }, LIVE_RELOAD_DEBOUNCE_MS);
    },
    []
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearScheduledReload();
    };
  }, [clearScheduledReload]);

  useEffect(() => {
    if (!enabled || memberNames.length === 0) {
      clearScheduledReload();
      setLoading(false);
      setError(null);
      return;
    }
    const hasUnloadedPreview = hasUnloadedMemberPreview(memberNames, previewsByMemberRef.current);
    const laneKeyChanged = laneKeyRef.current !== laneKey;
    laneKeyRef.current = laneKey;
    if (hasUnloadedPreview) {
      setLoading(true);
      setError(null);
    }
    scheduleReload({ forceRefresh: hasUnloadedPreview || laneKeyChanged });
  }, [
    clearScheduledReload,
    enabled,
    input.teamName,
    laneKey,
    memberKey,
    memberNames.length,
    scheduleReload,
  ]);

  useEffect(() => {
    if (!enabled) return;

    const unsubscribe = api.teams.onTeamChange?.((_event: unknown, event: TeamChangeEvent) => {
      if (event.teamName !== input.teamName) return;
      if (event.type === 'log-source-change') {
        scheduleReload({ background: true, forceRefresh: true });
        return;
      }
      if (event.type === 'tool-activity') {
        scheduleReload({ background: true, forceRefresh: true });
        return;
      }
      if (event.type === 'task-log-change') {
        scheduleReload({ background: true, forceRefresh: true });
      }
    });

    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        scheduleReload({ background: true, forceRefresh: true });
      }
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    return () => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [enabled, input.teamName, scheduleReload]);

  return { previewsByMember, loading, error, reload: loadPreviews };
}
