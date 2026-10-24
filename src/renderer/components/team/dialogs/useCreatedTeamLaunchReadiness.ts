import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useStore } from '@renderer/store';
import {
  captureCreatedTeamDraft,
  createdTeamSelectionSignature,
} from '@shared/utils/createdTeamReadiness';

import { currentCreatedTeamReadiness } from './createdTeamLaunchReadiness';

import type { createProviderSubmissionFence } from './optionalProviderPreflight';
import type { ProviderPreparePlan } from './providerPreparePlans';
import type { ProvisioningProviderCheck } from './provisioningProviderChecks';
import type { TeamCreateRequest, TeamProvisioningPrepareContext } from '@shared/types/team';

/** Exact Create draft observation; reusable model caches never grant Create authority. */
export function useCreatedTeamLaunchReadiness(input: {
  open: boolean;
  request: TeamCreateRequest;
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
  const [, invalidateClock] = useState(0);
  const selectionSignature = createdTeamSelectionSignature(input.request);
  const preparationScope = JSON.stringify([
    input.open,
    input.fence.preparationId,
    sourceContext,
    selectionSignature,
  ]);
  const preparation = useRef({ scope: '', id: '' });
  if (preparation.current.scope !== preparationScope)
    preparation.current = { scope: preparationScope, id: crypto.randomUUID() };
  const preparationId = preparation.current.id;
  const draftSignature = JSON.stringify([
    input.open,
    sourceContext,
    preparationId,
    selectionSignature,
  ]);
  const latest = useRef(draftSignature);
  latest.current = draftSignature;
  const context = useMemo<TeamProvisioningPrepareContext>(
    () => ({
      kind: 'create',
      preparationId,
      draft: captureCreatedTeamDraft(input.request),
    }),
    [preparationId, input.request]
  );
  const scope = { open: input.open, preparationId, selectionSignature, draftSignature };
  const proof = currentCreatedTeamReadiness(scope, input.checks, Date.now());
  const observedHost = useRef({ sourceContext, required: false });
  if (observedHost.current.sourceContext !== sourceContext)
    observedHost.current = { sourceContext, required: false };
  if (
    input.checks.some(
      (check) => check.createdTeamDraftSignature === draftSignature && check.createdTeamReadiness
    )
  )
    observedHost.current.required = true;
  const expiry = proof?.expiresAt;
  useEffect(() => {
    if (expiry === undefined) return;
    const timer = setTimeout(
      () => invalidateClock((value) => value + 1),
      Math.min(2_147_483_647, Math.max(0, expiry - Date.now() + 1))
    );
    return () => clearTimeout(timer);
  }, [expiry]);
  const qualifyPlan = useCallback(
    (plan: ProviderPreparePlan): ProviderPreparePlan => ({
      ...plan,
      requestSignature: JSON.stringify([plan.requestSignature, draftSignature]),
    }),
    [draftSignature]
  );
  const fence = input.fence;
  const runPreflight = useCallback(
    async (...args: Parameters<typeof fence.runPreflight>) => {
      const captured = draftSignature;
      const result = await fence.runPreflight(...args);
      return {
        ...result,
        createdTeamReadiness: latest.current === captured ? result.createdTeamReadiness : undefined,
        createdTeamDraftSignature: captured,
      };
    },
    [draftSignature, fence]
  );
  return {
    context,
    draftSignature,
    qualifyPlan,
    runPreflight,
    get readiness() {
      return currentCreatedTeamReadiness(scope, input.checks, Date.now());
    },
    get blocksSubmission() {
      return (
        input.open &&
        observedHost.current.required &&
        !currentCreatedTeamReadiness(scope, input.checks, Date.now())
      );
    },
    permits(providerId: string, now: number): boolean {
      return (
        providerId === 'anthropic' && Boolean(currentCreatedTeamReadiness(scope, input.checks, now))
      );
    },
  };
}
