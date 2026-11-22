import { useCallback, useEffect, useRef, useState } from 'react';

import {
  CUSTOM_TEAM_TEMPLATE_MAX_IMPORT_FILE_BYTES,
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
  creating?: boolean;
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
  replaceMembers: (members: readonly CustomTeamTemplateMemberV1[]) => void;
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

/** Fastify rejects oversized payloads before starting either write operation. */
function isHttpPayloadTooLarge(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    String((error as { message: unknown }).message).includes('HTTP 413')
  );
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

/** A creation can only be confirmed by its server-issued identity and exact content. */
function matchesPendingCreate(
  stored: CustomTeamTemplateV1,
  fields: UpdateCustomTeamTemplateFields
): boolean {
  return (
    resolveTemplateRevision(stored) === 1 &&
    stored.name === fields.name.normalize('NFC').trim() &&
    (stored.description ?? null) === normalizeDescription(fields.description) &&
    stored.teamPrompt === fields.teamPrompt.trim() &&
    membersMatch(stored.members, fields.members)
  );
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
  creating = false,
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
  // Only typed server responses expose the new id. An unknown transport failure
  // has no trustworthy id and must not be misreported as a confirmed create.
  const pendingCreateIdRef = useRef<string | null>(null);

  // Initialize draft when opened or when template selection changes
  useEffect(() => {
    if (!open || !template) {
      if (!open) {
        requestIdRef.current += 1;
        pendingUpdateRef.current = null;
        pendingCreateIdRef.current = null;
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
      pendingCreateIdRef.current = null;
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

  const replaceMembers = useCallback((next: readonly CustomTeamTemplateMemberV1[]) => {
    setMembersState(next.map((member) => ({ ...member })));
    setIssues((prev) => prev.filter((issue) => !issue.field.startsWith('members')));
  }, []);

  const reset = useCallback(() => {
    if (!template) return;
    pendingUpdateRef.current = null;
    pendingCreateIdRef.current = null;
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
    pendingCreateIdRef.current = null;
    setBusy(true);
    setStatus('saving');
    setIssues([]);

    if (creating) {
      const portable = {
        format: 'agent-teams-custom-template' as const,
        schemaVersion: 1 as const,
        ...fields,
      };
      // Avoid dispatching an oversized browser request that Fastify will reject
      // before the import handler. Its definitive HTTP 413 is also handled below.
      const requestBytes = new TextEncoder().encode(JSON.stringify({ portable })).byteLength;
      if (requestBytes > CUSTOM_TEAM_TEMPLATE_MAX_IMPORT_FILE_BYTES) {
        pendingUpdateRef.current = null;
        setStatus('requestSizeValidationFailed');
        setBusy(false);
        return false;
      }
      try {
        const result = await api.customTeamTemplates.importTemplate({ portable });
        if (requestId !== requestIdRef.current) return false;
        if (result.status === 'imported') {
          pendingUpdateRef.current = null;
          setStatus('saved');
          onSaved?.(result.template);
          return true;
        }
        if (result.status === 'validationFailed') {
          setIssues(result.issues);
          setStatus('idle');
        } else if (result.status === 'nameConflict') setStatus('nameConflict');
        else if (result.status === 'unresolvedWriteOutcome') {
          pendingCreateIdRef.current = result.templateId || null;
          setStatus('unresolvedWriteOutcome');
        }
        else setStatus('storageUnavailable');
        return false;
      } catch (error) {
        if (requestId === requestIdRef.current) {
          if (isHttpPayloadTooLarge(error)) {
            pendingUpdateRef.current = null;
            setStatus('requestSizeValidationFailed');
          } else {
            setStatus('unresolvedWriteOutcome');
          }
        }
        return false;
      } finally {
        if (requestId === requestIdRef.current) setBusy(false);
      }
    }

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
      if (isHttpPayloadTooLarge(error)) {
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
  }, [
    busy,
    creating,
    description,
    expectedRevision,
    members,
    name,
    onSaved,
    status,
    teamPrompt,
    template,
  ]);

  const recheck = useCallback(async (): Promise<boolean> => {
    const pending = pendingUpdateRef.current;
    if (busy || !template || status !== 'unresolvedWriteOutcome' || !pending) return false;
    const createId = pendingCreateIdRef.current;
    // A network failure does not reveal the server-generated identity. Matching
    // by name alone would risk claiming another concurrent creation as ours.
    if (creating && !createId) return false;

    const requestId = ++requestIdRef.current;
    setBusy(true);

    let stored: CustomTeamTemplateV1 | null = null;
    let advancedRecord: CustomTeamTemplateV1 | null = null;
    try {
      const result = await api.customTeamTemplates.listTemplates();
      if (requestId !== requestIdRef.current) return false;
      if (result.status === 'ready' || result.status === 'hasUnreadableRecords') {
        const candidate = result.templates.find(
          (entry) => entry.templateId === (creating ? createId : template.templateId)
        );
        if (
          candidate &&
          (creating
            ? matchesPendingCreate(candidate, pending.fields)
            : matchesPendingUpdate(candidate, pending))
        ) {
          stored = candidate;
        } else if (
          !creating &&
          candidate &&
          resolveTemplateRevision(candidate) > pending.expectedRevision
        ) {
          // The old expected revision can no longer be written. Preserve the
          // user's draft and offer the regular explicit conflict choices.
          advancedRecord = candidate;
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

    if (requestId !== requestIdRef.current) return false;
    if (advancedRecord) {
      pendingUpdateRef.current = null;
      setRevisionConflict(advancedRecord);
      setStatus('revisionConflict');
      return false;
    }
    if (!stored) return false;

    pendingUpdateRef.current = null;
    pendingCreateIdRef.current = null;
    setStatus('saved');
    setExpectedRevision(resolveTemplateRevision(stored));
    onSaved?.(stored);
    return true;
  }, [busy, creating, onSaved, status, template]);

  const canSave = !busy && name.trim().length > 0 && status !== 'unresolvedWriteOutcome';
  const canRecheck =
    !busy &&
    status === 'unresolvedWriteOutcome' &&
    pendingUpdateRef.current !== null &&
    (!creating || pendingCreateIdRef.current !== null);

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
    replaceMembers,
    save,
    recheck,
    reset,
    acceptRevisionConflict,
    overwriteRevisionConflict,
  };
}
