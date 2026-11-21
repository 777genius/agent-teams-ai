import { useCallback, useEffect, useRef, useState } from 'react';

import {
  type BuiltinTeamTemplateId,
  type CopyBuiltinTemplateResult,
  type CustomTeamTemplateV1,
  type DeleteCustomTeamTemplateResult,
  type DuplicateCustomTeamTemplateResult,
  resolveTemplateRevision,
} from '@features/custom-team-templates/contracts';
import { api } from '@renderer/api';

import {
  beginTemplateMutation,
  finishTemplateMutation,
  getPendingTemplateMutation,
  usePendingTemplateMutations,
  wasTemplateMutationResolved,
} from './pendingTemplateMutation';

import type { PendingTemplateMutation } from './pendingTemplateMutation';

export type TemplateManagementOperation = 'delete' | 'duplicate' | 'copyBuiltin' | null;
type ManagementResult<T> = T | { status: 'resolvedElsewhere' };

export interface UseTemplateManagementInput {
  onSuccess?: () => Promise<void> | void;
}

export interface UseTemplateManagementResult {
  busy: boolean;
  blockedByUnknown: boolean;
  resolvedElsewhere: boolean;
  activeOperation: TemplateManagementOperation;
  deleteTemplate: (
    target: CustomTeamTemplateV1 | { templateId: string; expectedRevision: number }
  ) => Promise<ManagementResult<DeleteCustomTeamTemplateResult>>;
  duplicateTemplate: (
    sourceTemplateId: string,
    name: string
  ) => Promise<ManagementResult<DuplicateCustomTeamTemplateResult>>;
  copyBuiltinTemplate: (
    builtinTemplateId: BuiltinTeamTemplateId,
    name: string
  ) => Promise<ManagementResult<CopyBuiltinTemplateResult>>;
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
  const inFlightRef = useRef(false);
  const { operations, storageAvailable } = usePendingTemplateMutations();
  const blockedByUnknown = operations.length > 0 || !storageAvailable;
  const [lastUnknown, setLastUnknown] = useState<PendingTemplateMutation | null>(null);
  const [resolvedElsewhere, setResolvedElsewhere] = useState(false);

  useEffect(() => {
    if (lastUnknown && wasTemplateMutationResolved(lastUnknown)) setResolvedElsewhere(true);
  }, [lastUnknown, operations, storageAvailable]);

  const deleteTemplate = useCallback(
    async (
      target: CustomTeamTemplateV1 | { templateId: string; expectedRevision: number }
    ): Promise<ManagementResult<DeleteCustomTeamTemplateResult>> => {
      if (inFlightRef.current) return { status: 'storageUnavailable' };
      if (getPendingTemplateMutation()) {
        return { status: 'unresolvedWriteOutcome', templateId: target.templateId };
      }
      const operation = beginTemplateMutation({ kind: 'delete', label: target.templateId });
      if (!operation) return { status: 'storageUnavailable' };
      setLastUnknown(null);
      setResolvedElsewhere(false);
      inFlightRef.current = true;
      setBusy(true);
      setActiveOperation('delete');

      try {
        const expectedRevision =
          'expectedRevision' in target ? target.expectedRevision : resolveTemplateRevision(target);
        const result = await api.customTeamTemplates.deleteTemplate({
          templateId: target.templateId,
          expectedRevision,
        });

        if (result.status === 'deleted') {
          await onSuccess?.();
        }

        if (result.status !== 'unresolvedWriteOutcome') finishTemplateMutation(operation);
        else if (wasTemplateMutationResolved(operation)) return { status: 'resolvedElsewhere' };
        else setLastUnknown(operation);

        return result;
      } catch {
        // A transport failure happens after the request may already have been
        // dispatched, so it can never prove the delete did not commit.
        if (wasTemplateMutationResolved(operation)) return { status: 'resolvedElsewhere' };
        setLastUnknown(operation);
        return { status: 'unresolvedWriteOutcome', templateId: target.templateId };
      } finally {
        inFlightRef.current = false;
        setBusy(false);
        setActiveOperation(null);
      }
    },
    [onSuccess]
  );

  const duplicateTemplate = useCallback(
    async (
      sourceTemplateId: string,
      name: string
    ): Promise<ManagementResult<DuplicateCustomTeamTemplateResult>> => {
      if (inFlightRef.current) return { status: 'storageUnavailable' };
      if (getPendingTemplateMutation()) {
        return { status: 'unresolvedWriteOutcome', templateId: '' };
      }
      const operation = beginTemplateMutation({ kind: 'duplicate', label: name });
      if (!operation) return { status: 'storageUnavailable' };
      setLastUnknown(null);
      setResolvedElsewhere(false);
      inFlightRef.current = true;
      setBusy(true);
      setActiveOperation('duplicate');

      try {
        const result = await api.customTeamTemplates.duplicateTemplate({
          sourceTemplateId,
          name,
        });

        if (result.status === 'duplicated') {
          await onSuccess?.();
        }

        if (result.status !== 'unresolvedWriteOutcome') finishTemplateMutation(operation);
        else if (wasTemplateMutationResolved(operation)) return { status: 'resolvedElsewhere' };
        else setLastUnknown(operation);

        return result;
      } catch {
        // The new id is assigned by the main process, so an interrupted
        // duplicate leaves the renderer without an id to reconcile against.
        // The outcome stays unknown instead of claiming nothing was written.
        if (wasTemplateMutationResolved(operation)) return { status: 'resolvedElsewhere' };
        setLastUnknown(operation);
        return { status: 'unresolvedWriteOutcome', templateId: '' };
      } finally {
        inFlightRef.current = false;
        setBusy(false);
        setActiveOperation(null);
      }
    },
    [onSuccess]
  );

  const copyBuiltinTemplate = useCallback(
    async (
      builtinTemplateId: BuiltinTeamTemplateId,
      name: string
    ): Promise<ManagementResult<CopyBuiltinTemplateResult>> => {
      if (inFlightRef.current) return { status: 'storageUnavailable' };
      if (getPendingTemplateMutation()) {
        return { status: 'unresolvedWriteOutcome', templateId: '' };
      }
      const operation = beginTemplateMutation({ kind: 'copyBuiltin', label: name });
      if (!operation) return { status: 'storageUnavailable' };
      setLastUnknown(null);
      setResolvedElsewhere(false);
      inFlightRef.current = true;
      setBusy(true);
      setActiveOperation('copyBuiltin');

      try {
        const result = await api.customTeamTemplates.copyBuiltinTemplate({
          builtinTemplateId,
          name,
        });

        if (result.status === 'copied') {
          await onSuccess?.();
        }

        if (result.status !== 'unresolvedWriteOutcome') finishTemplateMutation(operation);
        else if (wasTemplateMutationResolved(operation)) return { status: 'resolvedElsewhere' };
        else setLastUnknown(operation);

        return result;
      } catch {
        // Same as duplicate: the new id belongs to the main process, so a
        // failed response cannot prove the copy was not stored.
        if (wasTemplateMutationResolved(operation)) return { status: 'resolvedElsewhere' };
        setLastUnknown(operation);
        return { status: 'unresolvedWriteOutcome', templateId: '' };
      } finally {
        inFlightRef.current = false;
        setBusy(false);
        setActiveOperation(null);
      }
    },
    [onSuccess]
  );

  return {
    busy,
    blockedByUnknown,
    resolvedElsewhere,
    activeOperation,
    deleteTemplate,
    duplicateTemplate,
    copyBuiltinTemplate,
  };
}
