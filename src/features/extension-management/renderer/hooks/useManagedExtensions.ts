import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';

import type {
  ExtensionClient,
  ExtensionContext,
  ManagementCatalog,
  ManagementChange,
  ManagementEnvironment,
  ManagementOperation,
  ManagementPlan,
  SkillCandidates,
  SkillPreview,
} from '../../contracts';

const finished = (operation: ManagementOperation) =>
  ['succeeded', 'partial', 'failed', 'cancelled', 'interrupted'].includes(operation.state);
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Extension request failed.';

export function useManagedExtensions(kind: 'plugin' | 'skill') {
  const backend = useMemo(() => api.extensionManagement, []);
  const [client, setClient] = useState<ExtensionClient>('claude');
  const [captureRevision, setCaptureRevision] = useState(0);
  const [context, setContext] = useState<ExtensionContext | null>(null);
  const [catalog, setCatalog] = useState<ManagementCatalog | null>(null);
  const [environment, setEnvironment] = useState<ManagementEnvironment | null>(null);
  const [plan, setPlan] = useState<ManagementPlan | null>(null);
  const [operation, setOperation] = useState<ManagementOperation | null>(null);
  const [candidates, setCandidates] = useState<SkillCandidates | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState<SkillPreview | null>(null);
  const generation = useRef(0);
  const acceptance = useRef<{ contextId: string; planId: string; requestId: string } | null>(null);
  const applying = useRef(false);
  const operationId = operation?.operationId;
  const isRunning = Boolean(operation && !finished(operation));

  const refresh = useCallback(
    async (selected: ExtensionContext, version: number) => {
      if (!backend) return;
      const [observed, available] = await Promise.allSettled([
        backend.environment({ contextId: selected.contextId }),
        backend.catalog({ contextId: selected.contextId }),
      ]);
      if (version !== generation.current) return;
      if (observed.status === 'fulfilled') {
        setEnvironment(observed.value);
        const pending = observed.value.pendingOperations?.[0];
        if (pending) setOperation(pending);
        const uncertain = observed.value.uncertainApplications?.[0];
        if (uncertain) {
          setPlan(uncertain.plan);
          acceptance.current = {
            contextId: uncertain.contextId,
            planId: uncertain.plan.planId,
            requestId: uncertain.requestId,
          };
        } else if (observed.value.uncertainApplications && !applying.current) {
          if (acceptance.current) setPlan(null);
          acceptance.current = null;
        }
      } else setError(message(observed.reason));
      if (available.status === 'fulfilled') setCatalog(available.value);
      else setError(message(available.reason));
    },
    [backend]
  );

  useEffect(() => {
    const version = ++generation.current;
    setContext(null);
    setCatalog(null);
    setEnvironment(null);
    setPlan(null);
    setCandidates(null);
    setPreview(null);
    setOperation(null);
    setError(null);
    setBusy(Boolean(backend));
    acceptance.current = null;
    if (!backend) return;
    void backend
      .capture({ client, scope: 'user' })
      .then(async (selected) => {
        if (version !== generation.current) return;
        setContext(selected);
        await refresh(selected, version);
      })
      .catch((failure: unknown) => {
        if (version === generation.current) setError(message(failure));
      })
      .finally(() => {
        if (version === generation.current) setBusy(false);
      });
    return () => {
      generation.current += 1;
    };
  }, [backend, client, captureRevision, refresh]);

  useEffect(() => {
    if (!backend || !context || !plan) return;
    const captured = { contextId: context.contextId, planId: plan.planId };
    return () => {
      if (acceptance.current?.planId === captured.planId) return;
      void backend.discardPlan(captured).catch(() => {});
    };
  }, [backend, context, plan]);

  useEffect(() => {
    if (!backend || !context || !operationId || !isRunning) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const version = generation.current;
    const poll = async () => {
      try {
        const observed = await backend.operation({ contextId: context.contextId, operationId });
        if (stopped || version !== generation.current) return;
        setOperation(observed);
        if (finished(observed)) await refresh(context, version);
        else
          timer = setTimeout(() => {
            void poll();
          }, 750);
      } catch (failure) {
        if (!stopped && version === generation.current) setError(message(failure));
      }
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [backend, context, operationId, isRunning, refresh]);

  async function request<T>(action: () => Promise<T>, apply: (value: T) => void): Promise<boolean> {
    const version = generation.current;
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (version === generation.current) apply(result);
      return true;
    } catch (failure) {
      if (version === generation.current) setError(message(failure));
      return false;
    } finally {
      if (version === generation.current) setBusy(false);
    }
  }
  async function prepare(change: ManagementChange, catalogEntryId?: string) {
    if (!backend || !context) return;
    acceptance.current = null;
    const scopedChange = ['install', 'install_skills', 'remove'].includes(change.action)
      ? { ...change, targetIds: [client] }
      : change;
    await request(
      () => backend.prepare({ contextId: context.contextId, change: scopedChange, catalogEntryId }),
      setPlan
    );
  }
  async function apply() {
    if (!backend || !context || !plan) return;
    const accepted =
      acceptance.current?.planId === plan.planId
        ? acceptance.current
        : { contextId: context.contextId, planId: plan.planId, requestId: crypto.randomUUID() };
    acceptance.current = accepted;
    applying.current = true;
    const version = generation.current;
    const succeeded = await request(
      () => backend.apply(accepted),
      (result) => {
        setOperation(result);
        setPlan(null);
        if (finished(result)) void refresh(context, version);
      }
    );
    applying.current = false;
    if (!succeeded) await refresh(context, version);
  }
  async function closeReview() {
    if (!backend || !context || !plan || acceptance.current) return;
    await request(
      () => backend.discardPlan({ contextId: context.contextId, planId: plan.planId }),
      () => setPlan(null)
    );
  }
  async function discover(source: string, ref?: string) {
    if (!backend || !context) return;
    await request(
      () =>
        backend.discoverSkills({
          contextId: context.contextId,
          source: { source, ...(ref ? { ref } : {}) },
        }),
      setCandidates
    );
  }
  async function previewSkill(candidateId: string) {
    if (!backend || !context || !candidates) return;
    await request(
      () =>
        backend.previewSkill({
          contextId: context.contextId,
          catalogId: candidates.catalogId,
          candidateId,
        }),
      setPreview
    );
  }
  async function cancel() {
    if (!backend || !context || !operation) return;
    await request(
      () => backend.cancel({ contextId: context.contextId, operationId: operation.operationId }),
      setOperation
    );
  }
  async function reload() {
    if (context)
      await request(
        () => refresh(context, generation.current),
        () => {}
      );
    else setCaptureRevision((current) => current + 1);
  }
  const needle = query.trim().toLowerCase();
  return {
    available: Boolean(backend),
    client,
    setClient,
    context,
    catalog,
    environment,
    plan,
    setPlan,
    closeReview,
    reviewUncertain: Boolean(acceptance.current && plan),
    operation,
    candidates,
    setCandidates,
    error,
    busy,
    isRunning,
    query,
    setQuery,
    preview,
    setPreview,
    previewSkill,
    prepare,
    apply,
    discover,
    cancel,
    reload,
    items: (catalog?.items ?? []).filter(
      (entry) =>
        entry.kind === kind &&
        (!needle || `${entry.name} ${entry.description}`.toLowerCase().includes(needle))
    ),
    installed: (environment?.entries ?? []).filter(
      (entry) =>
        entry.kind === kind &&
        (!entry.bindings.length || entry.bindings.some((binding) => binding.client === client)) &&
        (!needle || `${entry.alias} ${entry.source}`.toLowerCase().includes(needle))
    ),
  };
}
export type ManagedExtensionsModel = ReturnType<typeof useManagedExtensions>;
