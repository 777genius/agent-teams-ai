import { performance } from 'node:perf_hooks';

import { ServiceRefusal } from '../owned-process/codec.js';

import { serviceSource } from '../owned-process/retainedServiceContracts.js';
import type { WindowsServiceCapture, WindowsServiceIntent, WindowsServiceOutcome } from '../owned-process/retainedServiceContracts.js';
import type { ProcessTeamOwnerContext } from './TeamProcessCommands.js';
import type {
  ProcessCommandReceipt, ProcessObservation, ProcessRegisterInput, TeamProcessRow, TeamProcessView,
  WindowsProcessNative,
} from './registeredProcessContracts.js';

type Permission = 'read' | 'process.write' | 'admin';
/** Closures of the existing Team owner. This facet owns no journal or native capability. */
export interface WindowsProcessJournal {
  options: ProcessTeamOwnerContext;
  native: WindowsProcessNative;
  enter(action: Permission): { revision: number; memberName: string };
  admit(commandId: string, operation: ProcessCommandReceipt['operation'], request: unknown,
    revision: number): { replay: boolean; receipt: ProcessCommandReceipt };
  readReceipt(commandId: string): ProcessCommandReceipt | undefined;
  persist(receipt: ProcessCommandReceipt): void;
  processReceipts(): ProcessCommandReceipt[];
  visibleRows(): TeamProcessRow[];
  select(reference: string): TeamProcessRow;
  view(row: TeamProcessRow, completing?: ProcessCommandReceipt,
    observations?: ReadonlyMap<string, ProcessObservation>): TeamProcessView;
  legacyRegister(commandId: string, input: ProcessRegisterInput): ProcessCommandReceipt;
  legacyLookup(commandId: string): ProcessCommandReceipt | null;
  legacyTerminate(commandId: string, reference: string): ProcessCommandReceipt;
}
const refuse = (code: 'hold' | 'conflict' | 'forbidden' | 'invalid'): never => {
  throw new Error('process:' + code);
};
const unknown: WindowsServiceOutcome = Object.freeze({ state: 'unknown' });
const ERROR_NOT_FOUND = 1168; // Windows WinError.h: the original capture's keyed record is missing.

/** Native awaits always leave the Team fence; re-entry validates the same stored command. */
export function createWindowsTeamProcessCommands(context: WindowsProcessJournal) {
  const { options, native } = context;
  const { store, registry, digest } = options;
  const bounded = (deadline: number) => {
    if (!Number.isFinite(deadline)) return refuse('invalid');
    return Math.min(deadline, performance.now() + 10000);
  };
  const aliveBudget = (deadline: number) => performance.now() < deadline;
  const same = (left: unknown, right: unknown) => left === undefined || right === undefined
    ? left === right : digest(left) === digest(right);
  const frozenReceipt = (receipt: ProcessCommandReceipt) => structuredClone(receipt);
  const storedOriginal = (original: ProcessCommandReceipt) => {
    const receipt = context.readReceipt(original.commandId);
    if (!receipt || receipt.operation !== original.operation ||
        receipt.requestDigest !== original.requestDigest ||
        receipt.authorityRevision !== original.authorityRevision ||
        !same(receipt.nativeIntent, original.nativeIntent) ||
        (original.capture && !same(receipt.capture, original.capture)) ||
        (original.nativeSettlement && !same(receipt.nativeSettlement, original.nativeSettlement)) ||
        (original.originalRegistration && (!receipt.originalRegistration ||
          !same(receipt.originalRegistration.input, original.originalRegistration.input) ||
          receipt.originalRegistration.memberName !== original.originalRegistration.memberName ||
          (original.originalRegistration.policyRequested && !receipt.originalRegistration.policyRequested))))
      return refuse('conflict');
    return receipt;
  };
  function registerInput(input: ProcessRegisterInput): ProcessRegisterInput {
    if (!input || !Number.isSafeInteger(input.pid) || input.pid <= 1 || input.pid > 0x7fffffff ||
        typeof input.label !== 'string' || !input.label.trim() || input.label.length > 1024 ||
        /[\0\r\n]/.test(input.label) ||
        (input.port !== undefined && (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65535)) ||
        [input.url, input.command].some(value => value !== undefined &&
          (typeof value !== 'string' || value.length > 4096 || value.includes('\0')))) return refuse('invalid');
    return { pid: input.pid, label: input.label, ...(input.port === undefined ? {} : { port: input.port }),
      ...(input.url === undefined ? {} : { url: input.url }),
      ...(input.command === undefined ? {} : { command: input.command }) };
  }
  function assertRegistrar(receipt: ProcessCommandReceipt): void {
    const intent = receipt.nativeIntent, registration = receipt.originalRegistration;
    if (!intent || intent.command.operation !== 'capture' || !registration) return refuse('hold');
    const grant = context.enter('process.write');
    if (grant.memberName !== registration.memberName || grant.revision !== receipt.authorityRevision ||
        !same(options.registrar(), intent.command.registrar)) return refuse('forbidden');
  }
  function policyInputMatches(row: TeamProcessRow, receipt: ProcessCommandReceipt): boolean {
    const registration = receipt.originalRegistration;
    if (!registration) return false;
    const input = registration.input;
    return row.pid === input.pid && row.label === input.label.trim() &&
      row.registeredBy === registration.memberName.trim() && row.port === input.port &&
      row.url === (input.url?.trim() || undefined) &&
      row.command === (input.command?.trim() || undefined);
  }
  function assertActiveRows(input: ProcessRegisterInput, capture?: WindowsServiceCapture): void {
    const rows = registry.readStrict();
    const active = rows.filter(row => row.pid === input.pid && !row.stoppedAt);
    if (rows.length >= 1024 && !active.length) return refuse('hold');
    if (active.length > 1 || (capture && active.some(row => !same(row.capturedNative, capture))))
      return refuse('conflict');
  }
  async function queryEvidence(capture: WindowsServiceCapture, deadline: number): Promise<WindowsServiceOutcome> {
    if (!aliveBudget(deadline)) return unknown;
    try {
      const result = await native.query(capture, deadline);
      return aliveBudget(deadline) && result.state === 'observed' && same(result.capture, capture)
        ? result : unknown;
    } catch { return unknown; }
  }
  async function query(capture: WindowsServiceCapture, deadline: number): Promise<ProcessObservation> {
    const result = await queryEvidence(capture, deadline);
    return result.state === 'observed' ? result.observation : 'unknown';
  }
  async function outcome(intent: WindowsServiceIntent, deadline: number,
    initial: boolean): Promise<WindowsServiceOutcome> {
    try { return await (initial ? native.run(intent, deadline) : native.lookup(intent, deadline)); }
    catch { return unknown; }
  }
  function continueRegister(original: ProcessCommandReceipt, result: WindowsServiceOutcome, deadline: number) {
    options.assertAsyncCurrent?.(); // Full original Runtime/input check, outside the Team fence.
    return store.fenced(() => {
      context.enter('read');
      const receipt = storedOriginal(original);
      if (receipt.state.phase === 'completed' || receipt.state.phase === 'refused') return frozenReceipt(receipt);
      assertRegistrar(receipt);
      const registration = receipt.originalRegistration!, intent = receipt.nativeIntent!;
      if (intent.command.operation !== 'capture') return refuse('hold');
      if (result.state === 'not-dispatched' && !receipt.capture && !registration.policyRequested) {
        receipt.state = { phase: 'refused', native: 'not-requested' };
        context.persist(receipt);
        options.invalidate();
        return frozenReceipt(receipt);
      }
      if (result.state === 'refused' && result.reason === ServiceRefusal.missing &&
          result.nativeCode === ERROR_NOT_FOUND && !receipt.capture && !registration.policyRequested) {
        receipt.state = { phase: 'refused', native: 'refused' };
        context.persist(receipt);
        options.invalidate();
        return frozenReceipt(receipt);
      }
      if (result.state === 'captured') {
        if (result.capture.version !== 5 || !same(serviceSource(result.capture), serviceSource(intent)) ||
            result.capture.target.pid !== intent.command.pid ||
            !same(result.capture.registrar, intent.command.registrar) ||
            (receipt.capture && !same(receipt.capture, result.capture))) return refuse('hold');
        if (!receipt.capture) {
          receipt.capture = structuredClone(result.capture);
          context.persist(receipt); // Before policy write, including a recovered original capture ACK.
        }
      }
      const capture = receipt.capture;
      if (!capture || capture.version !== 5 || !aliveBudget(deadline)) return frozenReceipt(receipt);
      let row: TeamProcessRow;
      if (registration.policyRequested) {
        // The original policy effect may already have happened. Never register again.
        const rows = registry.readStrict();
        const active = rows.filter(value => value.pid === registration.input.pid && !value.stoppedAt);
        if (active.length > 1 || active.some(value => value.capturedNative !== undefined &&
            !same(value.capturedNative, capture))) return refuse('conflict');
        // An interrupted policy write may leave metadata without the original attachment.
        // It remains unknown: do not attach by PID, repeat register, or call it a foreign capture.
        if (active.some(value => value.capturedNative === undefined)) return frozenReceipt(receipt);
        const matches = rows.filter(value => value.capturedByCommand === receipt.commandId &&
          same(value.capturedNative, capture) && policyInputMatches(value, receipt));
        if (matches.length !== 1) return frozenReceipt(receipt);
        row = matches[0]!;
      } else {
        assertActiveRows(registration.input, capture);
        if (!aliveBudget(deadline)) return frozenReceipt(receipt);
        registration.policyRequested = true;
        context.persist(receipt);
        const registered = registry.register({ ...registration.input, from: registration.memberName });
        row = registry.attachOriginal(registered.id, receipt.commandId, capture);
        if (!policyInputMatches(row, receipt)) return refuse('hold');
      }
      assertRegistrar(receipt);
      const { stoppedAt: _metadataStop, ...registered } = row;
      const completed: ProcessCommandReceipt = { ...receipt, original: structuredClone(registered),
        state: { phase: 'completed', native: 'not-requested' } };
      completed.phase = 'completed';
      // view validates the same registration proof; persist computes its one canonical fingerprint.
      context.persist(completed);
      completed.result = context.view(row, completed);
      context.persist(completed);
      options.invalidate();
      return frozenReceipt(completed);
    });
  }
  function terminal(capture: WindowsServiceCapture): boolean {
    return context.processReceipts().some(receipt => receipt.operation === 'terminate' &&
      receipt.state.phase === 'completed' && receipt.state.native === 'observed-absent' &&
      same(receipt.capture, capture));
  }
  function completeStop(original: ProcessCommandReceipt, result: WindowsServiceOutcome,
    observation: ProcessObservation): ProcessCommandReceipt {
    options.assertAsyncCurrent?.();
    return store.fenced(() => {
      context.enter('read');
      const receipt = storedOriginal(original);
      if (receipt.state.phase !== 'requested') return frozenReceipt(receipt);
      context.enter('admin');
      const capture = receipt.capture;
      if (!capture || capture.version !== 5 || !receipt.original) return refuse('hold');
      if (result.state === 'not-dispatched') {
        receipt.state = { phase: 'refused', native: 'not-requested' };
        context.persist(receipt); options.invalidate();
        return frozenReceipt(receipt);
      }
      const absent = observation === 'absent' ||
        (result.state === 'stopped' && same(result.capture, capture) && result.observation === 'absent') ||
        terminal(capture);
      if (!absent) return frozenReceipt(receipt);
      const matching = registry.readStrict().filter(row =>
        row.id === receipt.original!.id && same(row.capturedNative, capture));
      if (matching.length > 1) return refuse('hold');
      const row = matching[0];
      let stopped: TeamProcessRow | undefined;
      if (row) {
        context.view(row);
        stopped = row.stoppedAt ? row : registry.stopMetadata({ id: row.id });
      }
      const completed: ProcessCommandReceipt = { ...receipt,
        state: { phase: 'completed', native: 'observed-absent', signalAccepted: 'unknown' } };
      context.persist(completed);
      if (stopped) { completed.result = context.view(stopped); context.persist(completed); }
      options.invalidate();
      return frozenReceipt(completed);
    });
  }
  async function settle(original: ProcessCommandReceipt, deadline: number): Promise<ProcessCommandReceipt> {
    options.assertAsyncCurrent?.();
    const retryNoDispatch = original.nativeSettlementNotDispatched ? original.nativeSettlement : undefined;
    let first: WindowsServiceIntent | undefined;
    const selected = store.fenced(() => {
      context.enter('read');
      const receipt = storedOriginal(original), capture = receipt.capture;
      if (receipt.operation !== 'terminate' || receipt.state.phase !== 'completed' ||
          receipt.state.native !== 'observed-absent' || !capture || capture.version !== 5 ||
          !aliveBudget(deadline)) return receipt;
      context.enter('admin');
      if (context.processReceipts().some(value => value.operation === 'terminate' &&
          value.state.phase === 'requested' && same(value.capture, capture))) return receipt;
      if (!receipt.nativeSettlement || (receipt.nativeSettlementNotDispatched && retryNoDispatch &&
          same(retryNoDispatch, receipt.nativeSettlement))) {
        first = native.prepareControl(capture, 'settle');
        receipt.nativeSettlement = structuredClone(first);
        delete receipt.nativeSettlementNotDispatched;
        context.persist(receipt); // Same completed receipt, before the original settle await.
      }
      return frozenReceipt(receipt);
    });
    if (!selected.nativeSettlement) return frozenReceipt(selected);
    // A serialized intent has lookup authority only. Natural exit never mints a Stop receipt.
    const result = await outcome(first ?? selected.nativeSettlement, deadline, !!first);
    options.assertAsyncCurrent?.();
    return store.fenced(() => {
      context.enter('read'); options.assertCurrent();
      const receipt = storedOriginal(selected);
      if (result.state === 'not-dispatched' && !receipt.nativeSettlementNotDispatched) {
        context.enter('admin');
        receipt.nativeSettlementNotDispatched = true;
        context.persist(receipt); options.invalidate();
      }
      return frozenReceipt(receipt);
    });
  }


  /** Called only under the existing admin fence; public principal-bound lookup is unchanged. */
  function naturalOriginal(capture: WindowsServiceCapture): ProcessCommandReceipt | undefined {
    const receipts = context.processReceipts();
    if (receipts.some(receipt => receipt.operation === 'terminate' &&
        receipt.state.phase !== 'completed' && receipt.state.phase !== 'refused' &&
        same(receipt.capture, capture))) return refuse('hold');
    if (receipts.some(receipt => receipt.operation === 'terminate' &&
        receipt.state.phase === 'completed' && receipt.state.native === 'observed-absent' &&
        same(receipt.capture, capture))) return undefined; // Existing genuine Stop owns its settlement.
    const registrations = receipts.filter(receipt => receipt.operation === 'register' &&
      receipt.state.phase === 'completed' && receipt.state.native === 'not-requested' &&
      receipt.nativeIntent?.command.operation === 'capture' && receipt.originalRegistration?.policyRequested &&
      receipt.original && receipt.capture?.version === 5 && same(receipt.capture, capture));
    const anchors = registrations.filter(receipt => receipt.nativeAbsence !== undefined);
    if (anchors.length > 1 || !registrations.length) return refuse('hold');
    const selected = anchors[0] ?? registrations.sort((left, right) =>
      left.commandId < right.commandId ? -1 : left.commandId > right.commandId ? 1 : 0)[0]!;
    return frozenReceipt(selected);
  }
  function assertNaturalOriginal(original: ProcessCommandReceipt, current: ProcessCommandReceipt): void {
    if (current.commandId !== original.commandId || current.principalId !== original.principalId ||
        current.requestDigest !== original.requestDigest || current.authorityRevision !== original.authorityRevision ||
        !same(current.binding, original.binding) || !same(current.capture, original.capture) ||
        !same(current.nativeIntent, original.nativeIntent) || !same(current.originalRegistration, original.originalRegistration) ||
        !same(current.original, original.original)) return refuse('conflict');
  }
  async function settleNatural(original: ProcessCommandReceipt, deadline: number,
    retryNoDispatch: WindowsServiceIntent | undefined): Promise<void> {
    options.assertAsyncCurrent?.();
    const capture = original.capture;
    if (capture?.version !== 5) return refuse('hold');
    let first: WindowsServiceIntent | undefined;
    const selected = store.fenced(() => {
      context.enter('admin');
      const receipt = naturalOriginal(capture);
      if (!receipt) return undefined;
      assertNaturalOriginal(original, receipt);
      if (!receipt.nativeAbsence) return refuse('hold');
      const state = receipt.nativeAbsence.settlement;
      if (state === 'settled' || !aliveBudget(deadline)) return undefined;
      if (state === 'not-dispatched' &&
          (!retryNoDispatch || !same(retryNoDispatch, receipt.nativeSettlement))) return undefined;
      if (state === 'unprepared' || state === 'not-dispatched') {
        first = native.prepareControl(capture, 'settle');
        receipt.nativeSettlement = structuredClone(first);
        receipt.nativeAbsence = { ...receipt.nativeAbsence, settlement: 'requested' };
        context.persist(receipt); // Same original register, before the first native settle await.
        options.invalidate();
      }
      return frozenReceipt(receipt);
    });
    if (!selected?.nativeSettlement) return;
    const result = await outcome(first ?? selected.nativeSettlement, deadline, !!first);
    options.assertAsyncCurrent?.();
    store.fenced(() => {
      context.enter('admin');
      const receipt = naturalOriginal(capture);
      if (!receipt) return;
      assertNaturalOriginal(selected, receipt);
      if (!receipt.nativeAbsence) return refuse('hold');
      if (!same(receipt.nativeSettlement, selected.nativeSettlement) ||
          receipt.nativeAbsence.settlement === 'settled' ||
          (!aliveBudget(deadline) && result.state !== 'not-dispatched')) return;
      if (result.state === 'settled' && same(result.capture, capture)) {
        receipt.nativeAbsence = { ...receipt.nativeAbsence, settlement: 'settled' };
      } else if (result.state === 'not-dispatched' && receipt.nativeAbsence.settlement === 'requested') {
        receipt.nativeAbsence = { ...receipt.nativeAbsence, settlement: 'not-dispatched' };
      } else return;
      context.persist(receipt); options.invalidate();
    });
  }
  async function reconcileNatural(capture: WindowsServiceCapture, deadline: number): Promise<void> {
    options.assertAsyncCurrent?.();
    let original: ProcessCommandReceipt | undefined = store.fenced(() => {
      context.enter('admin');
      return aliveBudget(deadline) ? naturalOriginal(capture) : undefined;
    });
    if (!original) return;
    // Only a call which entered after confirmed no-dispatch may admit a new settlement intent.
    const retryNoDispatch = original.nativeAbsence?.settlement === 'not-dispatched'
      ? original.nativeSettlement : undefined;
    if (!original.nativeAbsence) {
      const observed = await queryEvidence(capture, deadline);
      options.assertAsyncCurrent?.();
      const capturedOriginal = original;
      original = store.fenced(() => {
        context.enter('admin');
        const receipt = naturalOriginal(capture);
        if (!receipt) return undefined;
        assertNaturalOriginal(capturedOriginal, receipt);
        if (!aliveBudget(deadline)) return undefined;
        if (!receipt.nativeAbsence) {
          if (observed.state !== 'observed' || observed.observation !== 'absent' ||
              !same(observed.capture, capture)) return undefined;
          receipt.nativeAbsence = { schemaVersion: 1, kind: 'windows-service-absence-v1',
            captureDigest: digest(capture), evidence: observed.evidence, settlement: 'unprepared' };
          context.persist(receipt); options.invalidate();
        }
        return frozenReceipt(receipt);
      });
    }
    if (original) await settleNatural(original, deadline, retryNoDispatch);
  }

  return {
    /** Private lifecycle maintenance, never a public command or a new PID capture. */
    async reconcileNaturalAbsence(originalDeadline: number): Promise<void> {
      const deadline = bounded(originalDeadline);
      options.assertAsyncCurrent?.();
      const captures = store.fenced(() => {
        context.enter('admin');
        const selected = new Map<string, WindowsServiceCapture>();
        for (const row of context.visibleRows()) {
          context.view(row);
          if (row.capturedNative?.version === 5) selected.set(digest(row.capturedNative), row.capturedNative);
        }
        for (const receipt of context.processReceipts()) if (receipt.capture?.version === 5)
          selected.set(digest(receipt.capture), receipt.capture);
        options.assertCurrent();
        return structuredClone([...selected.values()]);
      });
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(3, captures.length) }, async () => {
        while (next < captures.length && aliveBudget(deadline))
          await reconcileNatural(captures[next++]!, deadline);
      }));
      options.assertAsyncCurrent?.();
      store.fenced(() => { context.enter('admin'); options.assertCurrent(); });
    },
    async register(commandId: string, raw: ProcessRegisterInput, originalDeadline: number): Promise<ProcessCommandReceipt> {
      const deadline = bounded(originalDeadline);
      options.assertAsyncCurrent?.();
      const prepareCapture = native.prepareCapture?.bind(native);
      if (!prepareCapture) return context.legacyRegister(commandId, raw);
      let first: WindowsServiceIntent | undefined;
      const admitted = store.fenced(() => {
        const grant = context.enter('process.write'), input = registerInput(raw);
        const admitted = context.admit(commandId, 'register', input, grant.revision);
        if (admitted.replay) return admitted;
        assertActiveRows(input);
        const registrar = options.registrar();
        if (registrar.backendId !== options.binding.backendId || registrar.teamId !== options.binding.teamId)
          return refuse('forbidden');
        first = prepareCapture(input.pid, registrar);
        const receipt: ProcessCommandReceipt = { ...admitted.receipt,
          nativeIntent: structuredClone(first),
          originalRegistration: { input, memberName: grant.memberName, policyRequested: false },
          state: { phase: 'requested', native: 'unknown' } };
        context.persist(receipt); options.invalidate();
        return { replay: false, receipt };
      });
      if (admitted.replay) return frozenReceipt(admitted.receipt);
      return continueRegister(admitted.receipt, await outcome(first!, deadline, true), deadline);
    },
    async list(originalDeadline: number): Promise<TeamProcessView[]> {
      const deadline = bounded(originalDeadline);
      options.assertAsyncCurrent?.();
      const originalRows = store.fenced(() => {
        context.enter('read');
        const rows = context.visibleRows();
        for (const row of rows) context.view(row);
        options.assertCurrent(); return structuredClone(rows);
      });
      const captures = [...new Map(originalRows.flatMap(row => row.capturedNative?.version === 5
        ? [[digest(row.capturedNative), row.capturedNative] as const] : [])).values()];
      const observations = new Map<string, ProcessObservation>();
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(3, captures.length) }, async () => {
        while (next < captures.length && aliveBudget(deadline)) {
          const capture = captures[next++]!;
          observations.set(digest(capture), await query(capture, deadline));
        }
      }));
      options.assertAsyncCurrent?.();
      return store.fenced(() => {
        context.enter('read');
        const originals = new Set(originalRows.map(row => digest(row)));
        const result = context.visibleRows().map(row =>
          context.view(row, undefined, originals.has(digest(row)) ? observations : undefined));
        options.assertCurrent(); return result;
      });
    },
    async terminate(commandId: string, reference: string, originalDeadline: number): Promise<ProcessCommandReceipt> {
      const deadline = bounded(originalDeadline);
      options.assertAsyncCurrent?.();
      let first: WindowsServiceIntent | undefined;
      const admitted = store.fenced(() => {
        const grant = context.enter('admin'), admitted = context.admit(commandId, 'terminate', { reference }, grant.revision);
        if (admitted.replay) return admitted;
        const original = context.select(reference), capture = original.capturedNative;
        if (capture?.version !== 5) return undefined;
        const view = context.view(original);
        if (view.pendingStop || view.observation === 'absent' || view.observation === 'stale') return refuse('hold');
        first = native.prepareControl(capture, 'stop');
        const receipt: ProcessCommandReceipt = { ...admitted.receipt, processRef: reference,
          original: structuredClone(original), capture: structuredClone(capture),
          nativeIntent: structuredClone(first), state: { phase: 'requested', native: 'unknown' } };
        context.persist(receipt); options.invalidate();
        return { replay: false, receipt };
      });
      if (!admitted) return context.legacyTerminate(commandId, reference);
      if (admitted.replay) return frozenReceipt(admitted.receipt);
      const result = await outcome(first!, deadline, true);
      return settle(completeStop(admitted.receipt, result, 'unknown'), deadline);
    },
    async lookup(commandId: string, originalDeadline: number): Promise<ProcessCommandReceipt | null> {
      const deadline = bounded(originalDeadline);
      options.assertAsyncCurrent?.();
      const original = store.fenced(() => {
        context.enter('read');
        const receipt = context.readReceipt(commandId);
        return receipt ? frozenReceipt(receipt) : null;
      });
      if (!original?.nativeIntent) return context.legacyLookup(commandId);
      if (original.operation === 'register') {
        if (original.state.phase !== 'requested') return original;
        return continueRegister(original, await outcome(original.nativeIntent, deadline, false), deadline);
      }
      if (original.operation !== 'terminate' || original.capture?.version !== 5) return refuse('hold');
      if (original.state.phase !== 'requested') return settle(original, deadline);
      const result = await outcome(original.nativeIntent, deadline, false);
      const observed = result.state === 'not-dispatched' ? 'unknown' : await query(original.capture, deadline);
      return settle(completeStop(original, result, observed), deadline);
    },
  };
}
