import type {
  ProcessCommandReceipt,
  ProcessMetadataSelector,
  RegisteredProcessCapture,
  RegisteredProcessNative,
  RegistrarBinding,
  TeamProcessRow,
  TeamProcessView,
} from './registeredProcessContracts.js';
import {
  processReceiptFingerprint,
  processReceiptPhase,
  validateProcessReceipt,
} from './validateProcessRecords.js';

export interface RegisterInput {
  pid: number;
  label: string;
  port?: number;
  url?: string;
  command?: string;
}
export interface ProcessRegistryPolicy {
  readStrict(): TeamProcessRow[];
  register(input: RegisterInput & { from: string }): TeamProcessRow;
  attachOriginal(id: string, commandId: string, capture: RegisteredProcessCapture): TeamProcessRow;
  stopMetadata(selector: { id: string } | { pid: number }): TeamProcessRow;
  unregister(selector: { id: string } | { pid: number }): TeamProcessRow[];
}
/** Same Team store, authority fence and commands/ namespace as existing product receipts. */
export interface ProcessTeamOwnerContext {
  binding: ProcessCommandReceipt['binding'];
  principalId: string;
  store: {
    fenced<T>(action: () => T): T;
    read<T>(path: string): T | undefined;
    write(path: string, value: unknown): void;
    list<T>(path: string): T[];
  };
  authorize(action: 'read' | 'process.write' | 'admin'): { revision: number; memberName: string };
  /** Authenticated original MCP connection resolves exact current member delivery, never input.from. */
  registrar(): RegistrarBinding;
  native?: RegisteredProcessNative;
  registry: ProcessRegistryPolicy;
  digest(value: unknown): string;
  assertCurrent(): void;
  reserved(commandId: string): boolean;
  /** Existing listTeamCommandEntries, including all-family validation; never a second journal. */
  commandEntries(): readonly unknown[];
  invalidate(): void;
}
const refuse = (code: 'hold' | 'conflict' | 'forbidden' | 'invalid'): never => {
  throw new Error(`process:${code}`);
};
export function createTeamProcessCommands(options: ProcessTeamOwnerContext) {
  const { store, registry, digest } = options;
  const processReceipts = () => {
    const entries = options.commandEntries();
    if (entries.length > 10000) return refuse('hold');
    return entries
      .filter(
        (row): row is ProcessCommandReceipt =>
          !!row && typeof row === 'object' && 'family' in row && row.family === 'process'
      )
      .map((row) => {
        validateProcessReceipt(row, digest);
        if (digest(row.binding) !== digest(options.binding)) return refuse('hold');
        return row;
      });
  };
  const path = (id: string) => {
    if (typeof id !== 'string' || !id || id.length > 256 || id.includes('\0'))
      return refuse('invalid');
    return `commands/${digest(id)}.json`;
  };
  const persist = (receipt: ProcessCommandReceipt) => {
    receipt.phase = processReceiptPhase(receipt.state);
    receipt.fingerprint = processReceiptFingerprint(receipt, digest);
    validateProcessReceipt(receipt, digest);
    store.write(path(receipt.commandId), receipt);
  };
  const readReceipt = (id: string): ProcessCommandReceipt | undefined => {
    const row = store.read<ProcessCommandReceipt>(path(id));
    if (!row) return undefined;
    validateProcessReceipt(row, digest);
    if (
      row.family !== 'process' ||
      row.schemaVersion !== 1 ||
      row.commandId !== id ||
      digest(row.binding) !== digest(options.binding)
    )
      return refuse('conflict');
    if (row.principalId !== options.principalId) return refuse('forbidden');
    if (!['prepared', 'requested', 'completed', 'refused'].includes(row.state.phase))
      return refuse('hold');
    return row;
  };
  const ref = (row: TeamProcessRow) => `p1:${row.id}:${digest({ binding: options.binding, row })}`;
  const view = (row: TeamProcessRow, completing?: ProcessCommandReceipt): TeamProcessView => {
    const { capturedNative, capturedByCommand } = row;
    const metadata = {
      id: row.id,
      pid: row.pid,
      label: row.label,
      registeredAt: row.registeredAt,
      ...(row.stoppedAt === undefined ? {} : { stoppedAt: row.stoppedAt }),
      ...(row.registeredBy === undefined ? {} : { registeredBy: row.registeredBy }),
      ...(row.port === undefined ? {} : { port: row.port }),
      ...(row.url === undefined ? {} : { url: row.url }),
      ...(row.command === undefined ? {} : { command: row.command }),
    };
    if (capturedNative) {
      if (!capturedByCommand) return refuse('hold');
      const proof = completing ?? store.read<ProcessCommandReceipt>(path(capturedByCommand));
      if (!proof) return refuse('hold');
      validateProcessReceipt(proof, digest);
      const { stoppedAt: _metadataStoppedAt, ...originalRegistration } = row;
      if (
        proof.operation !== 'register' ||
        proof.commandId !== capturedByCommand ||
        proof.state.phase !== 'completed' ||
        digest(proof.binding) !== digest(options.binding) ||
        digest(proof.original) !== digest(originalRegistration) ||
        digest(proof.capture) !== digest(capturedNative)
      )
        return refuse('hold');
    }
    const observation =
      capturedNative && options.native
        ? options.native.observe(capturedNative)
        : row.stoppedAt
          ? 'metadata-stopped'
          : 'unknown';
    const unresolved = capturedNative
      ? processReceipts().filter(
          (receipt) =>
            receipt.operation === 'terminate' &&
            receipt.state.phase === 'requested' &&
            digest(receipt.capture?.target) === digest(capturedNative.target)
        )
      : [];
    if (unresolved.length > 1) return refuse('hold');
    const pending = unresolved[0];
    return {
      ...metadata,
      processRef: ref(row),
      observation,
      canTerminate: observation === 'same-live' && !!capturedNative && !pending,
      ...(pending && pending.state.phase === 'requested'
        ? {
            pendingStop: {
              commandId: pending.commandId,
              originalProcessRef: pending.processRef!,
              native: pending.state.native,
            },
          }
        : {}),
    };
  };
  const select = (reference: string) => {
    const rows = registry.readStrict().filter((row) => ref(row) === reference);
    if (rows.length !== 1) return refuse('conflict');
    return rows[0]!;
  };
  const enter = (action: 'read' | 'process.write' | 'admin') => {
    options.assertCurrent();
    options.authorize('read');
    return options.authorize(action);
  };
  const admit = (
    commandId: string,
    operation: ProcessCommandReceipt['operation'],
    request: unknown,
    revision: number
  ) => {
    const previous = readReceipt(commandId),
      requestDigest = digest(request);
    if (previous) {
      if (previous.operation !== operation || previous.requestDigest !== requestDigest)
        return refuse('conflict');
      return { replay: true as const, receipt: previous };
    }
    if (options.reserved(commandId)) return refuse('conflict');
    // Existing receipt-family scanner must validate process family too; unknown families hold.
    if (options.commandEntries().length >= 10000) return refuse('hold');
    const receipt: ProcessCommandReceipt = {
      schemaVersion: 1,
      family: 'process',
      commandId,
      operation,
      requestDigest,
      principalId: options.principalId,
      binding: structuredClone(options.binding),
      authorityRevision: revision,
      fingerprint: digest({
        binding: options.binding,
        principalId: options.principalId,
        commandId,
        operation,
        requestDigest,
      }),
      phase: 'prepared',
      state: { phase: 'prepared', native: 'not-requested' },
    };
    return { replay: false as const, receipt };
  };
  return {
    /** Trusted lifecycle admission; metadata unregister cannot discard an original captured native target. */
    assertReleased(): void {
      store.fenced(() => {
        enter('admin');
        const receipts = processReceipts();
        if (receipts.some(row => row.phase !== 'completed' && row.phase !== 'rejected')) return refuse('hold');
        const rows = registry.readStrict();
        if (rows.some(row => !row.capturedNative)) return refuse('hold');
        const captures = new Map<string, RegisteredProcessCapture>();
        for (const row of rows) { view(row); if (row.capturedNative) captures.set(digest(row.capturedNative), row.capturedNative); }
        for (const receipt of receipts) if (receipt.capture) captures.set(digest(receipt.capture), receipt.capture);
        if (captures.size && !options.native) return refuse('hold');
        for (const capture of captures.values()) {
          const observed = options.native!.observe(capture);
          if (observed !== 'absent' && observed !== 'stale') return refuse('hold');
        }
        options.assertCurrent();
      });
    },
    pending() {
      return store.fenced(() => {
        enter('read');
        const pending = processReceipts().filter(
          (row) =>
            row.principalId === options.principalId &&
            row.operation === 'terminate' &&
            row.state.phase === 'requested'
        );
        if (pending.length > 64) return refuse('hold');
        return pending.map((row) => ({
          commandId: row.commandId,
          originalProcessRef: row.processRef!,
          state: row.state,
        }));
      });
    },
    list(): TeamProcessView[] {
      return store.fenced(() => {
        enter('read');
        const rows = registry.readStrict();
        // Metadata unregister cannot hide an original uncertain native request from cold UI reads.
        // This projects the immutable receipt only; it never recreates registry metadata or a target.
        const retained = processReceipts().filter(
          (receipt) =>
            receipt.operation === 'terminate' &&
            receipt.state.phase === 'requested' &&
            receipt.original &&
            !rows.some((row) => row.id === receipt.original!.id)
        );
        if (retained.length > 64 || rows.length + retained.length > 1024) return refuse('hold');
        const result = [...rows, ...retained.map((receipt) => receipt.original!)].map((row) =>
          view(row)
        );
        options.assertCurrent();
        return result;
      });
    },
    register(commandId: string, input: RegisterInput) {
      return store.fenced(() => {
        const grant = enter('process.write');
        if (
          !Number.isSafeInteger(input.pid) ||
          input.pid <= 1 ||
          input.pid > 0x7fffffff ||
          typeof input.label !== 'string' ||
          !input.label.trim() ||
          input.label.length > 1024 ||
          /[\0\r\n]/.test(input.label) ||
          (input.port !== undefined &&
            (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65535))
        )
          return refuse('invalid');
        const admitted = admit(commandId, 'register', input, grant.revision);
        if (admitted.replay) return structuredClone(admitted.receipt); // Never re-run even metadata after an uncertain original.
        const receipt = admitted.receipt,
          originalRows = registry.readStrict();
        if (
          originalRows.length >= 1024 &&
          !originalRows.some((row) => row.pid === input.pid && !row.stoppedAt)
        )
          return refuse('hold');
        const registrar = options.registrar();
        if (
          registrar.backendId !== options.binding.backendId ||
          registrar.teamId !== options.binding.teamId
        )
          return refuse('forbidden');
        const capture = options.native?.capture(input.pid, registrar);
        const existing = originalRows.filter((row) => row.pid === input.pid && !row.stoppedAt);
        if (
          existing.length > 1 ||
          existing.some(
            (row) =>
              !row.capturedNative || !capture || digest(row.capturedNative) !== digest(capture)
          )
        )
          return refuse('conflict');
        if (capture) receipt.capture = capture;
        receipt.fingerprint = processReceiptFingerprint(receipt, digest);
        persist(receipt); // Original native selection retained before registry policy writes.
        let result = registry.register({ ...input, from: grant.memberName });
        if (capture) result = registry.attachOriginal(result.id, commandId, capture);
        enter('process.write');
        const completed: ProcessCommandReceipt = {
          ...receipt,
          original: structuredClone(result),
          phase: 'completed',
          state: { phase: 'completed', native: 'not-requested' },
        };
        completed.fingerprint = processReceiptFingerprint(completed, digest);
        completed.result = view(result, completed);
        persist(completed);
        options.invalidate();
        return completed;
      });
    },
    metadata(
      commandId: string,
      operation: 'metadata-stop' | 'unregister',
      selector: ProcessMetadataSelector
    ) {
      return store.fenced(() => {
        const grant = enter('process.write'),
          admitted = admit(commandId, operation, selector, grant.revision);
        if (admitted.replay) return structuredClone(admitted.receipt);
        const rows = registry.readStrict();
        const original =
          'processRef' in selector
            ? [select(selector.processRef)]
            : rows.filter((row) =>
                'pid' in selector ? row.pid === selector.pid : row.id === selector.id
              );
        const selected =
          operation === 'metadata-stop'
            ? original.filter((row) => !row.stoppedAt).slice(0, 1)
            : original;
        if (!selected.length) return refuse('conflict');
        // PID selection is metadata-only. Immutable row refs are recorded before canonical policy writes.
        const receipt: ProcessCommandReceipt = {
          ...admitted.receipt,
          selected: selected.map((row) => ({ id: row.id, processRef: ref(row) })),
        };
        persist(receipt);
        const policySelector = 'processRef' in selector ? { id: selected[0]!.id } : selector;
        const changed =
          operation === 'metadata-stop'
            ? registry.stopMetadata(policySelector)
            : registry.unregister(policySelector);
        const result = Array.isArray(changed) ? changed.map((row) => view(row)) : view(changed);
        const completed: ProcessCommandReceipt = {
          ...receipt,
          result,
          state: { phase: 'completed', native: 'not-requested' },
        };
        persist(completed);
        options.invalidate();
        return completed;
      });
    },
    /** One synchronous native request. Accepted signal stays requested until original absence is observed. */
    terminate(commandId: string, reference: string) {
      return store.fenced(() => {
        const grant = enter('admin'),
          admitted = admit(commandId, 'terminate', { reference }, grant.revision);
        if (admitted.replay) return structuredClone(admitted.receipt);
        const original = select(reference),
          capture = original.capturedNative;
        if (!capture || !options.native || !view(original).canTerminate) return refuse('hold');
        const receipt: ProcessCommandReceipt = {
          ...admitted.receipt,
          processRef: reference,
          original: structuredClone(original),
          capture: structuredClone(capture),
          state: { phase: 'requested', native: 'unknown' },
        };
        receipt.fingerprint = processReceiptFingerprint(receipt, digest);
        persist(receipt); // Before signal and before any caller await.
        options.invalidate();
        try {
          const result = options.native.signal(capture);
          receipt.state =
            result === 'accepted'
              ? { phase: 'requested', native: 'accepted' }
              : { phase: 'refused', native: 'refused' };
          persist(receipt);
        } catch {
          /* Requested remains unknown; never turn a transport/process failure into no effect. */
        }
        return structuredClone(receipt);
      });
    },
    /** Continues only the original requested receipt; never invokes native.signal or recaptures. */
    lookup(commandId: string) {
      return store.fenced(() => {
        enter('read');
        const receipt = readReceipt(commandId);
        if (!receipt) return null;
        if (
          receipt.operation === 'terminate' &&
          receipt.state.phase === 'requested' &&
          receipt.capture &&
          receipt.original &&
          options.native?.observe(receipt.capture) === 'absent'
        ) {
          enter('admin');
          // Completion observes only the immutable original incarnation. Metadata changes
          // or unregister must never redirect this lookup to a replacement PID/row.
          const matching = registry
            .readStrict()
            .filter(
              (row) =>
                row.id === receipt.original!.id &&
                digest(row.capturedNative) === digest(receipt.capture)
            );
          if (matching.length > 1) return refuse('hold');
          const row = matching[0];
          let result: TeamProcessView | undefined;
          if (row) {
            view(row); // Validate the current row's own completed registration proof first.
            result = view(row.stoppedAt ? row : registry.stopMetadata({ id: row.id }));
          }
          const completed: ProcessCommandReceipt = {
            ...receipt,
            state: {
              phase: 'completed',
              native: 'observed-absent',
              signalAccepted: receipt.state.native === 'accepted' ? true : 'unknown',
            },
            ...(result ? { result } : {}),
          };
          persist(completed);
          options.invalidate();
          return completed;
        }
        return structuredClone(receipt);
      });
    },
  };
}
