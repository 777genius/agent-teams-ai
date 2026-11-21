import { useCallback, useEffect, useRef, useState } from 'react';

import {
  type CustomTeamTemplateMemberV1,
  type CustomTeamTemplateV1,
  type CustomTeamTemplateValidationIssue,
  resolveTemplateRevision,
  type UpdateCustomTeamTemplateFields,
} from '@features/custom-team-templates/contracts';
import { api } from '@renderer/api';

export type EditTemplateStatus =
  | 'idle'
  | 'saving'
  | 'saved'
  | 'revisionConflict'
  | 'nameConflict'
  | 'notFound'
  | 'unreadableRecord'
  | 'storageUnavailable'
  | 'unresolvedWriteOutcome'
  | 'requestFailed'
  | 'requestSizeValidationFailed';

export interface UseEditTemplateInput {
  open: boolean;
  template: CustomTeamTemplateV1 | null;
  onSaved?: (updated: CustomTeamTemplateV1) => void;
}

export interface UseEditTemplateResult {
  name: string;
  description: string;
  teamPrompt: string;
  members: readonly CustomTeamTemplateMemberV1[];
  expectedRevision: number;
  busy: boolean;
  status: EditTemplateStatus;
  issues: readonly CustomTeamTemplateValidationIssue[];
  revisionConflict: CustomTeamTemplateV1 | null;
  canSave: boolean;
  canRecheck: boolean;
  setName: (value: string) => void;
  setDescription: (value: string) => void;
  setTeamPrompt: (value: string) => void;
  addMember: (member?: Partial<CustomTeamTemplateMemberV1>) => void;
  updateMember: (index: number, patch: Partial<CustomTeamTemplateMemberV1>) => void;
  removeMember: (index: number) => void;
  save: () => Promise<boolean>;
  recheck: () => Promise<boolean>;
  reset: () => void;
  acceptRevisionConflict: () => void;
  overwriteRevisionConflict: () => void;
}

/** The exact update that was dispatched, retained while its outcome is unknown. */
interface PendingUpdate {
  expectedRevision: number;
  fields: UpdateCustomTeamTemplateFields;
}

function normalizeDescription(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function membersMatch(
  stored: readonly CustomTeamTemplateMemberV1[],
  intended: readonly CustomTeamTemplateMemberV1[]
): boolean {
  if (stored.length !== intended.length) return false;
  return stored.every((member, index) => {
    const expected = intended[index];
    return (
      member.name === expected.name &&
      (member.role ?? null) === (expected.role ?? null) &&
      (member.workflow ?? null) === (expected.workflow ?? null)
    );
  });
}

/**
 * Confirms that a stored row is the committed result of one dispatched update.
 *
 * Only an exact next revision with the exact intended name, description,
 * prompt and roster proves the operation landed. A row that still carries the
 * old revision does not prove non-commit: the server may still be running the
 * mutation after the client stopped waiting.
 */
function matchesPendingUpdate(stored: CustomTeamTemplateV1, pending: PendingUpdate): boolean {
  return (
    resolveTemplateRevision(stored) === pending.expectedRevision + 1 &&
    stored.name === pending.fields.name.normalize('NFC').trim() &&
    (stored.description ?? null) === normalizeDescription(pending.fields.description) &&
    stored.teamPrompt === pending.fields.teamPrompt.trim() &&
    membersMatch(stored.members, pending.fields.members)
  );
}

/**
 * Manages the draft state, validation issues, concurrency control, and save
 * workflow for editing a custom template.
 *
 * Local draft state is preserved until the user explicitly saves or cancels.
 * A stale asynchronous response never replaces newer selection or draft state,
 * and revision conflicts stay visible and recoverable without discarding the
 * user's typed changes.
 */
export function useEditTemplate({
  open,
  template,
  onSaved,
}: UseEditTemplateInput): UseEditTemplateResult {
  const [name, setNameState] = useState(template?.name ?? '');
  const [description, setDescriptionState] = useState(template?.description ?? '');
  const [teamPrompt, setTeamPromptState] = useState(template?.teamPrompt ?? '');
  const [members, setMembersState] = useState<readonly CustomTeamTemplateMemberV1[]>(
    template?.members ? template.members.map((m) => ({ ...m })) : []
  );
  const [expectedRevision, setExpectedRevision] = useState(
    template ? resolveTemplateRevision(template) : 1
  );

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<EditTemplateStatus>('idle');
  const [issues, setIssues] = useState<readonly CustomTeamTemplateValidationIssue[]>([]);
  const [revisionConflict, setRevisionConflict] = useState<CustomTeamTemplateV1 | null>(null);

  const requestIdRef = useRef(0);
  const lastTemplateIdRef = useRef<string | null>(null);
  const pendingUpdateRef = useRef<PendingUpdate | null>(null);

  // Initialize draft when opened or when template selection changes
  useEffect(() => {
    if (!open || !template) {
      if (!open) {
        requestIdRef.current += 1;
        pendingUpdateRef.current = null;
        setBusy(false);
        setStatus('idle');
        setIssues([]);
        setRevisionConflict(null);
        lastTemplateIdRef.current = null;
      }
      return;
    }

    if (lastTemplateIdRef.current !== template.templateId) {
      lastTemplateIdRef.current = template.templateId;
      requestIdRef.current += 1;
      pendingUpdateRef.current = null;
      setNameState(template.name);
      setDescriptionState(template.description ?? '');
      setTeamPromptState(template.teamPrompt);
      setMembersState(template.members.map((m) => ({ ...m })));
      setExpectedRevision(resolveTemplateRevision(template));
      setBusy(false);
      setStatus('idle');
      setIssues([]);
      setRevisionConflict(null);
    }
  }, [open, template]);

  const setName = useCallback((value: string) => {
    setNameState(value);
    setIssues((prev) => prev.filter((i) => i.field !== 'name'));
    setStatus((prev) => (prev === 'nameConflict' ? 'idle' : prev));
  }, []);

  const setDescription = useCallback((value: string) => {
    setDescriptionState(value);
    setIssues((prev) => prev.filter((i) => i.field !== 'description'));
  }, []);

  const setTeamPrompt = useCallback((value: string) => {
    setTeamPromptState(value);
    setIssues((prev) => prev.filter((i) => i.field !== 'teamPrompt'));
  }, []);

  const addMember = useCallback((member?: Partial<CustomTeamTemplateMemberV1>) => {
    setMembersState((prev) => [
      ...prev,
      {
        name: member?.name ?? '',
        role: member?.role ?? '',
        workflow: member?.workflow ?? '',
      },
    ]);
  }, []);

  const updateMember = useCallback((index: number, patch: Partial<CustomTeamTemplateMemberV1>) => {
    setMembersState((prev) =>
      prev.map((item, idx) => (idx === index ? { ...item, ...patch } : item))
    );
    setIssues((prev) => prev.filter((i) => !i.field.startsWith(`members[${index}]`)));
  }, []);

  const removeMember = useCallback((index: number) => {
    setMembersState((prev) => prev.filter((_, idx) => idx !== index));
    setIssues((prev) => prev.filter((i) => !i.field.startsWith('members')));
  }, []);

  const reset = useCallback(() => {
    if (!template) return;
    pendingUpdateRef.current = null;
    setNameState(template.name);
    setDescriptionState(template.description ?? '');
    setTeamPromptState(template.teamPrompt);
    setMembersState(template.members.map((m) => ({ ...m })));
    setExpectedRevision(resolveTemplateRevision(template));
    setStatus('idle');
    setIssues([]);
    setRevisionConflict(null);
  }, [template]);

  const acceptRevisionConflict = useCallback(() => {
    if (!revisionConflict) return;
    pendingUpdateRef.current = null;
    setNameState(revisionConflict.name);
    setDescriptionState(revisionConflict.description ?? '');
    setTeamPromptState(revisionConflict.teamPrompt);
    setMembersState(revisionConflict.members.map((m) => ({ ...m })));
    setExpectedRevision(resolveTemplateRevision(revisionConflict));
    setRevisionConflict(null);
    setStatus('idle');
    setIssues([]);
  }, [revisionConflict]);

  const overwriteRevisionConflict = useCallback(() => {
    if (!revisionConflict) return;
    pendingUpdateRef.current = null;
    setExpectedRevision(resolveTemplateRevision(revisionConflict));
    setRevisionConflict(null);
    setStatus('idle');
    setIssues([]);
  }, [revisionConflict]);

  const save = useCallback(async (): Promise<boolean> => {
    if (busy || !template || status === 'unresolvedWriteOutcome') return false;

    // Normalize the team prompt with the established trim() policy before
    // validation, hashing, and writing. A valid string keeps its internal
    // whitespace; only leading/trailing whitespace is removed, and empty or
    // whitespace-only strings are still valid (empty prompt is allowed).
    const normalizedTeamPrompt = teamPrompt.trim();
    const fields: UpdateCustomTeamTemplateFields = {
      name,
      description: description.trim() ? description : undefined,
      teamPrompt: normalizedTeamPrompt,
      members: members.map((m) => ({
        // The update use case trims member names before hashing and writing, so
        // the dispatched payload must carry the same normalized value. A
        // whitespace-only name still collapses to '' and fails validation.
        name: m.name.trim(),
        ...(m.role?.trim() ? { role: m.role.trim() } : {}),
        ...(m.workflow?.trim() ? { workflow: m.workflow.trim() } : {}),
      })),
    };
    const pending: PendingUpdate = { expectedRevision, fields };

    const requestId = ++requestIdRef.current;
    pendingUpdateRef.current = pending;
    setBusy(true);
    setStatus('saving');
    setIssues([]);

    let result: Awaited<ReturnType<typeof api.customTeamTemplates.updateTemplate>>;
    try {
      result = await api.customTeamTemplates.updateTemplate({
        templateId: template.templateId,
        expectedRevision,
        fields,
      });
    } catch (error) {
      if (requestId !== requestIdRef.current) return false;
      // HTTP 413 is a pre-dispatch rejection: Fastify rejects oversized
      // payloads before the route handler runs, so the mutation was never
      // dispatched. Treat it as a definitive, known failure rather than an
      // ambiguous unresolved write.
      const isHttp413 =
        typeof error === 'object' &&
        error !== null &&
        'message' in error &&
        String((error as { message: string }).message).includes('HTTP 413');
      if (isHttp413) {
        setStatus('requestSizeValidationFailed');
        return false;
      }
      // A genuine dispatched transport failure (timeout, abort, network loss,
      // malformed response) keeps the outcome unknown and requires a
      // read-only re-check.
      setStatus('unresolvedWriteOutcome');
      return false;
    } finally {
      if (requestId === requestIdRef.current) {
        setBusy(false);
      }
    }

    if (requestId !== requestIdRef.current) return false;

    // Only result processing runs here: an exception from onSaved or any other
    // UI callback is never mistaken for a transport failure.
    switch (result.status) {
      case 'updated': {
        pendingUpdateRef.current = null;
        setStatus('saved');
        setExpectedRevision(resolveTemplateRevision(result.template));
        onSaved?.(result.template);
        return true;
      }
      case 'revisionConflict': {
        pendingUpdateRef.current = null;
        setStatus('revisionConflict');
        setRevisionConflict(result.current);
        return false;
      }
      case 'nameConflict': {
        pendingUpdateRef.current = null;
        setStatus('nameConflict');
        return false;
      }
      case 'validationFailed': {
        pendingUpdateRef.current = null;
        setStatus('idle');
        setIssues(result.issues);
        return false;
      }
      case 'notFound':
      case 'unreadableRecord':
      case 'storageUnavailable': {
        pendingUpdateRef.current = null;
        setStatus(result.status);
        return false;
      }
      case 'unresolvedWriteOutcome': {
        // The server could not reconcile its own write either, so keep the
        // dispatched payload for a later read-only re-check.
        setStatus('unresolvedWriteOutcome');
        return false;
      }
    }
  }, [busy, description, expectedRevision, members, name, onSaved, status, teamPrompt, template]);

  const recheck = useCallback(async (): Promise<boolean> => {
    const pending = pendingUpdateRef.current;
    if (busy || !template || status !== 'unresolvedWriteOutcome' || !pending) return false;

    const requestId = ++requestIdRef.current;
    setBusy(true);

    let stored: CustomTeamTemplateV1 | null = null;
    try {
      const result = await api.customTeamTemplates.listTemplates();
      if (requestId !== requestIdRef.current) return false;
      if (result.status === 'ready' || result.status === 'hasUnreadableRecords') {
        const candidate = result.templates.find(
          (entry) => entry.templateId === template.templateId
        );
        if (candidate && matchesPendingUpdate(candidate, pending)) {
          stored = candidate;
        }
      }
    } catch {
      // A failed read proves nothing about the write; the outcome stays unknown.
      return false;
    } finally {
      if (requestId === requestIdRef.current) {
        setBusy(false);
      }
    }

    if (requestId !== requestIdRef.current || !stored) return false;

    pendingUpdateRef.current = null;
    setStatus('saved');
    setExpectedRevision(resolveTemplateRevision(stored));
    onSaved?.(stored);
    return true;
  }, [busy, onSaved, status, template]);

  const canSave = !busy && name.trim().length > 0 && status !== 'unresolvedWriteOutcome';
  const canRecheck =
    !busy && status === 'unresolvedWriteOutcome' && pendingUpdateRef.current !== null;

  return {
    name,
    description,
    teamPrompt,
    members,
    expectedRevision,
    busy,
    status,
    issues,
    revisionConflict,
    canSave,
    canRecheck,
    setName,
    setDescription,
    setTeamPrompt,
    addMember,
    updateMember,
    removeMember,
    save,
    recheck,
    reset,
    acceptRevisionConflict,
    overwriteRevisionConflict,
  };
}
