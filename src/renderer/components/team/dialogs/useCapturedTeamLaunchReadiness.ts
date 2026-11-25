import { useCallback, useEffect, useRef, useState } from 'react';

import { isHostTeamSelectionKey } from '@features/agent-backend/contracts';
import { useStore } from '@renderer/store';
import { capturedTeamSelectionSignature } from '@shared/utils/capturedTeamReadiness';

import { hasCapturedTeamLaunchReadiness } from './capturedTeamLaunchReadiness';

import type { createProviderSubmissionFence } from './optionalProviderPreflight';
import type { ProviderPreparePlan } from './providerPreparePlans';
import type { ProvisioningProviderCheck } from './provisioningProviderChecks';
import type { CapturedTeamModelPreparation, TeamLaunchRequest, TeamProvisioningModelCheckRequest } from '@shared/types';

/** Owns only the current dialog observation, never a model cache or provider auth status. */
export function useCapturedTeamLaunchReadiness(input: {
  sourceRevision?: string;
  open: boolean;
  teamName: string;
  preparationId: string;
  cwd: string;
  selectedModelChecks: readonly TeamProvisioningModelCheckRequest[];
  limitContext: boolean;
  draft: unknown;
  checks: readonly ProvisioningProviderCheck[];
  fence: ReturnType<typeof createProviderSubmissionFence>;
}) {
  const sourceContext = useStore((state) =>
    JSON.stringify([
      state.activeContextId,
      state.targetContextId,
      state.isContextSwitching,
      state.connectionMode,
      state.connectedHost,
      state.appConfig?.general?.claudeRootPath,
    ])
  );
  const sourceRevision = input.sourceRevision;
  const [, invalidateClock] = useState(0);
  const selectionSignature = capturedTeamSelectionSignature(input);
  const capturedTeam = isHostTeamSelectionKey(input.teamName);
  const draftSignature = capturedTeam
    ? JSON.stringify([
        input.open,
        input.teamName,
        input.preparationId,
        sourceContext,
        sourceRevision,
        selectionSignature,
        input.draft,
      ])
    : '';
  const scope = { ...input, selectionSignature, draftSignature };
  const latest = useRef(draftSignature);
  latest.current = draftSignature;
  useEffect(() => {
    latest.current = draftSignature;
    return () => {
      latest.current = '';
    };
  }, [draftSignature]);
  const expiry = Math.min(
    ...input.checks.flatMap((check) =>
      check.capturedTeamDraftSignature === draftSignature && check.capturedTeamReadiness
        ? [check.capturedTeamReadiness.expiresAt]
        : []
    )
  );
  useEffect(() => {
    if (!Number.isFinite(expiry) || expiry <= Date.now()) return;
    const timer = setTimeout(
      () => invalidateClock((value) => value + 1),
      Math.min(2_147_483_647, expiry - Date.now() + 1)
    );
    return () => clearTimeout(timer);
  }, [expiry]);
  const qualifyPlan = useCallback(
    (plan: ProviderPreparePlan): ProviderPreparePlan =>
      draftSignature
        ? { ...plan, requestSignature: JSON.stringify([plan.requestSignature, draftSignature]) }
        : plan,
    [draftSignature]
  );
  const fence = input.fence;
  const runPreflight = useCallback(
    async (...args: Parameters<typeof fence.runPreflight>) => {
      const captured = draftSignature;
      const current = () => {
        if (captured && latest.current !== captured)
          throw new Error('Captured Team draft changed.');
      };
      const [identity, request] = args;
      const result = await fence.runPreflight(identity, {
        ...request,
        prepareProvisioning: async (...values) => {
          current();
          const result = await request.prepareProvisioning(...values);
          current();
          return result;
        },
      });
      return {
        ...result,
        capturedTeamReadiness:
          latest.current === captured ? result.capturedTeamReadiness : undefined,
        capturedTeamDraftSignature: captured,
      };
    },
    [draftSignature, fence]
  );
  const permits = (providerId: string, now: number): boolean => Boolean(sourceRevision) &&
    hasCapturedTeamLaunchReadiness({
      ...scope,
      selectionSignature: capturedTeamSelectionSignature({
        cwd: input.cwd,
        limitContext: input.limitContext,
        selectedModelChecks: input.selectedModelChecks.filter(check => check.providerId === providerId),
      }),
    }, input.checks, providerId, now);
  return {
    draftSignature,
    qualifyPlan,
    runPreflight,
    permits,
    captureForSubmit(request: TeamLaunchRequest): TeamLaunchRequest {
      if (!capturedTeam || !input.selectedModelChecks.some(check => check.providerId === 'opencode'))
        return request;
      const now = Date.now();
      if (latest.current !== draftSignature || request.teamName !== input.teamName || !permits('opencode', now))
        throw new Error('The selected model check changed. Check the current selection before launching.');
      const selections: CapturedTeamModelPreparation['selections'] = [];
      const seen = new Set<string>();
      for (const check of input.checks) {
        if (!permits(check.providerId, now)) continue;
        const original = check.capturedTeamReadiness?.selections;
        if (!original?.length) {
          if (check.providerId === 'opencode') throw new Error('Check the selected model again before launching.');
          continue;
        }
        for (const selection of original) {
          const key = JSON.stringify(selection);
          if (!seen.has(key)) { seen.add(key); selections.push(structuredClone(selection)); }
        }
      }
      if (!selections.length || selections.length > 256)
        throw new Error('The original model check selections are unavailable.');
      return { ...request, modelPreparation: { preparationId: input.preparationId, selections } };
    },
  };
}
