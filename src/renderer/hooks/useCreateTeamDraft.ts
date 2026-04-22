/**
 * Unified draft hook for CreateTeamDialog form state.
 *
 * Persists team name, members, paths, and flags to IndexedDB so that
 * navigating away from the Teams tab and back preserves user input.
 *
 * Key guarantees:
 * - Single IndexedDB key (`createTeamDraft:form`), no TTL.
 * - Race-safe: late async load never overwrites fresh user input.
 * - Debounced writes with immediate flush on unmount.
 * - Draft is cleared only on successful team creation.
 *
 * Pattern mirrors `useComposerDraft.ts`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { createMemberDraft } from '@renderer/components/team/members/membersEditorUtils';
import {
  setStoredCreateTeamMemberRuntimePreferences,
  getStoredCreateTeamSyncModelsWithLead,
  setStoredCreateTeamSyncModelsWithLead,
} from '@renderer/services/createTeamPreferences';
import {
  type CreateTeamDraftSnapshot,
  createTeamDraftStorage,
  type SerializedMemberDraft,
} from '@renderer/services/createTeamDraftStorage';

import type { MemberDraft } from '@renderer/components/team/members/membersEditorTypes';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseCreateTeamDraftResult {
  teamName: string;
  setTeamName: (v: string) => void;
  members: MemberDraft[];
  setMembers: (v: MemberDraft[]) => void;
  syncModelsWithLead: boolean;
  setSyncModelsWithLead: (v: boolean, options?: { persistStoredPreference?: boolean }) => void;
  teammateWorktreeDefault: boolean;
  setTeammateWorktreeDefault: (v: boolean) => void;
  cwdMode: 'project' | 'custom';
  setCwdMode: (v: 'project' | 'custom') => void;
  selectedProjectPath: string;
  setSelectedProjectPath: (v: string) => void;
  customCwd: string;
  setCustomCwd: (v: string) => void;
  soloTeam: boolean;
  setSoloTeam: (v: boolean) => void;
  launchTeam: boolean;
  setLaunchTeam: (v: boolean) => void;
  teamColor: string;
  setTeamColor: (v: string) => void;

  /** `true` after the initial IndexedDB load completes. */
  isLoaded: boolean;
  /** Clear all draft state and delete the IndexedDB entry. */
  clearDraft: () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 400;

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

function serializeMembers(members: MemberDraft[]): SerializedMemberDraft[] {
  return members.map(
    ({ id, name, roleSelection, customRole, workflow, isolation, providerId, model, effort }) => ({
      id,
      name,
      roleSelection,
      customRole,
      workflow,
      isolation,
      providerId,
      model,
      effort,
    })
  );
}

function deserializeMembers(serialized: SerializedMemberDraft[]): MemberDraft[] {
  return serialized.map((m) =>
    createMemberDraft({
      id: m.id,
      name: m.name,
      roleSelection: m.roleSelection,
      customRole: m.customRole,
      workflow: m.workflow,
      isolation: m.isolation === 'worktree' ? 'worktree' : undefined,
      providerId: m.providerId,
      model: m.model,
      effort: m.effort,
    })
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useCreateTeamDraft(): UseCreateTeamDraftResult {
  const storedSyncModelsWithLead = getStoredCreateTeamSyncModelsWithLead();

  // ── State ──────────────────────────────────────────────────────────────
  const [teamName, setTeamNameState] = useState('');
  const [members, setMembersState] = useState<MemberDraft[]>([]);
  const [syncModelsWithLead, setSyncModelsWithLeadState] = useState(storedSyncModelsWithLead);
  const [teammateWorktreeDefault, setTeammateWorktreeDefaultState] = useState(false);
  const [cwdMode, setCwdModeState] = useState<'project' | 'custom'>('project');
  const [selectedProjectPath, setSelectedProjectPathState] = useState('');
  const [customCwd, setCustomCwdState] = useState('');
  const [soloTeam, setSoloTeamState] = useState(false);
  const [launchTeam, setLaunchTeamState] = useState(true);
  const [teamColor, setTeamColorState] = useState('');
  const [isLoaded, setIsLoaded] = useState(false);

  // ── Refs (latest values for debounced callbacks) ───────────────────────
  const teamNameRef = useRef('');
  const membersRef = useRef<MemberDraft[]>([]);
  const syncModelsWithLeadRef = useRef(storedSyncModelsWithLead);
  const teammateWorktreeDefaultRef = useRef(false);
  const cwdModeRef = useRef<'project' | 'custom'>('project');
  const selectedProjectPathRef = useRef('');
  const customCwdRef = useRef('');
  const soloTeamRef = useRef(false);
  const launchTeamRef = useRef(true);
  const teamColorRef = useRef('');
  const mountedRef = useRef(true);
  const userTouchedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<CreateTeamDraftSnapshot | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ── Snapshot builder ───────────────────────────────────────────────────

  const buildSnapshot = useCallback((): CreateTeamDraftSnapshot => {
    return {
      version: 1,
      teamName: teamNameRef.current,
      members: serializeMembers(membersRef.current),
      syncModelsWithLead: syncModelsWithLeadRef.current,
      teammateWorktreeDefault: teammateWorktreeDefaultRef.current,
      cwdMode: cwdModeRef.current,
      selectedProjectPath: selectedProjectPathRef.current,
      customCwd: customCwdRef.current,
      soloTeam: soloTeamRef.current,
      launchTeam: launchTeamRef.current,
      teamColor: teamColorRef.current,
      updatedAt: Date.now(),
    };
  }, []);

  // ── Flush / schedule ───────────────────────────────────────────────────

  const flushPending = useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (pendingRef.current != null) {
      const pending = pendingRef.current;
      pendingRef.current = null;
      const isEmpty = pending.teamName === '' && pending.members.length === 0;
      if (isEmpty) {
        void createTeamDraftStorage.deleteSnapshot();
      } else {
        void createTeamDraftStorage.saveSnapshot(pending);
      }
    }
  }, []);

  const scheduleSave = useCallback(() => {
    const snapshot = buildSnapshot();
    pendingRef.current = snapshot;

    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
    }

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending == null) return;

      const isEmpty = pending.teamName === '' && pending.members.length === 0;
      if (isEmpty) {
        void createTeamDraftStorage.deleteSnapshot();
      } else {
        void createTeamDraftStorage.saveSnapshot(pending);
      }
    }, DEBOUNCE_MS);
  }, [buildSnapshot]);

  // ── Apply snapshot to state ────────────────────────────────────────────

  const applySnapshot = useCallback((snap: CreateTeamDraftSnapshot) => {
    const deserialized = deserializeMembers(snap.members);
    const nextSyncModelsWithLead =
      snap.syncModelsWithLead ?? getStoredCreateTeamSyncModelsWithLead();

    setStoredCreateTeamSyncModelsWithLead(nextSyncModelsWithLead);
    if (!nextSyncModelsWithLead) {
      setStoredCreateTeamMemberRuntimePreferences(deserialized);
    }

    teamNameRef.current = snap.teamName;
    membersRef.current = deserialized;
    syncModelsWithLeadRef.current = nextSyncModelsWithLead;
    teammateWorktreeDefaultRef.current = snap.teammateWorktreeDefault === true;
    cwdModeRef.current = snap.cwdMode;
    selectedProjectPathRef.current = snap.selectedProjectPath;
    customCwdRef.current = snap.customCwd;
    soloTeamRef.current = snap.soloTeam;
    launchTeamRef.current = snap.launchTeam;
    teamColorRef.current = snap.teamColor;

    setTeamNameState(snap.teamName);
    setMembersState(deserialized);
    setSyncModelsWithLeadState(nextSyncModelsWithLead);
    setTeammateWorktreeDefaultState(snap.teammateWorktreeDefault === true);
    setCwdModeState(snap.cwdMode);
    setSelectedProjectPathState(snap.selectedProjectPath);
    setCustomCwdState(snap.customCwd);
    setSoloTeamState(snap.soloTeam);
    setLaunchTeamState(snap.launchTeam);
    setTeamColorState(snap.teamColor);
  }, []);

  // ── Load on mount ──────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const snapshot = await createTeamDraftStorage.loadSnapshot();
      if (cancelled) return;

      // Race protection: if user already interacted, don't overwrite
      if (userTouchedRef.current) {
        if (mountedRef.current) setIsLoaded(true);
        return;
      }

      if (snapshot != null) {
        applySnapshot(snapshot);
      }

      if (mountedRef.current) setIsLoaded(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [applySnapshot]);

  // Flush on unmount
  useEffect(() => {
    return () => {
      flushPending();
    };
  }, [flushPending]);

  // ── Setters ────────────────────────────────────────────────────────────

  const setTeamName = useCallback(
    (v: string) => {
      userTouchedRef.current = true;
      teamNameRef.current = v;
      setTeamNameState(v);
      scheduleSave();
    },
    [scheduleSave]
  );

  const setMembers = useCallback(
    (v: MemberDraft[]) => {
      userTouchedRef.current = true;
      membersRef.current = v;
      setMembersState(v);
      scheduleSave();
    },
    [scheduleSave]
  );

  const setSyncModelsWithLead = useCallback(
    (v: boolean, options?: { persistStoredPreference?: boolean }) => {
      userTouchedRef.current = true;
      syncModelsWithLeadRef.current = v;
      setSyncModelsWithLeadState(v);
      if (options?.persistStoredPreference !== false) {
        setStoredCreateTeamSyncModelsWithLead(v);
      }
      scheduleSave();
    },
    [scheduleSave]
  );

  const setTeammateWorktreeDefault = useCallback(
    (v: boolean) => {
      userTouchedRef.current = true;
      teammateWorktreeDefaultRef.current = v;
      setTeammateWorktreeDefaultState(v);
      scheduleSave();
    },
    [scheduleSave]
  );

  const setCwdMode = useCallback(
    (v: 'project' | 'custom') => {
      userTouchedRef.current = true;
      cwdModeRef.current = v;
      setCwdModeState(v);
      scheduleSave();
    },
    [scheduleSave]
  );

  const setSelectedProjectPath = useCallback(
    (v: string) => {
      userTouchedRef.current = true;
      selectedProjectPathRef.current = v;
      setSelectedProjectPathState(v);
      scheduleSave();
    },
    [scheduleSave]
  );

  const setCustomCwd = useCallback(
    (v: string) => {
      userTouchedRef.current = true;
      customCwdRef.current = v;
      setCustomCwdState(v);
      scheduleSave();
    },
    [scheduleSave]
  );

  const setSoloTeam = useCallback(
    (v: boolean) => {
      userTouchedRef.current = true;
      soloTeamRef.current = v;
      setSoloTeamState(v);
      scheduleSave();
    },
    [scheduleSave]
  );

  const setLaunchTeam = useCallback(
    (v: boolean) => {
      userTouchedRef.current = true;
      launchTeamRef.current = v;
      setLaunchTeamState(v);
      scheduleSave();
    },
    [scheduleSave]
  );

  const setTeamColor = useCallback(
    (v: string) => {
      userTouchedRef.current = true;
      teamColorRef.current = v;
      setTeamColorState(v);
      scheduleSave();
    },
    [scheduleSave]
  );

  // ── Clear all ──────────────────────────────────────────────────────────

  const clearDraft = useCallback(() => {
    const nextStoredSyncModelsWithLead = getStoredCreateTeamSyncModelsWithLead();
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = null;
    // Keep userTouchedRef true so a late IDB load (theoretically impossible
    // since isLoaded gates submit, but defensive) cannot resurrect deleted data.
    userTouchedRef.current = true;

    teamNameRef.current = '';
    membersRef.current = [];
    syncModelsWithLeadRef.current = nextStoredSyncModelsWithLead;
    teammateWorktreeDefaultRef.current = false;
    cwdModeRef.current = 'project';
    selectedProjectPathRef.current = '';
    customCwdRef.current = '';
    soloTeamRef.current = false;
    launchTeamRef.current = true;
    teamColorRef.current = '';

    setTeamNameState('');
    setMembersState([]);
    setSyncModelsWithLeadState(nextStoredSyncModelsWithLead);
    setTeammateWorktreeDefaultState(false);
    setCwdModeState('project');
    setSelectedProjectPathState('');
    setCustomCwdState('');
    setSoloTeamState(false);
    setLaunchTeamState(true);
    setTeamColorState('');

    void createTeamDraftStorage.deleteSnapshot();
  }, []);

  return {
    teamName,
    setTeamName,
    members,
    setMembers,
    syncModelsWithLead,
    setSyncModelsWithLead,
    teammateWorktreeDefault,
    setTeammateWorktreeDefault,
    cwdMode,
    setCwdMode,
    selectedProjectPath,
    setSelectedProjectPath,
    customCwd,
    setCustomCwd,
    soloTeam,
    setSoloTeam,
    launchTeam,
    setLaunchTeam,
    teamColor,
    setTeamColor,
    isLoaded,
    clearDraft,
  };
}
