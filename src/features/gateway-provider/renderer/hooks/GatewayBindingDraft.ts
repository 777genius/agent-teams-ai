import type { GatewayMemberBindingDto, GatewayUnbindMemberRequest } from '../../contracts';

type Binding = GatewayMemberBindingDto;
interface Context {
  teamName: string;
  memberNames: readonly string[];
  mode: 'roster' | 'addition';
}
const key = (binding: Pick<Binding, 'teamName' | 'memberName'>): string =>
  JSON.stringify([binding.teamName, binding.memberName]);

/** Own only bindings allocated by this form, never its pre-existing bindings. */
export function createGatewayBindingDraft(
  unbind: (request: GatewayUnbindMemberRequest) => Promise<void>,
  reportError: (error: unknown) => void
) {
  const initial = new Map<string, Set<string>>();
  const latest = new Map<string, readonly Binding[]>();
  const owned = new Map<string, Binding>();
  const generations = new WeakMap<Binding, number>();
  let generation = 0;
  const removing = new Map<string, Promise<void>>();
  let context: Context | null = null;
  let pendingOperations = 0;

  const remove = (binding: Binding): Promise<void> => {
    const id = key(binding);
    const receiptId = JSON.stringify([id, binding.gatewayUsageRef, binding.boundAt]);
    const active = removing.get(receiptId);
    if (active) return active;
    const operation = Promise.resolve()
      .then(() =>
        unbind({
          teamName: binding.teamName,
          memberName: binding.memberName,
          expectedBinding: { gatewayUsageRef: binding.gatewayUsageRef, boundAt: binding.boundAt },
        })
      )
      .then(() => {
        if (owned.get(id) === binding) owned.delete(id);
      })
      .catch(reportError)
      .finally(() => removing.delete(receiptId));
    removing.set(receiptId, operation);
    return operation;
  };
  const flush = async (): Promise<void> => {
    if (pendingOperations) return;
    await Promise.all(
      [...owned.values()]
        .filter(
          (binding) =>
            generations.get(binding) !== generation ||
            !context ||
            binding.teamName !== context.teamName ||
            !context.memberNames.includes(binding.memberName)
        )
        .map(remove)
    );
    if (!context && !pendingOperations && !owned.size) {
      initial.clear();
      latest.clear();
    }
  };
  const mark = (teamName: string, names: readonly string[], replaceRoster = false): void => {
    const baseline = initial.get(teamName);
    if (replaceRoster) {
      for (const binding of latest.get(teamName) ?? []) {
        if (baseline?.has(binding.memberName) && !names.includes(binding.memberName))
          owned.set(key(binding), binding);
      }
      initial.set(teamName, new Set(names));
    } else if (baseline) {
      for (const name of names) baseline.add(name);
    }
    for (const [id, binding] of owned) {
      if (binding.teamName === teamName && names.includes(binding.memberName)) owned.delete(id);
    }
  };
  const register = (binding: Binding, receiptGeneration = generation): void => {
    if (initial.has(binding.teamName) && !initial.get(binding.teamName)!.has(binding.memberName)) {
      owned.set(key(binding), binding);
      generations.set(binding, receiptGeneration);
      void flush();
    }
  };
  return {
    observe(teamName: string, bindings: readonly Binding[]): void {
      if (!initial.has(teamName))
        initial.set(teamName, new Set(bindings.map((binding) => binding.memberName)));
      latest.set(teamName, bindings);
    },
    register,
    update(next: Context | null): void {
      if (context && !next) generation++;
      context = next;
      void flush();
    },
    discard(): void {
      generation++;
      context = null;
      void flush();
    },
    markSaved: mark,
    async runBinding(operation: () => Promise<Binding>): Promise<Binding> {
      const receiptGeneration = generation;
      pendingOperations++;
      try {
        const binding = await operation();
        register(binding, receiptGeneration);
        return binding;
      } finally {
        pendingOperations--;
        await flush();
      }
    },
    async run<T>(operation: () => T | Promise<T>, confirmedNames?: readonly string[]): Promise<T> {
      const submission = context && { ...context, memberNames: [...context.memberNames] };
      pendingOperations++;
      try {
        const result = await operation();
        if (submission) {
          const saved = confirmedNames ?? submission.memberNames;
          mark(
            submission.teamName,
            saved,
            submission.mode === 'roster' && confirmedNames === undefined
          );
        }
        return result;
      } finally {
        pendingOperations--;
        await flush();
      }
    },
  };
}
