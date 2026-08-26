import { useEffect, useRef } from 'react';

interface DialogSubmissionGenerationInput {
  open: boolean;
  identity: string;
  roster: unknown;
  run: unknown;
}

interface DialogSubmissionGenerationFence {
  begin(): number;
  invalidate(): void;
  isCurrent(generation: number): boolean;
}

export function useDialogSubmissionGeneration({
  open,
  identity,
  roster,
  run,
}: DialogSubmissionGenerationInput): DialogSubmissionGenerationFence {
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
    };
  }, []);
  useEffect(() => {
    generationRef.current += 1;
  }, [identity, open, roster, run]);
  return {
    begin: () => generationRef.current,
    invalidate: () => {
      generationRef.current += 1;
    },
    isCurrent: (generation) => mountedRef.current && generationRef.current === generation,
  };
}
