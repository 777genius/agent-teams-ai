import { useCallback, useRef, useState } from 'react';

import {
  type BuiltinTeamTemplateId,
  type CopyBuiltinTemplateResult,
  type CustomTeamTemplateV1,
  type DeleteCustomTeamTemplateResult,
  type DuplicateCustomTeamTemplateResult,
  resolveTemplateRevision,
} from '@features/custom-team-templates/contracts';
import { api } from '@renderer/api';

export type TemplateManagementOperation = 'delete' | 'duplicate' | 'copyBuiltin' | null;

export interface UseTemplateManagementInput {
  onSuccess?: () => Promise<void> | void;
}

export interface UseTemplateManagementResult {
  busy: boolean;
  activeOperation: TemplateManagementOperation;
  deleteTemplate: (
    target: CustomTeamTemplateV1 | { templateId: string; expectedRevision: number }
  ) => Promise<DeleteCustomTeamTemplateResult>;
  duplicateTemplate: (
    sourceTemplateId: string,
    name: string
  ) => Promise<DuplicateCustomTeamTemplateResult>;
  copyBuiltinTemplate: (
    builtinTemplateId: BuiltinTeamTemplateId,
    name: string
  ) => Promise<CopyBuiltinTemplateResult>;
}

/**
 * Cohesive hook for custom template delete, duplicate, and copy-builtin operations.
 *
 * Guarantees single-flight mutations, prevents duplicate submissions, handles
 * transport failures gracefully, and triggers library refresh after confirmed
 * persistent success.
 */
export function useTemplateManagement({
  onSuccess,
}: UseTemplateManagementInput = {}): UseTemplateManagementResult {
  const [busy, setBusy] = useState(false);
  const [activeOperation, setActiveOperation] = useState<TemplateManagementOperation>(null);
  const requestIdRef = useRef(0);

  const deleteTemplate = useCallback(
    async (
      target: CustomTeamTemplateV1 | { templateId: string; expectedRevision: number }
    ): Promise<DeleteCustomTeamTemplateResult> => {
      const requestId = ++requestIdRef.current;
      setBusy(true);
      setActiveOperation('delete');

      try {
        const expectedRevision =
          'expectedRevision' in target ? target.expectedRevision : resolveTemplateRevision(target);
        const result = await api.customTeamTemplates.deleteTemplate({
          templateId: target.templateId,
          expectedRevision,
        });

        if (requestId !== requestIdRef.current) {
          return { status: 'storageUnavailable' };
        }

        if (result.status === 'deleted') {
          await onSuccess?.();
        }

        return result;
      } catch {
        // A transport failure happens after the request may already have been
        // dispatched, so it can never prove the delete did not commit.
        return { status: 'unresolvedWriteOutcome', templateId: target.templateId };
      } finally {
        if (requestId === requestIdRef.current) {
          setBusy(false);
          setActiveOperation(null);
        }
      }
    },
    [onSuccess]
  );

  const duplicateTemplate = useCallback(
    async (sourceTemplateId: string, name: string): Promise<DuplicateCustomTeamTemplateResult> => {
      const requestId = ++requestIdRef.current;
      setBusy(true);
      setActiveOperation('duplicate');

      try {
        const result = await api.customTeamTemplates.duplicateTemplate({
          sourceTemplateId,
          name,
        });

        if (requestId !== requestIdRef.current) {
          return { status: 'storageUnavailable' };
        }

        if (result.status === 'duplicated') {
          await onSuccess?.();
        }

        return result;
      } catch {
        // The new id is assigned by the main process, so an interrupted
        // duplicate leaves the renderer without an id to reconcile against.
        // The outcome stays unknown instead of claiming nothing was written.
        return { status: 'unresolvedWriteOutcome', templateId: '' };
      } finally {
        if (requestId === requestIdRef.current) {
          setBusy(false);
          setActiveOperation(null);
        }
      }
    },
    [onSuccess]
  );

  const copyBuiltinTemplate = useCallback(
    async (
      builtinTemplateId: BuiltinTeamTemplateId,
      name: string
    ): Promise<CopyBuiltinTemplateResult> => {
      const requestId = ++requestIdRef.current;
      setBusy(true);
      setActiveOperation('copyBuiltin');

      try {
        const result = await api.customTeamTemplates.copyBuiltinTemplate({
          builtinTemplateId,
          name,
        });

        if (requestId !== requestIdRef.current) {
          return { status: 'storageUnavailable' };
        }

        if (result.status === 'copied') {
          await onSuccess?.();
        }

        return result;
      } catch {
        // Same as duplicate: the new id belongs to the main process, so a
        // failed response cannot prove the copy was not stored.
        return { status: 'unresolvedWriteOutcome', templateId: '' };
      } finally {
        if (requestId === requestIdRef.current) {
          setBusy(false);
          setActiveOperation(null);
        }
      }
    },
    [onSuccess]
  );

  return {
    busy,
    activeOperation,
    deleteTemplate,
    duplicateTemplate,
    copyBuiltinTemplate,
  };
}
