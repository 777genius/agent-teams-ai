import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@renderer/api';

import type { TeamImportPreview } from '@features/team-import/contracts';

interface UseTeamImportDialogInput {
  open: boolean;
  onClose: () => void;
  onImported: (teamName: string) => void;
  inspectErrorFallback: string;
  createErrorFallback: string;
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
      setError(nextError instanceof Error ? nextError.message : input.inspectErrorFallback);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [input.inspectErrorFallback]);

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
      setError(nextError instanceof Error ? nextError.message : input.createErrorFallback);
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
