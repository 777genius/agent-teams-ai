import { useCallback, useEffect, useRef, useState } from 'react';

import { useStore } from '@renderer/store';
import { deduplicateEditorRead } from '@renderer/utils/editorReadRequest';

import type { ReadFileResult } from '@shared/types/editor';

interface EditorFileContentState {
  fileContent: ReadFileResult | null;
  fileLoading: boolean;
  fileError: string | null;
  loadFileContent: (filePath: string) => Promise<void>;
  setFileContent: (value: ReadFileResult | null) => void;
}

/** Owns read lifetime; stale tab/project results cannot replace the active document. */
export function useEditorFileContent(activeTabId: string | null, projectPath: string): EditorFileContentState {
  const [loaded, setLoaded] = useState<{ filePath: string; result: ReadFileResult } | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const pending = useRef(new Map<string, Promise<ReadFileResult>>());
  const sequence = useRef(0);
  const scope = useRef(projectPath);
  if (scope.current !== projectPath) {
    pending.current = new Map();
    scope.current = projectPath;
    sequence.current++;
  }
  const current = useRef(activeTabId);
  current.current = activeTabId;
  const loadFileContent = useCallback(async (filePath: string) => {
    const request = ++sequence.current;
    setLoaded(null);
    setFileLoading(true);
    setFileError(null);
    try {
      const result = await deduplicateEditorRead(pending.current, filePath,
        () => window.electronAPI.editor.readFile(filePath));
      if (request !== sequence.current || filePath !== current.current) return;
      setLoaded({ filePath, result });
      // A reread on tab return must not replace the original conflict baseline for dirty text.
      const state = useStore.getState();
      if (!state.editorModifiedFiles[filePath] && !state.editorSaving[filePath]) state.setFileMtime(filePath, result.mtimeMs);
    } catch (error) {
      if (request === sequence.current && filePath === current.current) {
        setFileError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (request === sequence.current) setFileLoading(false);
    }
  }, []);
  useEffect(() => {
    if (activeTabId) void loadFileContent(activeTabId);
    else {
      setLoaded(null);
      setFileLoading(false);
      setFileError(null);
    }
    const requestSequence = sequence;
    return () => { requestSequence.current++; };
  }, [activeTabId, projectPath, loadFileContent]);
  const setFileContent = useCallback((value: ReadFileResult | null) => {
    setLoaded(value && current.current ? { filePath: current.current, result: value } : null);
  }, []);
  return { fileContent: loaded && loaded.filePath === activeTabId ? loaded.result : null,
    fileLoading, fileError, loadFileContent, setFileContent };
}
