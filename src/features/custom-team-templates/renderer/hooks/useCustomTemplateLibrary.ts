import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@renderer/api';

import type {
  CustomTeamTemplateUnreadableRecord,
  CustomTeamTemplateV1,
} from '@features/custom-team-templates/contracts';

/**
 * Presentation state of the read-only template library.
 *
 * A valid empty library (`empty`), a partially unreadable one (`partial`), an
 * unreachable store (`storageUnavailable`) and a failed request
 * (`requestFailed`) are four different answers and are never collapsed into
 * one another — in particular a transport failure is never reported as an
 * empty library.
 */
export type TemplateLibraryState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'empty' }
  | {
      status: 'recoveryRequired' | 'recoveryInterrupted';
      storageDirectory: string;
      markerPath: string;
      interruptedMarkerPath: string;
      markerWriteFailed?: true;
    }
  | {
      status: 'storageVerificationRequired' | 'storageSafetyUnavailable';
      storageDirectory: string;
      databasePath: string;
    }
  | { status: 'ready'; templates: readonly CustomTeamTemplateV1[] }
  | {
      status: 'partial';
      templates: readonly CustomTeamTemplateV1[];
      unreadableRecords: readonly CustomTeamTemplateUnreadableRecord[];
    }
  | { status: 'storageUnavailable' }
  | { status: 'requestFailed' };

/**
 * Loads the template library whenever the dialog opens.
 *
 * The dialog never keeps a stale list as its truth: every open re-reads the
 * persisted library, so a save confirmed in another dialog is already visible
 * the next time the library is opened.
 */
export function useCustomTemplateLibrary(open: boolean): {
  state: TemplateLibraryState;
  /** Distinguishes a complete read from an incomplete snapshot or a failure. */
  reload: () => Promise<'complete' | 'partial' | 'failed'>;
} {
  const [state, setState] = useState<TemplateLibraryState>({ status: 'idle' });
  const requestIdRef = useRef(0);

  const reload = useCallback(async (): Promise<'complete' | 'partial' | 'failed'> => {
    const requestId = ++requestIdRef.current;
    setState({ status: 'loading' });
    try {
      const result = await api.customTeamTemplates.listTemplates();
      if (requestId !== requestIdRef.current) return 'failed';
      switch (result.status) {
        case 'empty':
          setState({ status: 'empty' });
          return 'complete';
        case 'recoveryRequired':
        case 'recoveryInterrupted':
        case 'storageVerificationRequired':
        case 'storageSafetyUnavailable':
          setState(result);
          return 'failed';
        case 'ready':
          setState({ status: 'ready', templates: result.templates });
          return 'complete';
        case 'hasUnreadableRecords':
          setState({
            status: 'partial',
            templates: result.templates,
            unreadableRecords: result.unreadableRecords,
          });
          return 'partial';
        case 'storageUnavailable':
          setState({ status: 'storageUnavailable' });
          return 'failed';
      }
    } catch {
      if (requestId !== requestIdRef.current) return 'failed';
      setState({ status: 'requestFailed' });
      return 'failed';
    }
  }, []);

  useEffect(() => {
    if (!open) {
      // Invalidate any in-flight read so a late response cannot overwrite
      // newer state after the dialog closes.
      requestIdRef.current += 1;
      return;
    }
    requestIdRef.current += 1;
    void reload();
  }, [open, reload]);

  return { state, reload };
}
