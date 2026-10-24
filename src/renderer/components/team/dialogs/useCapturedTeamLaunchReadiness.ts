import { useCallback, useEffect, useRef, useState } from 'react';

import { isHostTeamSelectionKey } from '@features/agent-backend/contracts';
import { useStore } from '@renderer/store';
import { capturedTeamSelectionSignature } from '@shared/utils/capturedTeamReadiness';

import { hasCapturedTeamLaunchReadiness } from './capturedTeamLaunchReadiness';

import type { createProviderSubmissionFence } from './optionalProviderPreflight';
import type { ProviderPreparePlan } from './providerPreparePlans';
import type { ProvisioningProviderCheck } from './provisioningProviderChecks';
import type { TeamProvisioningModelCheckRequest } from '@shared/types';

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
      const result = await fence.runPreflight(...args);
      return {
        ...result,
        capturedTeamReadiness:
          latest.current === captured ? result.capturedTeamReadiness : undefined,
        capturedTeamDraftSignature: captured,
      };
    },
    [draftSignature, fence]
  );
  return {
    draftSignature,
    qualifyPlan,
    runPreflight,
    permits(providerId: string, now: number): boolean {
      return (
        Boolean(sourceRevision) &&
        hasCapturedTeamLaunchReadiness(
          {
            ...scope,
            selectionSignature: capturedTeamSelectionSignature({
              cwd: input.cwd,
              limitContext: input.limitContext,
              selectedModelChecks: input.selectedModelChecks.filter(
                (check) => check.providerId === providerId
              ),
            }),
          },
          input.checks,
          providerId,
          now
        )
      );
    },
  };
}
