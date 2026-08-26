export function createChildProcessTerminalReconciler(input: {
  reconcile(code: number | null): Promise<void> | void;
  onReconciliationFailure(error: unknown, childError?: Error): void;
}): (code: number | null, childError?: Error) => Promise<void> {
  let settlement: Promise<void> | null = null;
  return (code, childError) => {
    settlement ??= Promise.resolve()
      .then(() => input.reconcile(code))
      .catch((error: unknown) => input.onReconciliationFailure(error, childError));
    return settlement;
  };
}
