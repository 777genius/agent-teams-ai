/**
 * Browser-mode stubs for the Review API.
 *
 * Extracted from `httpClient.ts`: review tooling relies on local git access,
 * which is unavailable when the renderer runs in a regular browser.
 */

import type {
  ReviewAPI,
  SnippetDiff,
  TaskChangeRequestOptions,
  TeamTaskChangeSummariesResponse,
  TeamTaskChangeSummaryRequest,
} from '@shared/types';

export function createBrowserReviewApi(): ReviewAPI {
  return {
    getAgentChanges: async (_teamName: string, _memberName: string): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    getTaskChanges: async (
      _teamName: string,
      _taskId: string,
      _options?: TaskChangeRequestOptions
    ): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    getTeamTaskChangeSummaries: async (
      _teamName: string,
      _requests: TeamTaskChangeSummaryRequest[]
    ): Promise<TeamTaskChangeSummariesResponse> => {
      throw new Error('Review is not available in browser mode');
    },
    invalidateTaskChangeSummaries: async (): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    getChangeStats: async (_teamName: string, _memberName: string): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    getFileContent: async (
      _teamName: string,
      _memberName: string | undefined,
      _filePath: string,
      _snippets: SnippetDiff[] = []
    ): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    applyDecisions: async (): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    executeMutation: async (): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    retryMutationRecovery: async (): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    restoreHistory: async (): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    // Phase 2 stubs
    checkConflict: async (): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    rejectHunks: async (): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    rejectFile: async (): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    previewReject: async (): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    // Editable diff stubs
    saveEditedFile: async (): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    deleteEditedFile: async (): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    restoreRejectedRename: async (): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    reapplyRejectedRename: async (): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    watchFiles: async (): Promise<never> => {
      throw new Error('Review file watching is not available in browser mode');
    },
    unwatchFiles: async (): Promise<never> => {
      throw new Error('Review file watching is not available in browser mode');
    },
    onExternalFileChange: (): (() => void) => {
      return () => {};
    },
    // Decision persistence stubs
    loadDecisions: async (): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    saveDecisions: async (
      _teamName: string,
      _scopeKey: string,
      _scopeToken: string,
      _hunkDecisions: Record<string, unknown>,
      _fileDecisions: Record<string, unknown>,
      _hunkContextHashesByFile?: Record<string, Record<number, string>>
    ): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    clearDecisions: async (): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    loadDecisionConflictCandidates: async (): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    resolveDecisionConflictCandidate: async (): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    loadDraftHistory: async (): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    saveDraftHistoryEntry: async (): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    clearDraftHistory: async (): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    loadDraftHistoryConflictCandidates: async (): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    resolveDraftHistoryConflictCandidate: async (): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    replaceDraftHistoryConflictCandidate: async (): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
    // Phase 4 stubs
    getGitFileLog: async (): Promise<never> => {
      throw new Error('Review is not available in browser mode');
    },
  };
}
