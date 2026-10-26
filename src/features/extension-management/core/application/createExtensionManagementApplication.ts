import type {
  ExtensionContext,
  ManagementEnvironment,
  ManagementOperation,
  ManagementPlan,
} from '../../contracts';
import type { ExtensionRuntimeGate, MutationLease } from './ExtensionRuntimeGate';
import type {
  CapturedExtensionEnvironment,
  ExtensionContextResolver,
  ExtensionManagementFeature,
} from './ports';

type Connection = Awaited<ReturnType<CapturedExtensionEnvironment['connect']>>;
interface ContextRecord {
  captured: CapturedExtensionEnvironment;
  public: ExtensionContext;
  connection: Connection;
  epoch: number;
  inspected: boolean;
  reconnecting?: Promise<void>;
  plans: Map<string, ManagementPlan>;
  localRestorePlans: Set<string>;
  admission: EnvironmentAdmission;
  observing: Set<string>;
}
interface EnvironmentAdmission {
  revision: number;
  accepted: Map<string, ManagementOperation>;
  lease?: MutationLease;
  resources: Set<string>;
  accepting: number;
  recovering: Set<string>;
  uncertainRequests: Map<string, { plan: ManagementPlan; contextId: string }>;
}
interface ConnectionUse {
  client: Connection['client'];
  isCurrent(): boolean;
  assertCurrent(): void;
}

function terminal(operation: ManagementOperation): boolean {
  return ['succeeded', 'partial', 'failed', 'canceled', 'interrupted'].includes(operation.state);
}

async function retainPreparedPlan(
  value: ContextRecord,
  plan: ManagementPlan,
  current: ConnectionUse
): Promise<void> {
  try {
    current.assertCurrent();
    await value.captured.assertInactive(plan);
    current.assertCurrent();
  } catch (error) {
    try {
      await current.client.plans.discard(plan.planId);
    } catch {
      // Preserve the admission refusal if cleanup of this unaccepted review fails.
    }
    throw error;
  }
  value.plans.set(plan.planId, plan);
}

/** Captures host authority once; navigation only changes which context is displayed. */
export function createExtensionManagementApplication(
  resolver: ExtensionContextResolver,
  gate: ExtensionRuntimeGate,
  nextContextId: () => string,
  isDefinitiveRefusal: (error: unknown) => boolean
): ExtensionManagementFeature {
  const contexts = new Map<string, ContextRecord>();
  const opening = new Map<string, Promise<ContextRecord>>();
  const environments = new Map<string, EnvironmentAdmission>();
  let closed = false;

  const currentConnection = (value: ContextRecord): ConnectionUse => {
    const { connection, epoch } = value;
    const isCurrent = () =>
      !closed && value.connection === connection && value.epoch === epoch && !connection.hasExited;
    return {
      client: connection.client,
      isCurrent,
      assertCurrent() {
        if (closed) throw new Error('Extension management is closing.');
        if (!isCurrent())
          throw new Error(
            'This extension connection has expired. Refresh and review a fresh plan.'
          );
      },
    };
  };
  const record = async (contextId: string): Promise<ContextRecord> => {
    if (closed) throw new Error('Extension management is closing.');
    const value = contexts.get(contextId);
    if (!value) throw new Error('This extension context has expired. Reopen Extensions.');
    await ensureConnection(value);
    return value;
  };
  const read = async <T>(
    value: ContextRecord,
    request: (client: Connection['client']) => Promise<T>
  ) => {
    const current = currentConnection(value);
    current.assertCurrent();
    const result = await request(current.client);
    current.assertCurrent();
    return result;
  };
  const observe = (value: ContextRecord, operation: ManagementOperation): ManagementOperation => {
    const previous = value.admission.accepted.get(operation.requestId);
    if (
      !previous ||
      previous.state !== operation.state ||
      previous.resolvedBy !== operation.resolvedBy ||
      value.admission.uncertainRequests.has(operation.requestId)
    )
      value.admission.revision += 1;
    value.admission.accepted.set(operation.requestId, operation);
    value.admission.uncertainRequests.delete(operation.requestId);
    return operation;
  };
  const follow = (value: ContextRecord, operation: ManagementOperation) => {
    if (terminal(operation) || value.observing.has(operation.operationId)) return;
    const current = currentConnection(value);
    if (!current.isCurrent()) return;
    value.observing.add(operation.operationId);
    void current.client
      .wait(operation.operationId)
      .then(async (completed) => {
        current.assertCurrent();
        observe(value, completed);
        await inspect(value);
      })
      .catch(() => {
        /* Uncertain effects keep their admission fence until fresh inspection. */
      })
      .finally(() => {
        if (current.isCurrent()) value.observing.delete(operation.operationId);
      });
  };
  const reconcile = (value: ContextRecord, environment: ManagementEnvironment) => {
    const pending = environment.pendingOperations ?? [];
    const admission = value.admission;
    if (pending.length) {
      const resources = [...admission.resources];
      if (admission.lease) admission.lease.extend(resources);
      else admission.lease = gate.restoreMutation(resources);
      for (const operation of pending) {
        observe(value, operation);
        follow(value, operation);
      }
    }
    if (admission.recovering.delete(value.public.contextId)) admission.revision += 1;
    value.inspected = true;
    if (
      !pending.length &&
      !admission.accepting &&
      !admission.uncertainRequests.size &&
      !admission.recovering.size
    ) {
      admission.lease?.release();
      admission.lease = undefined;
    }
    const uncertainApplications = [...admission.uncertainRequests.entries()].map(
      ([requestId, retained]) => ({ ...retained, requestId })
    );
    return { ...environment, uncertainApplications };
  };
  const inspect = async (value: ContextRecord) => {
    const current = currentConnection(value);
    current.assertCurrent();
    const revision = value.admission.revision;
    const environment = await current.client.environment();
    current.assertCurrent();
    if (revision !== value.admission.revision)
      throw new Error('Extension work changed during inspection. Refresh and try again.');
    if (
      environment.contextId !== value.public.session.contextId ||
      environment.pendingOperations?.some(
        (operation) => operation.environmentId !== value.public.session.environmentId
      )
    )
      throw new Error('The extension environment no longer matches this captured context.');
    return reconcile(value, environment);
  };
  const ensureConnection = async (value: ContextRecord): Promise<void> => {
    if (closed) throw new Error('Extension management is closing.');
    if (value.reconnecting) return value.reconnecting;
    if (!value.connection.hasExited && value.inspected) return;
    const reconnecting = (async () => {
      if (value.connection.hasExited) {
        value.epoch += 1;
        value.admission.revision += 1;
        value.inspected = false;
        value.admission.recovering.add(value.public.contextId);
        value.plans.clear();
        value.localRestorePlans.clear();
        value.observing.clear();
        const resources = [...value.admission.resources];
        if (value.admission.lease) value.admission.lease.extend(resources);
        else value.admission.lease = gate.restoreMutation(resources);
        // Only confirmed child exit allows replacement. Transport failures do
        // not prove exit and must never cause us to stop a live owned engine.
        await value.connection.close();
        if (closed) throw new Error('Extension management is closing.');
        const connection = await value.captured.connect();
        try {
          if (closed) throw new Error('Extension management is closing.');
          const authority = (session: Connection['session']) =>
            JSON.stringify([
              session.apiVersion,
              session.engineVersion,
              session.contextId,
              session.environmentId,
              session.scope,
              session.targets,
              session.authoringRoots ?? [],
            ]);
          if (authority(connection.session) !== authority(value.public.session))
            throw new Error(
              'The replacement extension session does not match its captured authority.'
            );
          value.connection = connection;
        } catch (error) {
          await connection.close();
          throw error;
        }
      }
      // A replacement whose inspection failed stays unready. Retry this read
      // on the same live child, retaining the shared admission fence meanwhile.
      await inspect(value);
    })();
    value.reconnecting = reconnecting;
    try {
      await reconnecting;
    } finally {
      if (value.reconnecting === reconnecting) value.reconnecting = undefined;
    }
  };

  return {
    async hostStatus() {
      return { available: true };
    },
    async capture(raw) {
      if (closed) throw new Error('Extension management is closing.');
      const selection = raw;
      const captured = await resolver.capture(selection);
      if (closed) throw new Error('Extension management is closing.');
      const existing = [...contexts.values()].find(
        (value) => value.captured.identity === captured.identity
      );
      if (existing) {
        await ensureConnection(existing);
        currentConnection(existing).assertCurrent();
        return { ...existing.public, selection, label: captured.label };
      }
      const inFlight = opening.get(captured.identity);
      if (inFlight) return { ...(await inFlight).public, selection, label: captured.label };
      if (contexts.size + opening.size >= 16)
        throw new Error(
          'Too many extension environments are open. Restart the app after active changes finish.'
        );
      const promise = (async () => {
        const connection = await captured.connect();
        const contextId = nextContextId();
        const admission: EnvironmentAdmission = environments.get(
          connection.session.environmentId
        ) ?? {
          revision: 0,
          accepted: new Map(),
          accepting: 0,
          recovering: new Set(),
          uncertainRequests: new Map(),
          resources: new Set<string>(),
        };
        environments.set(connection.session.environmentId, admission);
        captured.resources.forEach((resource) => admission.resources.add(resource));
        const value: ContextRecord = {
          captured,
          connection,
          epoch: 0,
          inspected: false,
          plans: new Map(),
          localRestorePlans: new Set(),
          admission,
          observing: new Set(),
          public: {
            contextId,
            selection,
            label: captured.label,
            session: connection.session,
            ...(captured.unavailableTargets?.length
              ? { unavailableTargets: captured.unavailableTargets }
              : {}),
          },
        };
        try {
          await inspect(value);
          if (closed) throw new Error('Extension management is closing.');
          contexts.set(contextId, value);
          return value;
        } catch (error) {
          await connection.close();
          throw error;
        }
      })();
      opening.set(captured.identity, promise);
      try {
        return (await promise).public;
      } finally {
        opening.delete(captured.identity);
      }
    },
    async catalog(raw) {
      const input = raw;
      return read(await record(input.contextId), (client) => client.catalog(input.query));
    },
    async detail(raw) {
      const input = raw;
      return read(await record(input.contextId), (client) => client.catalogEntry(input.id));
    },
    async discoverSkills(raw) {
      const input = raw;
      return read(await record(input.contextId), (client) => client.discoverSkills(input.source));
    },
    async previewSkill(raw) {
      const input = raw;
      return read(await record(input.contextId), (client) =>
        client.skills.preview(input.catalogId, input.candidateId)
      );
    },
    async discardSkillCatalog(input) {
      await read(await record(input.contextId), (client) => client.skills.discard(input.catalogId));
    },
    async environment(raw) {
      const input = raw,
        value = await record(input.contextId);
      return inspect(value);
    },
    async localSkillStatus(input) {
      const value = await record(input.contextId);
      const current = currentConnection(value);
      await value.captured.assertCurrent();
      current.assertCurrent();
      if (!value.captured.locateLocalSkill)
        throw new Error('Local Skill authoring is unavailable.');
      const local = await value.captured.locateLocalSkill(input.skillPath);
      current.assertCurrent();
      const environment = await inspect(value);
      current.assertCurrent();
      for (const entry of environment.entries) {
        for (const binding of entry.bindings) {
          for (const candidate of binding.managedPaths) {
            const overlaps = await local.overlapsManagedPath(candidate);
            current.assertCurrent();
            if (overlaps) {
              return {
                ownership: 'managed',
                rootId: local.rootId,
                skillName: local.skillName,
                alias: entry.alias,
              };
            }
          }
        }
      }
      // Display information only. Go repeats the ownership check under its mutation lock.
      return { ownership: 'local', rootId: local.rootId, skillName: local.skillName };
    },
    async prepareLocalSkill(input) {
      const value = await record(input.contextId);
      const current = currentConnection(value);
      await value.captured.assertCurrent();
      current.assertCurrent();
      const plan = await current.client.skills.local.prepare(input.change);
      await retainPreparedPlan(value, plan, current);
      current.assertCurrent();
      if (input.change.action === 'restore') value.localRestorePlans.add(plan.planId);
      return plan;
    },
    async skillCopySources(input) {
      const value = await record(input.contextId);
      const current = currentConnection(value);
      await value.captured.assertCurrent();
      current.assertCurrent();
      if (!value.captured.skillCopySources) throw new Error('Local Skill copying is unavailable.');
      const environment = await inspect(value);
      current.assertCurrent();
      const entry = environment.entries.find((item) => item.alias === input.alias);
      const binding = entry?.bindings.find((item) => item.targetId === input.targetId);
      if (!binding || binding.status === 'outside_context')
        throw new Error('This installation is outside the captured agent profile.');
      const candidates = await value.captured.skillCopySources(binding.managedPaths);
      current.assertCurrent();
      if (!candidates.length)
        throw new Error(
          'This installation has no available materialized Skill directory to copy. Repair it first if its files are missing.'
        );
      return candidates;
    },
    async previewSkillCopy(input) {
      const value = await record(input.contextId);
      const current = currentConnection(value);
      await value.captured.assertCurrent();
      current.assertCurrent();
      if (!value.captured.prepareSkillCopy) throw new Error('Local Skill copying is unavailable.');
      const environment = await inspect(value);
      current.assertCurrent();
      const binding = environment.entries
        .find((item) => item.alias === input.alias)
        ?.bindings.find((item) => item.targetId === input.targetId);
      if (!binding || binding.status === 'outside_context')
        throw new Error('This installation is outside the captured agent profile.');
      const prepared = await value.captured.prepareSkillCopy(binding.managedPaths, input);
      current.assertCurrent();
      const plan = await current.client.skills.local.prepare(prepared.change);
      if (!plan.confirmable) {
        await current.client.plans.discard(plan.planId);
        current.assertCurrent();
        throw new Error(
          plan.conflicts.map((item) => item.message).join('\n') ||
            'The copy destination is unavailable.'
        );
      }
      await retainPreparedPlan(value, plan, current);
      current.assertCurrent();
      return {
        ...prepared.preview,
        planId: plan.planId,
        warnings: [...prepared.preview.warnings, ...plan.warnings.map((item) => item.message)],
      };
    },
    async prepare(raw) {
      const input = raw,
        value = await record(input.contextId);
      const current = currentConnection(value);
      await value.captured.assertCurrent();
      current.assertCurrent();
      let change = input.change;
      if (input.catalogEntryId) {
        if (change.action !== 'install' || change.source)
          throw new Error('Choose a catalog entry or a source URL.');
        const entry = await current.client.catalogEntry(input.catalogEntryId);
        current.assertCurrent();
        if (!entry.available)
          throw new Error(entry.reason || 'This catalog entry cannot be installed.');
        change = { ...change, source: entry.source };
      }
      const plan = await current.client.prepare(change);
      await retainPreparedPlan(value, plan, current);
      current.assertCurrent();
      return plan;
    },
    async discardPlan(input) {
      const value = await record(input.contextId);
      const current = currentConnection(value);
      if (
        [...value.admission.uncertainRequests.values()].some(
          (item) => item.plan.planId === input.planId
        )
      )
        throw new Error(
          'Confirm the result of this request before closing its review. Retry with the same request identity.'
        );
      await read(value, (client) => client.plans.discard(input.planId));
      current.assertCurrent();
      value.plans.delete(input.planId);
      value.localRestorePlans.delete(input.planId);
    },
    async apply(raw) {
      const input = raw,
        value = await record(input.contextId);
      const current = currentConnection(value);
      current.assertCurrent();
      const previous = value.admission.accepted.get(input.requestId);
      if (previous) {
        if (previous.planId !== input.planId)
          throw new Error('This request already belongs to another prepared change.');
        const observed = await current.client.operation(previous.operationId);
        current.assertCurrent();
        const operation = observe(value, observed);
        if (terminal(operation)) await inspect(value);
        current.assertCurrent();
        return operation;
      }
      const uncertainPlan = value.admission.uncertainRequests.get(input.requestId);
      if (uncertainPlan && uncertainPlan.plan.planId !== input.planId)
        throw new Error('This request already belongs to another prepared change.');
      // Uncertain metadata only authorizes replay of that exact request. It is
      // never restored to the replacement engine's prepared-plan inventory.
      const plan = value.plans.get(input.planId) ?? uncertainPlan?.plan;
      const action = plan?.action;
      // A plan not prepared in this host session can only be a retry of durable
      // accepted work: the new Go session cannot possess that retained handle.
      if (!plan) {
        const operation = await current.client.apply(input.planId, input.requestId);
        current.assertCurrent();
        return observe(value, operation);
      }
      await value.captured.assertCurrent();
      current.assertCurrent();
      if (
        value.admission.lease &&
        action !== 'recover' &&
        !value.localRestorePlans.has(input.planId) &&
        !uncertainPlan
      )
        throw new Error('Resolve the outstanding extension operation before another change.');
      value.admission.accepting += 1;
      value.admission.revision += 1;
      let accepting = true;
      let attempted = false;
      const finishAcceptance = () => {
        if (accepting) {
          value.admission.accepting -= 1;
          value.admission.revision += 1;
          accepting = false;
        }
      };
      try {
        const resources = value.captured.resourcesForPlan
          ? value.captured.resourcesForPlan(plan)
          : value.captured.resources;
        // Concurrent contexts, reconciliation and close must see the same lease
        // throughout asynchronous activity validation.
        if (!value.admission.lease) value.admission.lease = gate.reserveMutation(resources);
        else value.admission.lease.extend(resources, true);
        await value.captured.assertInactive(plan);
        current.assertCurrent();
        value.admission.uncertainRequests.set(input.requestId, {
          plan,
          contextId: value.public.contextId,
        });
        attempted = true;
        const accepted = await current.client.apply(input.planId, input.requestId);
        finishAcceptance();
        current.assertCurrent();
        const operation = observe(value, accepted);
        follow(value, operation);
        if (terminal(operation)) await inspect(value);
        current.assertCurrent();
        return operation;
      } catch (error) {
        finishAcceptance();
        // An old child's reply cannot overwrite the replacement's inspection,
        // including a late definitive refusal or acceptance of the same IDs.
        current.assertCurrent();
        if (!attempted) {
          await inspect(value).catch(() => null);
          throw error;
        }
        const definitive = isDefinitiveRefusal(error);
        if (definitive) value.admission.uncertainRequests.delete(input.requestId);
        else
          value.admission.uncertainRequests.set(input.requestId, {
            plan,
            contextId: value.public.contextId,
          });
        // An error may follow durable acceptance. Inspect instead of releasing
        // the fence or silently submitting a replacement request identity.
        const environment = await inspect(value).catch(() => null);
        current.assertCurrent();
        const accepted = environment?.pendingOperations?.find(
          (item) => item.requestId === input.requestId
        );
        if (accepted) {
          observe(value, accepted);
          follow(value, accepted);
          return accepted;
        }
        // Empty inspection cannot prove that a lost acceptance reply had no
        // durable effect. Only the same request's observed result resolves it.
        throw error;
      } finally {
        finishAcceptance();
      }
    },
    async operation(raw) {
      const input = raw,
        value = await record(input.contextId);
      const current = currentConnection(value);
      current.assertCurrent();
      const observed = await current.client.operation(input.operationId);
      current.assertCurrent();
      const operation = observe(value, observed);
      follow(value, operation);
      if (terminal(operation)) await inspect(value);
      current.assertCurrent();
      return operation;
    },
    async cancel(raw) {
      const input = raw,
        value = await record(input.contextId);
      const current = currentConnection(value);
      current.assertCurrent();
      const observed = await current.client.cancel(input.operationId);
      current.assertCurrent();
      const operation = observe(value, observed);
      follow(value, operation);
      if (terminal(operation)) await inspect(value);
      current.assertCurrent();
      return operation;
    },
    async close() {
      closed = true;
      await Promise.allSettled([...opening.values()]);
      await Promise.allSettled([...contexts.values()].map((value) => value.reconnecting));
      await Promise.allSettled([...contexts.values()].map((value) => value.connection.close()));
      contexts.clear();
      for (const admission of environments.values()) admission.lease?.release();
      environments.clear();
    },
  };
}
