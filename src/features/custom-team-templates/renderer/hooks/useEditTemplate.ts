import { useCallback, useEffect, useRef, useState } from 'react';

import {
  type CustomTeamTemplateMemberV1,
  type CustomTeamTemplateV1,
  type CustomTeamTemplateValidationIssue,
  resolveTemplateRevision,
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
  | 'requestFailed';

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
  setName: (value: string) => void;
  setDescription: (value: string) => void;
  setTeamPrompt: (value: string) => void;
  addMember: (member?: Partial<CustomTeamTemplateMemberV1>) => void;
  updateMember: (index: number, patch: Partial<CustomTeamTemplateMemberV1>) => void;
  removeMember: (index: number) => void;
  save: () => Promise<boolean>;
  reset: () => void;
  acceptRevisionConflict: () => void;
  overwriteRevisionConflict: () => void;
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

  // Initialize draft when opened or when template selection changes
  useEffect(() => {
    if (!open || !template) {
      if (!open) {
        requestIdRef.current += 1;
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
    setExpectedRevision(resolveTemplateRevision(revisionConflict));
    setRevisionConflict(null);
    setStatus('idle');
    setIssues([]);
  }, [revisionConflict]);

  const save = useCallback(async (): Promise<boolean> => {
    if (busy || !template) return false;

    const requestId = ++requestIdRef.current;
    setBusy(true);
    setStatus('saving');
    setIssues([]);

    try {
      const result = await api.customTeamTemplates.updateTemplate({
        templateId: template.templateId,
        expectedRevision,
        fields: {
          name,
          description: description.trim() ? description : undefined,
          teamPrompt,
          members: members.map((m) => ({
            name: m.name,
            ...(m.role?.trim() ? { role: m.role.trim() } : {}),
            ...(m.workflow?.trim() ? { workflow: m.workflow.trim() } : {}),
          })),
        },
      });

      if (requestId !== requestIdRef.current) return false;

      switch (result.status) {
        case 'updated': {
          setStatus('saved');
          setExpectedRevision(resolveTemplateRevision(result.template));
          onSaved?.(result.template);
          return true;
        }
        case 'revisionConflict': {
          setStatus('revisionConflict');
          setRevisionConflict(result.current);
          return false;
        }
        case 'nameConflict': {
          setStatus('nameConflict');
          return false;
        }
        case 'validationFailed': {
          setStatus('idle');
          setIssues(result.issues);
          return false;
        }
        case 'notFound':
        case 'unreadableRecord':
        case 'storageUnavailable': {
          setStatus(result.status);
          return false;
        }
      }
    } catch {
      if (requestId !== requestIdRef.current) return false;
      setStatus('requestFailed');
      return false;
    } finally {
      if (requestId === requestIdRef.current) {
        setBusy(false);
      }
    }
  }, [busy, description, expectedRevision, members, name, onSaved, teamPrompt, template]);

  const canSave = !busy && name.trim().length > 0;

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
    setName,
    setDescription,
    setTeamPrompt,
    addMember,
    updateMember,
    removeMember,
    save,
    reset,
    acceptRevisionConflict,
    overwriteRevisionConflict,
  };
}
