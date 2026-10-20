import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@renderer/api';

import type {
  ConfirmCustomTeamTemplateSaveResult,
  CustomTeamTemplatePreview,
  CustomTeamTemplateV1,
  CustomTeamTemplateValidationIssue,
  PrepareCustomTeamTemplatePreviewResult,
  RecheckCustomTeamTemplateSaveResult,
} from '@features/custom-team-templates/contracts';

/**
 * Why the reviewed preview cannot currently be produced.
 *
 * Every reason is recoverable by re-running prepare: the roster could not be
 * read, the source team configuration is gone, the library is unreachable, or
 * the request itself failed at the transport boundary.
 */
export type SaveBlockReason =
  | 'rosterUnreadable'
  | 'sourceUnavailable'
  | 'storageUnavailable'
  | 'requestFailed';

/**
 * Progress of one confirmed save, kept strictly separate from the preview.
 *
 * `saved` is the only success state and is only ever reached from a typed
 * `created`/`alreadySaved`/re-check `saved` result. `unresolved` and
 * `requestFailed` mean the outcome is honestly unknown, so the UI offers a
 * re-check instead of saving again; `unavailable` records that the store did
 * not accept the write (during `save`) or could not be read (during `recheck`).
 */
export type SaveAttempt =
  | { status: 'saving' }
  | { status: 'rechecking' }
  | { status: 'saved'; template: CustomTeamTemplateV1; alreadyPresent: boolean }
  | { status: 'unresolved'; templateId: string }
  | { status: 'notSaved'; templateId: string }
  | { status: 'idConflict'; templateId: string }
  | { status: 'requestFailed' }
  | { status: 'unavailable'; during: 'save' | 'recheck' };

/** Notice shown above the preview after the reviewed projection changed. */
export type SaveNotice = 'stale' | 'expired' | null;

export interface UseSaveAsTemplateInput {
  open: boolean;
  sourceTeamName: string;
  initialName: string;
}

export interface UseSaveAsTemplateResult {
  name: string;
  description: string;
  preview: CustomTeamTemplatePreview | null;
  preparing: boolean;
  blockedReason: SaveBlockReason | null;
  issues: readonly CustomTeamTemplateValidationIssue[];
  nameConflict: boolean;
  notice: SaveNotice;
  attempt: SaveAttempt | null;
  canSave: boolean;
  canRecheck: boolean;
  busy: boolean;
  setName: (value: string) => void;
  setDescription: (value: string) => void;
  save: () => Promise<void>;
  recheck: () => Promise<void>;
  /** Re-runs preview preparation with the currently typed name/description. */
  refresh: () => Promise<void>;
}

const isTokenIssue = (issue: CustomTeamTemplateValidationIssue): boolean =>
  issue.code === 'previewTokenRequired' ||
  issue.code === 'previewTokenUnknown' ||
  issue.code === 'previewTokenExpired';

/**
 * Drives the "Save as Template" workflow against `api.customTeamTemplates`.
 *
 * The hook owns only presentation state: the source team identity, the
 * reviewed content and the template id stay behind the API contract. Exactly
 * one request is in flight per flow (guarded by `busyRef` plus a request
 * sequence), a stale preview is refreshed through the API rather than retried,
 * and an unresolved write is only ever resolved by the re-check operation —
 * never by a second create.
 */
export function useSaveAsTemplate({
  open,
  sourceTeamName,
  initialName,
}: UseSaveAsTemplateInput): UseSaveAsTemplateResult {
  const [name, setNameState] = useState(initialName);
  const [description, setDescriptionState] = useState('');
  const [preview, setPreview] = useState<CustomTeamTemplatePreview | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [blockedReason, setBlockedReason] = useState<SaveBlockReason | null>(null);
  const [issues, setIssues] = useState<readonly CustomTeamTemplateValidationIssue[]>([]);
  const [nameConflict, setNameConflict] = useState(false);
  const [notice, setNotice] = useState<SaveNotice>(null);
  const [attempt, setAttempt] = useState<SaveAttempt | null>(null);

  const requestIdRef = useRef(0);
  const busyRef = useRef(false);

  const applyPrepareResult = useCallback((result: PrepareCustomTeamTemplatePreviewResult): void => {
    setIssues([]);
    setNameConflict(false);
    setBlockedReason(null);
    switch (result.status) {
      case 'previewReady':
        setPreview(result.preview);
        setAttempt(null);
        return;
      case 'rosterUnreadable':
        setPreview(null);
        setBlockedReason('rosterUnreadable');
        return;
      case 'sourceUnavailable':
        setPreview(null);
        setBlockedReason('sourceUnavailable');
        return;
      case 'storageUnavailable':
        setPreview(null);
        setBlockedReason('storageUnavailable');
        return;
      case 'validationFailed':
        setPreview(null);
        setIssues(result.issues);
        return;
      case 'nameConflict':
        setPreview(null);
        setNameConflict(true);
        return;
    }
  }, []);

  const runPrepare = useCallback(
    async (nextName: string, nextDescription: string): Promise<void> => {
      const requestId = ++requestIdRef.current;
      setPreparing(true);
      try {
        const result = await api.customTeamTemplates.preparePreview({
          sourceTeamName,
          name: nextName,
          description: nextDescription,
        });
        if (requestId !== requestIdRef.current) return;
        applyPrepareResult(result);
      } catch {
        if (requestId !== requestIdRef.current) return;
        setPreview(null);
        setBlockedReason('requestFailed');
      } finally {
        if (requestId === requestIdRef.current) {
          setPreparing(false);
        }
      }
    },
    [applyPrepareResult, sourceTeamName]
  );

  const applyIssues = useCallback(
    (nextIssues: readonly CustomTeamTemplateValidationIssue[]): void => {
      if (nextIssues.some(isTokenIssue)) {
        // The reviewed projection is gone: nothing may be saved against it, so
        // a fresh preview has to be reviewed before the next confirmation.
        setPreview(null);
        setIssues([]);
        setNotice('expired');
        void runPrepare(name, description);
        return;
      }
      setIssues(nextIssues);
    },
    [description, name, runPrepare]
  );

  const applySaveResult = useCallback(
    (result: ConfirmCustomTeamTemplateSaveResult): void => {
      switch (result.status) {
        case 'created':
          setAttempt({ status: 'saved', template: result.template, alreadyPresent: false });
          setNotice(null);
          return;
        case 'alreadySaved':
          setAttempt({ status: 'saved', template: result.template, alreadyPresent: true });
          setNotice(null);
          return;
        case 'stalePreview':
          // The reviewed projection is gone: never retry it automatically.
          setPreview(null);
          setAttempt(null);
          setNotice('stale');
          void runPrepare(name, description);
          return;
        case 'sourceUnavailable':
          setPreview(null);
          setAttempt(null);
          setBlockedReason('sourceUnavailable');
          return;
        case 'rosterUnreadable':
          setPreview(null);
          setAttempt(null);
          setBlockedReason('rosterUnreadable');
          return;
        case 'nameConflict':
          setAttempt(null);
          setNameConflict(true);
          return;
        case 'templateIdConflict':
          setAttempt({ status: 'idConflict', templateId: result.templateId });
          return;
        case 'validationFailed':
          setAttempt(null);
          applyIssues(result.issues);
          return;
        case 'storageUnavailable':
          setAttempt({ status: 'unavailable', during: 'save' });
          return;
        case 'unresolvedWriteOutcome':
          setAttempt({ status: 'unresolved', templateId: result.templateId });
          return;
      }
    },
    [applyIssues, description, name, runPrepare]
  );

  const applyRecheckResult = useCallback(
    (result: RecheckCustomTeamTemplateSaveResult): void => {
      switch (result.status) {
        case 'saved':
          setAttempt({ status: 'saved', template: result.template, alreadyPresent: true });
          setNotice(null);
          return;
        case 'templateIdConflict':
          setAttempt({ status: 'idConflict', templateId: result.templateId });
          return;
        case 'notSaved':
          setAttempt({ status: 'notSaved', templateId: result.templateId });
          return;
        case 'unresolved':
          setAttempt({ status: 'unresolved', templateId: result.templateId });
          return;
        case 'storageUnavailable':
          setAttempt({ status: 'unavailable', during: 'recheck' });
          return;
        case 'validationFailed':
          setAttempt(null);
          applyIssues(result.issues);
          return;
      }
    },
    [applyIssues]
  );

  const save = useCallback(async (): Promise<void> => {
    if (busyRef.current || !preview) return;
    const requestId = requestIdRef.current;
    busyRef.current = true;
    setNotice(null);
    setAttempt({ status: 'saving' });
    try {
      const result = await api.customTeamTemplates.saveTemplate({
        previewToken: preview.previewToken,
        name,
        description,
      });
      if (requestId !== requestIdRef.current) return;
      applySaveResult(result);
    } catch {
      if (requestId !== requestIdRef.current) return;
      // A transport failure says nothing about whether the write landed, so
      // the outcome stays unknown instead of being reported as a failure.
      setAttempt({ status: 'requestFailed' });
    } finally {
      busyRef.current = false;
    }
  }, [applySaveResult, description, name, preview]);

  const recheck = useCallback(async (): Promise<void> => {
    if (busyRef.current || !preview) return;
    const requestId = requestIdRef.current;
    busyRef.current = true;
    setAttempt({ status: 'rechecking' });
    try {
      const result = await api.customTeamTemplates.recheckSave({
        previewToken: preview.previewToken,
      });
      if (requestId !== requestIdRef.current) return;
      applyRecheckResult(result);
    } catch {
      if (requestId !== requestIdRef.current) return;
      setAttempt({ status: 'requestFailed' });
    } finally {
      busyRef.current = false;
    }
  }, [applyRecheckResult, preview]);

  const refresh = useCallback(async (): Promise<void> => {
    if (busyRef.current) return;
    setAttempt(null);
    await runPrepare(name, description);
  }, [description, name, runPrepare]);

  const setName = useCallback(
    (value: string): void => {
      setNameState(value);
      setIssues((current) => current.filter((issue) => issue.field !== 'name'));
      // If we had a name conflict and the user is changing the name, automatically
      // refresh the preview with the new name so the next save works without a
      // false expiry error or redundant confirmation. We only do this when the
      // preview exists (content unchanged) and there was a nameConflict.
      if (nameConflict && preview && value !== name) {
        setNameConflict(false);
        setAttempt(null);
        // Trigger a fresh preview preparation with the new name
        void runPrepare(value, description);
      } else {
        setNameConflict(false);
        setAttempt((current) => (current?.status === 'idConflict' ? null : current));
      }
    },
    [description, name, nameConflict, preview, runPrepare]
  );

  const setDescription = useCallback(
    (value: string): void => {
      setDescriptionState(value);
      setIssues((current) => current.filter((issue) => issue.field !== 'description'));
      // If we had a name conflict and the user is changing the description, also
      // refresh the preview so the next save works with the updated content.
      if (nameConflict && preview) {
        setAttempt(null);
        void runPrepare(name, value);
      } else {
        setAttempt((current) => (current?.status === 'idConflict' ? null : current));
      }
    },
    [name, nameConflict, preview, runPrepare]
  );

  useEffect(() => {
    if (!open) return;
    // Any response that arrives after the dialog reopened belongs to a previous
    // session and must be dropped.
    requestIdRef.current += 1;
    busyRef.current = false;
    setNameState(initialName);
    setDescriptionState('');
    setPreview(null);
    setPreparing(false);
    setBlockedReason(null);
    setIssues([]);
    setNameConflict(false);
    setNotice(null);
    setAttempt(null);
    void runPrepare(initialName, '');
  }, [initialName, open, runPrepare, sourceTeamName]);

  const canSave =
    preview !== null &&
    blockedReason === null &&
    !preparing &&
    // A confirmed absence and a store that refused the write are both safe to
    // retry with the same content; a conflicting id is not (it needs a new
    // name, description or preview), and an unavailable re-check stays unknown.
    (attempt === null ||
      attempt.status === 'notSaved' ||
      (attempt.status === 'unavailable' && attempt.during === 'save'));

  const canRecheck =
    preview !== null &&
    attempt !== null &&
    (attempt.status === 'unresolved' ||
      attempt.status === 'requestFailed' ||
      attempt.status === 'unavailable');

  const busy = attempt?.status === 'saving' || attempt?.status === 'rechecking' || preparing;

  return {
    name,
    description,
    preview,
    preparing,
    blockedReason,
    issues,
    nameConflict,
    notice,
    attempt,
    canSave,
    canRecheck,
    busy,
    setName,
    setDescription,
    save,
    recheck,
    refresh,
  };
}
