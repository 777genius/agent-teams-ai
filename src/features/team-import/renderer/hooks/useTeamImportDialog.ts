import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@renderer/api';

import type { TeamImportPreview } from '@features/team-import/contracts';

interface UseTeamImportDialogInput {
  open: boolean;
  onClose: () => void;
  onImported: (teamName: string) => void;
  inspectErrorFallback: string;
  createErrorFallback: string;
  resolveValidationError?: (code: string) => string | null;
}

function resolveRequestError(
  error: unknown,
  fallback: string,
  resolveValidationError?: (code: string) => string | null
): string {
  if (!(error instanceof Error)) return fallback;
  const validationPrefix = 'TEAM_IMPORT_VALIDATION:';
  const validationIndex = error.message.indexOf(validationPrefix);
  if (validationIndex === -1) return error.message;
  const code = error.message
    .slice(validationIndex + validationPrefix.length)
    .split(/[^A-Za-z0-9]/, 1)[0];
  return resolveValidationError?.(code) ?? fallback;
}

export function useTeamImportDialog(input: UseTeamImportDialogInput) {
  const [preview, setPreview] = useState<TeamImportPreview | null>(null);
  const [teamName, setTeamName] = useState('');
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const importingRef = useRef(false);

  useEffect(() => {
    requestIdRef.current += 1;
    importingRef.current = false;
    setPreview(null);
    setTeamName('');
    setLoading(false);
    setImporting(false);
    setError(null);
  }, [input.open]);

  const chooseFolder = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setPreview(null);
    setTeamName('');
    setLoading(true);
    setError(null);
    try {
      const nextPreview = await api.teamImport.chooseFolderAndPreview();
      if (requestId !== requestIdRef.current) return;
      setPreview(nextPreview);
      setTeamName(nextPreview?.suggestedTeamName ?? '');
    } catch (nextError) {
      if (requestId !== requestIdRef.current) return;
      setError(
        resolveRequestError(nextError, input.inspectErrorFallback, input.resolveValidationError)
      );
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [input.inspectErrorFallback, input.resolveValidationError]);

  const createDraft = useCallback(async () => {
    if (!preview || preview.blockingErrors.length > 0 || importingRef.current) return;
    importingRef.current = true;
    setImporting(true);
    setError(null);
    try {
      const result = await api.teamImport.createDraft({
        reviewId: preview.reviewId,
        teamName,
      });
      input.onImported(result.teamName);
      input.onClose();
    } catch (nextError) {
      setError(
        resolveRequestError(nextError, input.createErrorFallback, input.resolveValidationError)
      );
    } finally {
      importingRef.current = false;
      setImporting(false);
    }
  }, [input, preview, teamName]);

  return {
    preview,
    teamName,
    setTeamName,
    loading,
    importing,
    error,
    chooseFolder,
    createDraft,
  };
}
