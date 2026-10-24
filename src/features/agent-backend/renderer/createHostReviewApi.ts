import { isHostTeamSelectionKey } from '../contracts/teamSelection';

import { createBoundHostReviewApi } from './createBoundHostReviewApi';

import type { AgentBackendApi } from '../contracts/operations';
import type { ReviewOriginScope } from '@agent-teams/task-change-ledger/review-transport';
import type { ReviewAPI } from '@shared/types/api';

function row(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
/** Team-bearing calls carry their own origin; path-only calls must use an explicitly bound view API. */
export function createHostReviewApi(
  legacy: ReviewAPI,
  backend: AgentBackendApi,
  captureScope: () => () => boolean
): ReviewAPI {
  return new Proxy(
    { ...legacy },
    {
      get(_target, method) {
        const original: unknown = Reflect.get(legacy, method);
        if (typeof original !== 'function') return original;
        return (...args: unknown[]) => {
          const request = row(args[0]);
          const suppliedScope = row(request?.scope) ?? request;
          const selection = typeof args[0] === 'string' ? args[0] : suppliedScope?.teamName;
          if (!isHostTeamSelectionKey(selection)) return Reflect.apply(original, legacy, args);
          const origin: ReviewOriginScope = {};
          if (typeof suppliedScope?.taskId === 'string') origin.taskId = suppliedScope.taskId;
          if (typeof suppliedScope?.memberName === 'string')
            origin.memberName = suppliedScope.memberName;
          if (method === 'getTaskChanges' && typeof args[1] === 'string') origin.taskId = args[1];
          if (
            (method === 'getAgentChanges' ||
              method === 'getChangeStats' ||
              method === 'getFileContent') &&
            typeof args[1] === 'string'
          )
            origin.memberName = args[1];
          if (
            typeof args[1] === 'string' &&
            method.toString().match(/Decisions|DraftHistory|DecisionConflict/)
          ) {
            if (args[1].startsWith('task-')) origin.taskId = args[1].slice(5);
            else if (args[1].startsWith('agent-')) origin.memberName = args[1].slice(6);
          }
          if (method === 'getFileContent')
            throw new Error('Host file content requires its originating review scope');
          const captured = createBoundHostReviewApi(
            legacy,
            backend,
            selection,
            origin,
            captureScope
          );
          const action: unknown = Reflect.get(captured, method);
          if (typeof action !== 'function') throw new Error('Host review operation unavailable');
          return Reflect.apply(action, captured, args);
        };
      },
    }
  );
}
