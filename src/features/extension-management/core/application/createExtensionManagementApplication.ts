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
  uncertainRequests: Map<string, { plan: ManagementPlan; contextId: string }>;
}

function terminal(operation: ManagementOperation): boolean {
  return ['succeeded', 'partial', 'failed', 'canceled', 'interrupted'].includes(operation.state);
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

  const record = (contextId: string): ContextRecord => {
    if (closed) throw new Error('Extension management is closing.');
    const value = contexts.get(contextId);
    if (!value) throw new Error('This extension context has expired. Reopen Extensions.');
    return value;
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
    value.observing.add(operation.operationId);
    void value.connection.client
      .wait(operation.operationId)
      .then(async (completed) => {
        observe(value, completed);
        await inspect(value);
      })
      .catch(() => {
        /* Uncertain effects keep their admission fence until fresh inspection. */
      })
      .finally(() => value.observing.delete(operation.operationId));
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
    } else if (!admission.accepting && !admission.uncertainRequests.size) {
      admission.lease?.release();
      admission.lease = undefined;
    }
    const uncertainApplications = [...admission.uncertainRequests.entries()].map(
      ([requestId, retained]) => ({ ...retained, requestId })
    );
    return { ...environment, uncertainApplications };
  };
  const inspect = async (value: ContextRecord) => {
    if (closed) throw new Error('Extension management is closing.');
    const revision = value.admission.revision;
    const environment = await value.connection.client.environment();
    if (closed) throw new Error('Extension management is closing.');
    if (revision !== value.admission.revision)
      throw new Error('Extension work changed during inspection. Refresh and try again.');
    return reconcile(value, environment);
  };

  return {
    async hostStatus() {
      return { available: true };
    },
    async capture(raw) {
      if (closed) throw new Error('Extension management is closing.');
      const selection = raw;
      const captured = await resolver.capture(selection);
      const existing = [...contexts.values()].find(
        (value) => value.captured.identity === captured.identity
      );
      if (existing) return { ...existing.public, selection, label: captured.label };
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
          uncertainRequests: new Map(),
          resources: new Set<string>(),
        };
        environments.set(connection.session.environmentId, admission);
        captured.resources.forEach((resource) => admission.resources.add(resource));
        const value: ContextRecord = {
          captured,
          connection,
          plans: new Map(),
          localRestorePlans: new Set(),
          admission,
          observing: new Set(),
          public: { contextId, selection, label: captured.label, session: connection.session },
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
      return record(input.contextId).connection.client.catalog(input.query);
    },
    async detail(raw) {
      const input = raw;
      return record(input.contextId).connection.client.catalogEntry(input.id);
    },
    async discoverSkills(raw) {
      const input = raw;
      return record(input.contextId).connection.client.discoverSkills(input.source);
    },
    async previewSkill(raw) {
      const input = raw;
      return record(input.contextId).connection.client.skills.preview(
        input.catalogId,
        input.candidateId
      );
    },
    async discardSkillCatalog(input) {
      await record(input.contextId).connection.client.skills.discard(input.catalogId);
    },
    async environment(raw) {
      const input = raw,
        value = record(input.contextId);
      return inspect(value);
    },
    async localSkillStatus(input) {
      const value = record(input.contextId);
      await value.captured.assertCurrent();
      if (!value.captured.locateLocalSkill)
        throw new Error('Local Skill authoring is unavailable.');
      const local = await value.captured.locateLocalSkill(input.skillPath);
      const environment = await inspect(value);
      for (const entry of environment.entries) {
        for (const binding of entry.bindings) {
          for (const candidate of binding.managedPaths) {
            if (await local.overlapsManagedPath(candidate)) {
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
      const value = record(input.contextId);
      await value.captured.assertCurrent();
      const plan = await value.connection.client.skills.local.prepare(input.change);
      await value.captured.assertInactive(plan);
      value.plans.set(plan.planId, plan);
      if (input.change.action === 'restore') value.localRestorePlans.add(plan.planId);
      return plan;
    },
    async skillCopySources(input) {
      const value = record(input.contextId);
      await value.captured.assertCurrent();
      if (!value.captured.skillCopySources) throw new Error('Local Skill copying is unavailable.');
      const environment = await inspect(value);
      const entry = environment.entries.find((item) => item.alias === input.alias);
      const binding = entry?.bindings.find((item) => item.targetId === input.targetId);
      if (!binding || binding.status === 'outside_context')
        throw new Error('This installation is outside the captured agent profile.');
      const candidates = await value.captured.skillCopySources(binding.managedPaths);
      if (!candidates.length)
        throw new Error(
          'This installation has no available materialized Skill directory to copy. Repair it first if its files are missing.'
        );
      return candidates;
    },
    async previewSkillCopy(input) {
      const value = record(input.contextId);
      await value.captured.assertCurrent();
      if (!value.captured.prepareSkillCopy) throw new Error('Local Skill copying is unavailable.');
      const environment = await inspect(value);
      const binding = environment.entries
        .find((item) => item.alias === input.alias)
        ?.bindings.find((item) => item.targetId === input.targetId);
      if (!binding || binding.status === 'outside_context')
        throw new Error('This installation is outside the captured agent profile.');
      const prepared = await value.captured.prepareSkillCopy(binding.managedPaths, input);
      const plan = await value.connection.client.skills.local.prepare(prepared.change);
      if (!plan.confirmable) {
        await value.connection.client.plans.discard(plan.planId);
        throw new Error(
          plan.conflicts.map((item) => item.message).join('\n') ||
            'The copy destination is unavailable.'
        );
      }
      await value.captured.assertInactive(plan);
      value.plans.set(plan.planId, plan);
      return {
        ...prepared.preview,
        planId: plan.planId,
        warnings: [...prepared.preview.warnings, ...plan.warnings.map((item) => item.message)],
      };
    },
    async prepare(raw) {
      const input = raw,
        value = record(input.contextId);
      await value.captured.assertCurrent();
      let change = input.change;
      if (input.catalogEntryId) {
        if (change.action !== 'install' || change.source)
          throw new Error('Choose a catalog entry or a source URL.');
        const entry = await value.connection.client.catalogEntry(input.catalogEntryId);
        if (!entry.available)
          throw new Error(entry.reason || 'This catalog entry cannot be installed.');
        change = { ...change, source: entry.source };
      }
      const plan = await value.connection.client.prepare(change);
      await value.captured.assertInactive(plan);
      value.plans.set(plan.planId, plan);
      return plan;
    },
    async discardPlan(input) {
      const value = record(input.contextId);
      if (
        [...value.admission.uncertainRequests.values()].some(
          (item) => item.plan.planId === input.planId
        )
      )
        throw new Error(
          'Confirm the result of this request before closing its review. Retry with the same request identity.'
        );
      await value.connection.client.plans.discard(input.planId);
      value.plans.delete(input.planId);
      value.localRestorePlans.delete(input.planId);
    },
    async apply(raw) {
      const input = raw,
        value = record(input.contextId);
      const previous = value.admission.accepted.get(input.requestId);
      if (previous) {
        if (previous.planId !== input.planId)
          throw new Error('This request already belongs to another prepared change.');
        const operation = observe(
          value,
          await value.connection.client.operation(previous.operationId)
        );
        if (terminal(operation)) await inspect(value);
        return operation;
      }
      const uncertainPlan = value.admission.uncertainRequests.get(input.requestId);
      if (uncertainPlan && uncertainPlan.plan.planId !== input.planId)
        throw new Error('This request already belongs to another prepared change.');
      const plan = value.plans.get(input.planId);
      const action = plan?.action;
      // A plan not prepared in this host session can only be a retry of durable
      // accepted work: the new Go session cannot possess that retained handle.
      if (!plan)
        return observe(value, await value.connection.client.apply(input.planId, input.requestId));
      await value.captured.assertCurrent();
      if (closed) throw new Error('Extension management is closing.');
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
        if (closed) throw new Error('Extension management is closing.');
        value.admission.uncertainRequests.set(input.requestId, {
          plan,
          contextId: value.public.contextId,
        });
        attempted = true;
        const accepted = await value.connection.client.apply(input.planId, input.requestId);
        finishAcceptance();
        const operation = observe(value, accepted);
        follow(value, operation);
        if (terminal(operation)) await inspect(value);
        return operation;
      } catch (error) {
        finishAcceptance();
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
        value = record(input.contextId);
      const operation = observe(value, await value.connection.client.operation(input.operationId));
      follow(value, operation);
      if (terminal(operation)) await inspect(value);
      return operation;
    },
    async cancel(raw) {
      const input = raw,
        value = record(input.contextId);
      const operation = observe(value, await value.connection.client.cancel(input.operationId));
      follow(value, operation);
      if (terminal(operation)) await inspect(value);
      return operation;
    },
    async close() {
      closed = true;
      await Promise.allSettled([...opening.values()]);
      await Promise.allSettled([...contexts.values()].map((value) => value.connection.close()));
      contexts.clear();
      for (const admission of environments.values()) admission.lease?.release();
      environments.clear();
    },
  };
}
