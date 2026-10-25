import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';

import type {
  ExtensionClient,
  ExtensionContext,
  ManagementCatalog,
  ManagementChange,
  ManagementEntry,
  ManagementEnvironment,
  ManagementOperation,
  ManagementPlan,
  SkillCandidates,
  SkillCopyCandidate,
  SkillPreview,
} from '../../contracts';
import type { SkillImportRequest } from '@shared/types/extensions';

const finished = (operation: ManagementOperation) =>
  ['succeeded', 'partial', 'failed', 'canceled', 'interrupted'].includes(operation.state);
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Extension request failed.';

export function useManagedExtensions(kind: 'plugin' | 'skill') {
  const backend = useMemo(() => api.extensionManagement, []);
  const [client, setClient] = useState<ExtensionClient>('claude');
  const [captureRevision, setCaptureRevision] = useState(0);
  const [context, setContext] = useState<ExtensionContext | null>(null);
  const [catalog, setCatalog] = useState<ManagementCatalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [environment, setEnvironment] = useState<ManagementEnvironment | null>(null);
  const [plan, setPlan] = useState<ManagementPlan | null>(null);
  const [operation, setOperation] = useState<ManagementOperation | null>(null);
  const [candidates, setCandidates] = useState<SkillCandidates | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState<SkillPreview | null>(null);
  const [entryDetail, setEntryDetail] = useState<ManagementEntry | null>(null);
  const [copyCandidates, setCopyCandidates] = useState<SkillCopyCandidate[] | null>(null);
  const generation = useRef(0);
  const discoveryGeneration = useRef(0);
  const discovery = useRef<{ contextId: string; catalogId: string } | null>(null);
  const releaseDiscovery = useCallback(async () => {
    const retained = discovery.current;
    if (!backend || !retained) return;
    await backend.discardSkillCatalog(retained);
    if (discovery.current === retained) discovery.current = null;
  }, [backend]);
  const acceptance = useRef<{ contextId: string; planId: string; requestId: string } | null>(null);
  const applying = useRef(false);
  const reviewIntent = useRef<{
    contextId: string;
    planId: string;
    change: ManagementChange;
    catalogEntryId?: string;
  } | null>(null);
  const copyOwner = useRef<{ contextId: string; alias: string; targetId: string } | null>(null);
  const copyReview = useRef<{
    contextId: string;
    planId: string;
    requestId: string;
    rootKind: string;
    folderName: string;
    attempted: boolean;
  } | null>(null);
  const operationId = operation?.operationId;
  const isRunning = Boolean(operation && !finished(operation));

  const refresh = useCallback(
    async (selected: ExtensionContext, version: number) => {
      if (!backend) return;
      setCatalogLoading(true);
      setCatalogError(null);
      void backend
        .catalog({ contextId: selected.contextId })
        .then(
          (available) => {
            if (version === generation.current) setCatalog(available);
          },
          (failure: unknown) => {
            if (version === generation.current) setCatalogError(message(failure));
          }
        )
        .finally(() => {
          if (version === generation.current) setCatalogLoading(false);
        });
      const [observed] = await Promise.allSettled([
        backend.environment({ contextId: selected.contextId }),
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
          if (!observed.value.pendingOperations?.length && copyReview.current?.attempted)
            copyReview.current = null;
        }
      } else setError(message(observed.reason));
    },
    [backend]
  );

  useEffect(() => {
    const version = ++generation.current;
    discoveryGeneration.current += 1;
    void releaseDiscovery().catch(() => {});
    const previousCopy = copyReview.current;
    if (backend && previousCopy && !previousCopy.attempted)
      void backend
        .discardPlan({ contextId: previousCopy.contextId, planId: previousCopy.planId })
        .catch(() => {});
    copyReview.current = null;
    copyOwner.current = null;
    setContext(null);
    setCatalog(null);
    setCatalogLoading(false);
    setCatalogError(null);
    setEnvironment(null);
    setPlan(null);
    setCandidates(null);
    setPreview(null);
    setEntryDetail(null);
    setCopyCandidates(null);
    setOperation(null);
    setError(null);
    setBusy(Boolean(backend));
    acceptance.current = null;
    reviewIntent.current = null;
    if (!backend) return;
    void backend
      .hostStatus()
      .then((status) => {
        if (!status.available)
          throw new Error(status.reason || 'Extension management is unavailable in this host.');
        return backend.capture({ client, scope: 'user' });
      })
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
      discoveryGeneration.current += 1;
      void releaseDiscovery().catch(() => {});
    };
  }, [backend, client, captureRevision, refresh, releaseDiscovery]);

  useEffect(
    () => () => {
      const retained = copyReview.current;
      if (backend && retained && !retained.attempted)
        void backend
          .discardPlan({ contextId: retained.contextId, planId: retained.planId })
          .catch(() => {});
    },
    [backend]
  );

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
    let observationError: string | null = null;
    const version = generation.current;
    const poll = async () => {
      try {
        const observed = await backend.operation({ contextId: context.contextId, operationId });
        if (stopped || version !== generation.current) return;
        if (observationError) {
          const recovered = observationError;
          setError((current) => (current === recovered ? null : current));
          observationError = null;
        }
        setOperation(observed);
        if (finished(observed)) await refresh(context, version);
        else
          timer = setTimeout(() => {
            void poll();
          }, 750);
      } catch (failure) {
        if (!stopped && version === generation.current) {
          observationError = message(failure);
          setError(observationError);
          timer = setTimeout(() => {
            void poll();
          }, 750);
        }
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
      if (version !== generation.current) return false;
      apply(result);
      return true;
    } catch (failure) {
      if (version === generation.current) setError(message(failure));
      return false;
    } finally {
      if (version === generation.current) setBusy(false);
    }
  }
  async function prepare(change: ManagementChange, catalogEntryId?: string) {
    if (!backend || !context) return false;
    acceptance.current = null;
    const scopedChange = ['install', 'install_skills', 'remove'].includes(change.action)
      ? { ...change, targetIds: [client] }
      : change;
    return request(
      () => backend.prepare({ contextId: context.contextId, change: scopedChange, catalogEntryId }),
      (reviewed) => {
        reviewIntent.current = {
          contextId: context.contextId,
          planId: reviewed.planId,
          change: scopedChange,
          ...(catalogEntryId ? { catalogEntryId } : {}),
        };
        setPlan(reviewed);
      }
    );
  }
  async function attestExternalUninstall() {
    const intent = reviewIntent.current;
    if (
      !context ||
      !plan ||
      !intent ||
      acceptance.current ||
      intent.contextId !== context.contextId ||
      intent.planId !== plan.planId ||
      !plan.conflicts.some((item) => item.code === 'EXTERNAL_UNINSTALL_REQUIRED')
    )
      return;
    await prepare({ ...intent.change, externalUninstalled: true }, intent.catalogEntryId);
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
        reviewIntent.current = null;
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
      () => {
        reviewIntent.current = null;
        setPlan(null);
      }
    );
  }
  async function discover(source: string, ref?: string) {
    if (!backend || !context) return;
    const version = generation.current;
    const attempt = ++discoveryGeneration.current;
    const contextId = context.contextId;
    setCandidates(null);
    setPreview(null);
    await request(async () => {
      await releaseDiscovery();
      if (version !== generation.current || attempt !== discoveryGeneration.current) return null;
      const catalog = await backend.discoverSkills({
        contextId,
        source: { source, ...(ref ? { ref } : {}) },
      });
      const retained = { contextId, catalogId: catalog.catalogId };
      if (version !== generation.current || attempt !== discoveryGeneration.current) {
        await backend.discardSkillCatalog(retained);
        return null;
      }
      discovery.current = retained;
      return catalog;
    }, setCandidates);
  }
  async function closeDiscovery() {
    const version = generation.current;
    discoveryGeneration.current += 1;
    setCandidates(null);
    setPreview(null);
    try {
      await releaseDiscovery();
    } catch (failure) {
      if (version === generation.current) setError(message(failure));
    }
  }
  async function previewSkill(candidateId: string) {
    if (!backend || !context || !candidates) return;
    const attempt = discoveryGeneration.current;
    await request(
      () =>
        backend.previewSkill({
          contextId: context.contextId,
          catalogId: candidates.catalogId,
          candidateId,
        }),
      (value) => {
        if (attempt === discoveryGeneration.current) setPreview(value);
      }
    );
  }
  async function cancel() {
    if (!backend || !context || !operation) return;
    const version = generation.current;
    await request(
      () => backend.cancel({ contextId: context.contextId, operationId: operation.operationId }),
      (result) => {
        setOperation(result);
        if (finished(result)) void refresh(context, version);
      }
    );
  }
  async function restoreLocal(rootId: string, skillName: string, operationId: string) {
    if (!backend || !context) return;
    acceptance.current = null;
    reviewIntent.current = null;
    await request(
      async () => {
        const captured = await backend.capture({ client, scope: 'user', authoringRootId: rootId });
        const reviewed = await backend.prepareLocalSkill({
          contextId: captured.contextId,
          change: { action: 'restore', rootId, skillName, restoreOperationId: operationId },
        });
        return { captured, reviewed };
      },
      ({ captured, reviewed }) => {
        setContext(captured);
        setPlan(reviewed);
      }
    );
  }
  async function recover() {
    if (!operation) return;
    if (operation.action === 'local_skill') {
      if (!operation.localSkill) {
        setError(
          'This local operation has no restoration identity. Inspect its details before continuing.'
        );
        return;
      }
      await restoreLocal(
        operation.localSkill.rootId,
        operation.localSkill.skillName,
        operation.operationId
      );
    } else await prepare({ action: 'recover', operationId: operation.operationId });
  }
  async function showDetail(id: string) {
    if (!backend || !context) return;
    await request(() => backend.detail({ contextId: context.contextId, id }), setEntryDetail);
  }
  async function loadCopySources(alias: string) {
    if (!backend || !context) return;
    copyOwner.current = { contextId: context.contextId, alias, targetId: client };
    await request(
      () => backend.skillCopySources({ contextId: context.contextId, alias, targetId: client }),
      setCopyCandidates
    );
  }
  async function closeCopyReview() {
    const retained = copyReview.current;
    if (!backend || !retained || retained.attempted) return;
    copyReview.current = null;
    await backend.discardPlan({ contextId: retained.contextId, planId: retained.planId });
  }
  async function previewCopy(candidateId: string, input: SkillImportRequest) {
    if (!backend || !copyOwner.current || input.scope !== 'user' || !input.folderName)
      throw new Error('Choose a local copy destination.');
    if (copyReview.current?.attempted)
      throw new Error('Inspect the previous copy result before preparing another copy.');
    await closeCopyReview();
    const owner = copyOwner.current;
    const preview = await backend.previewSkillCopy({
      ...owner,
      candidateId,
      rootKind: input.rootKind,
      folderName: input.folderName,
    });
    copyReview.current = {
      contextId: owner.contextId,
      planId: preview.planId,
      requestId: crypto.randomUUID(),
      rootKind: input.rootKind,
      folderName: input.folderName,
      attempted: false,
    };
    return preview;
  }
  async function applyCopy(input: SkillImportRequest): Promise<null> {
    const retained = copyReview.current;
    if (
      !backend ||
      !context ||
      !retained ||
      retained.planId !== input.reviewPlanId ||
      retained.rootKind !== input.rootKind ||
      retained.folderName !== input.folderName
    )
      throw new Error('Review this copy destination again before applying it.');
    retained.attempted = true;
    const accepted = {
      contextId: retained.contextId,
      planId: retained.planId,
      requestId: retained.requestId,
    };
    acceptance.current = accepted;
    applying.current = true;
    const version = generation.current;
    setBusy(true);
    setError(null);
    try {
      let result = await backend.apply(accepted);
      const deadline = Date.now() + 120_000;
      while (!finished(result)) {
        if (version !== generation.current || Date.now() >= deadline)
          throw new Error(
            'The copy is still running. Inspect its operation before making another change.'
          );
        setOperation(result);
        await new Promise((resolve) => setTimeout(resolve, 250));
        result = await backend.operation({
          contextId: retained.contextId,
          operationId: result.operationId,
        });
      }
      if (version === generation.current) setOperation(result);
      if (result.state !== 'succeeded')
        throw new Error(
          result.result?.message || `Copy ${result.state}. Inspect recovery before continuing.`
        );
      copyReview.current = null;
      return null;
    } catch (error) {
      if (version === generation.current) setError(message(error));
      throw error;
    } finally {
      applying.current = false;
      if (version === generation.current) {
        setBusy(false);
        await refresh(context, version);
      }
    }
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
    catalogLoading,
    catalogError,
    environment,
    plan,
    setPlan,
    closeReview,
    attestExternalUninstall,
    canAttestExternalUninstall: Boolean(
      plan && reviewIntent.current?.planId === plan.planId && !acceptance.current
    ),
    reviewUncertain: Boolean(acceptance.current && plan),
    operation,
    candidates,
    closeDiscovery,
    error,
    busy,
    isRunning,
    query,
    setQuery,
    preview,
    setPreview,
    previewSkill,
    entryDetail,
    setEntryDetail,
    showDetail,
    copyCandidates,
    setCopyCandidates,
    loadCopySources,
    previewCopy,
    applyCopy,
    closeCopyReview,
    restoreLocal,
    recover,
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
