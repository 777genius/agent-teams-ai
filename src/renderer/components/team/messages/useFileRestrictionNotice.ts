import { useCallback, useEffect, useRef, useState } from 'react';

/** Original composer warning with one owned four-second dismiss timer. */
export function useFileRestrictionNotice(
  fallback: string,
  attachmentRestrictionReason: string | null | undefined,
  attachmentPayloadRestrictionReason: string | null | undefined
) {
  const [fileRestrictionError, setFileRestrictionError] = useState<string | null>(null);
  const timer = useRef(0);
  const showFileRestrictionError = useCallback(
    (reason?: string): void => {
      setFileRestrictionError(
        reason ?? attachmentRestrictionReason ?? attachmentPayloadRestrictionReason ?? fallback
      );
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setFileRestrictionError(null), 4000);
    },
    [attachmentRestrictionReason, attachmentPayloadRestrictionReason, fallback]
  );
  useEffect(() => {
    const ref = timer;
    return () => window.clearTimeout(ref.current);
  }, []);
  return { fileRestrictionError, setFileRestrictionError, showFileRestrictionError };
}
