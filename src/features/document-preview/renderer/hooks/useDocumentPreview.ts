import { useEffect, useState } from 'react';

import { api } from '@renderer/api';

import type { DocumentPreviewResult } from '../../contracts';

export function useDocumentPreview(filePath: string) {
  const [state, setState] = useState<{
    filePath: string;
    document?: DocumentPreviewResult;
    error?: string;
  }>({ filePath });
  useEffect(() => {
    const controller = new AbortController();
    void api.editor.readDocumentPreview(filePath).then(
      (document) => {
        if (!controller.signal.aborted) setState({ filePath, document });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ filePath, error: String(error) });
      }
    );
    // IPC is bounded in main. Aborting locally drops late results after tab switches.
    return () => controller.abort();
  }, [filePath]);
  return state.filePath === filePath ? state : { filePath };
}
