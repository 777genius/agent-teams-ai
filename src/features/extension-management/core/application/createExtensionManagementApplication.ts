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
  admission: EnvironmentAdmission;
  observing: Set<string>;
}
interface EnvironmentAdmission {
  accepted: Map<string, ManagementOperation>;
  lease?: MutationLease;
  resources: Set<string>;
  accepting: number;
  uncertainRequests: Map<string, { plan: ManagementPlan; contextId: string }>;
}

function terminal(operation: ManagementOperation): boolean {
  return ['succeeded', 'partial', 'failed', 'cancelled', 'interrupted'].includes(operation.state);
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
  const inspect = async (value: ContextRecord) =>
    reconcile(value, await value.connection.client.environment());

  return {
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
    async environment(raw) {
      const input = raw,
        value = record(input.contextId);
      return inspect(value);
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
      if (value.admission.lease && action !== 'recover' && !uncertainPlan)
        throw new Error('Resolve the outstanding extension operation before another change.');
      if (!value.admission.lease)
        value.admission.lease = await gate.reserveMutation(
          plan && value.captured.resourcesForPlan
            ? value.captured.resourcesForPlan(plan)
            : value.captured.resources,
          () => value.captured.assertInactive(plan)
        );
      else await value.captured.assertInactive(plan);
      value.admission.uncertainRequests.set(input.requestId, {
        plan,
        contextId: value.public.contextId,
      });
      value.admission.accepting += 1;
      let accepting = true;
      const finishAcceptance = () => {
        if (accepting) {
          value.admission.accepting -= 1;
          accepting = false;
        }
      };
      try {
        const accepted = await value.connection.client.apply(input.planId, input.requestId);
        finishAcceptance();
        const operation = observe(value, accepted);
        follow(value, operation);
        if (terminal(operation)) await inspect(value);
        return operation;
      } catch (error) {
        finishAcceptance();
        const definitive = isDefinitiveRefusal(error);
        if (definitive) value.admission.uncertainRequests.delete(input.requestId);
        else
          value.admission.uncertainRequests.set(input.requestId, {
            plan,
            contextId: value.public.contextId,
          });
        // An error may follow durable acceptance. Inspect instead of releasing
        // the fence or silently submitting a replacement request identity.
        const environment = await value.connection.client.environment().catch(() => null);
        const accepted = environment?.pendingOperations?.find(
          (item) => item.requestId === input.requestId
        );
        if (accepted) {
          observe(value, accepted);
          follow(value, accepted);
          return accepted;
        }
        if (definitive && environment) await reconcile(value, environment);
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
