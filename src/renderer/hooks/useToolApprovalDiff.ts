import { useEffect, useRef, useState } from 'react';

import { createTeamToolApprovalDiffFileReadTransport } from '@renderer/composition/team/createTeamToolApprovalDiffFileReadTransport';

import type { ToolApprovalFileContent } from '@shared/types';

// =============================================================================
// Types
// =============================================================================

export interface ToolApprovalDiffData {
  /** Whether this tool type supports diff preview */
  hasDiff: boolean;
  /** Loading state (file read in progress) */
  loading: boolean;
  /** Error message */
  error: string | null;
  /** File name for syntax highlighting */
  fileName: string;
  /** Original file content */
  oldString: string;
  /** New file content after tool execution */
  newString: string;
  /** File doesn't exist yet */
  isNewFile: boolean;
  /** File content was truncated at size limit */
  truncated: boolean;
  /** File is binary */
  isBinary: boolean;
}

const DIFF_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

const INITIAL_STATE: ToolApprovalDiffData = {
  hasDiff: false,
  loading: false,
  error: null,
  fileName: '',
  oldString: '',
  newString: '',
  isNewFile: false,
  truncated: false,
  isBinary: false,
};

const toolApprovalDiffFileReadTransport = createTeamToolApprovalDiffFileReadTransport();

interface ScopedToolApprovalDiffData extends ToolApprovalDiffData {
  approvalIdentity: string;
}

// =============================================================================
// Helpers
// =============================================================================

function getFilePath(toolInput: Record<string, unknown>): string {
  const fp = toolInput.file_path ?? toolInput.notebook_path;
  return typeof fp === 'string' ? fp : '';
}

function toPublicDiffData(state: ScopedToolApprovalDiffData): ToolApprovalDiffData {
  return {
    hasDiff: state.hasDiff,
    loading: state.loading,
    error: state.error,
    fileName: state.fileName,
    oldString: state.oldString,
    newString: state.newString,
    isNewFile: state.isNewFile,
    truncated: state.truncated,
    isBinary: state.isBinary,
  };
}

function computeEditResult(
  currentContent: string,
  toolInput: Record<string, unknown>
): { newString: string; error: string | null } {
  const oldStr = typeof toolInput.old_string === 'string' ? toolInput.old_string : '';
  const newStr = typeof toolInput.new_string === 'string' ? toolInput.new_string : '';
  const replaceAll = toolInput.replace_all === true;

  if (!oldStr) {
    return { newString: currentContent, error: 'Edit: old_string is empty' };
  }

  if (!currentContent.includes(oldStr)) {
    return { newString: currentContent, error: 'Fragment not found in current file' };
  }

  const result = replaceAll
    ? currentContent.replaceAll(oldStr, newStr)
    : currentContent.replace(oldStr, newStr);

  return { newString: result, error: null };
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Lazy-loading hook that reads file content from disk and computes diff data
 * for Write/Edit/NotebookEdit tool approvals.
 *
 * @param toolName  - The tool requesting approval
 * @param toolInput - The tool's input parameters
 * @param teamName  - Team that owns the active approval
 * @param runId     - Run that owns the active approval
 * @param requestId - Unique approval request ID (used for cancellation)
 * @param enabled   - Only fetch when true (lazy — user expanded the diff section)
 */
export function useToolApprovalDiff(
  toolName: string,
  toolInput: Record<string, unknown>,
  teamName: string,
  runId: string,
  requestId: string,
  enabled: boolean
): ToolApprovalDiffData {
  const hasDiff = DIFF_TOOLS.has(toolName);
  const filePath = getFilePath(toolInput);
  const approvalIdentity = JSON.stringify([teamName, runId, requestId, toolName, filePath]);
  const [state, setState] = useState<ScopedToolApprovalDiffData>(() => ({
    ...INITIAL_STATE,
    approvalIdentity,
  }));
  const activeRef = useRef<object | null>(null);

  useEffect(() => {
    // Reset when approval changes
    setState({ ...INITIAL_STATE, approvalIdentity });
    activeRef.current = null;
  }, [approvalIdentity]);

  useEffect(() => {
    if (!hasDiff || !enabled || !filePath) return;

    // NotebookEdit: no file read needed, just show new_source
    if (toolName === 'NotebookEdit') {
      const newSource = typeof toolInput.new_source === 'string' ? toolInput.new_source : '';
      setState({
        approvalIdentity,
        hasDiff: true,
        loading: false,
        error: null,
        fileName: filePath,
        oldString: '',
        newString: newSource,
        isNewFile: false,
        truncated: false,
        isBinary: false,
      });
      return;
    }

    // Write / Edit: need to read current file from disk
    const requestToken = {};
    activeRef.current = requestToken;

    setState((prev) => ({
      ...(prev.approvalIdentity === approvalIdentity ? prev : INITIAL_STATE),
      approvalIdentity,
      hasDiff: true,
      loading: true,
      error: null,
    }));

    void (async () => {
      let result: ToolApprovalFileContent;
      try {
        result = await toolApprovalDiffFileReadTransport.readFile({
          teamName,
          runId,
          requestId,
          filePath,
        });
      } catch (err) {
        if (activeRef.current !== requestToken) return;
        setState((prev) => ({
          ...(prev.approvalIdentity === approvalIdentity ? prev : INITIAL_STATE),
          approvalIdentity,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        }));
        return;
      }

      if (activeRef.current !== requestToken) return;

      if (result.error) {
        setState((prev) => ({
          ...(prev.approvalIdentity === approvalIdentity ? prev : INITIAL_STATE),
          approvalIdentity,
          loading: false,
          error: result.error ?? 'Unknown read error',
          fileName: filePath,
        }));
        return;
      }

      if (result.isBinary) {
        setState((prev) => ({
          ...(prev.approvalIdentity === approvalIdentity ? prev : INITIAL_STATE),
          approvalIdentity,
          loading: false,
          isBinary: true,
          fileName: filePath,
        }));
        return;
      }

      const isNewFile = !result.exists;
      const currentContent = result.content;

      if (toolName === 'Write') {
        const newContent = typeof toolInput.content === 'string' ? toolInput.content : '';
        setState({
          approvalIdentity,
          hasDiff: true,
          loading: false,
          error: null,
          fileName: filePath,
          oldString: currentContent,
          newString: newContent,
          isNewFile,
          truncated: result.truncated,
          isBinary: false,
        });
      } else if (toolName === 'Edit') {
        const { newString, error } = computeEditResult(currentContent, toolInput);
        setState({
          approvalIdentity,
          hasDiff: true,
          loading: false,
          error,
          fileName: filePath,
          oldString: currentContent,
          newString,
          isNewFile: false,
          truncated: result.truncated,
          isBinary: false,
        });
      }
    })();

    return () => {
      activeRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- toolInput is fresh; approval identity and extracted path are stable dependencies
  }, [approvalIdentity, enabled, filePath, hasDiff, requestId, runId, teamName, toolName]);

  if (!hasDiff) return INITIAL_STATE;
  if (state.approvalIdentity !== approvalIdentity) {
    return { ...INITIAL_STATE, hasDiff: true };
  }

  return { ...toPublicDiffData(state), hasDiff: true };
}
