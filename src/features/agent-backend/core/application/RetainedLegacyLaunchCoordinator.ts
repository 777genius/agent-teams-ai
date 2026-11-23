import type {
  RetainedLegacyLaunchChoice,
  RetainedLegacyLaunchFailure,
  RetainedLegacyLaunchRequest,
  RetainedLegacyLaunchResult,
  RetainedLegacyLaunchValueMap,
} from '../../contracts/retainedLegacyLaunch';

type ScopeRequest = Exclude<RetainedLegacyLaunchRequest, { action: 'open' | 'closeIntent' }>;
type OperationRequest = Exclude<ScopeRequest, { action: 'close' | 'rebind' | 'cancelModels' }>;

/** Captured by trusted composition. None of these selectors cross the renderer boundary. */
export interface RetainedLegacyLaunchAuthority {
  sourceKey: string;
  teamName: string;
  projectPath: string;
  assertSourceCurrent(): void;
  assertRuntimeCurrent(): void;
  readImportAbsence(): Promise<'absent' | 'present' | 'unknown'>;
  readEligibility(): Promise<'stopped' | 'native-custody-unverified' | 'other'>;
  run<K extends OperationRequest['action']>(
    request: Extract<OperationRequest, { action: K }>
  ): Promise<RetainedLegacyLaunchValueMap[K]>;
  close(): Promise<void>;
  cancelModels(
    request: Extract<ScopeRequest, { action: 'cancelModels' }>
  ): Promise<RetainedLegacyLaunchValueMap['cancelModels']>;
}

interface Effect {
  signature: string;
  result?: RetainedLegacyLaunchResult;
}
interface Scope {
  choice: RetainedLegacyLaunchChoice;
  intentId: string;
  authority: RetainedLegacyLaunchAuthority;
  effects: Map<'roster' | 'launch', Effect>;
  disposalUnknown?: boolean;
  readsInFlight: number;
  readFailureUnknown?: boolean;
}
interface PendingChoice {
  cancelled: boolean;
  done: Promise<void>;
  finish(): void;
}
interface CandidateDebt {
  authority: RetainedLegacyLaunchAuthority;
  teamName: string;
  intentId: string;
}

export class RetainedLegacyLaunchRefusal extends Error {
  constructor(readonly reason: RetainedLegacyLaunchFailure) {
    super('Original runtime selection is unavailable');
  }
}

function signature(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(signature).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${signature(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** One Main authority serializes detached import publication and explicit original-runtime work. */
export class RetainedLegacyLaunchCoordinator {
  private readonly scopes = new Map<string, Scope>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly rebindings = new Map<
    string,
    { signature: string; choice: RetainedLegacyLaunchChoice }
  >();
  private readonly pendingChoices = new Map<string, Set<PendingChoice>>();
  private readonly closedIntents = new Set<string>();
  private readonly candidateDebts = new Map<string, CandidateDebt[]>();
  private sealed = false;

  constructor(
    private readonly ports: {
      capture(teamName: string, projectPath?: string): Promise<RetainedLegacyLaunchAuthority>;
      createId(): string;
      now(): number;
      lifetimeMs?: number;
    }
  ) {}

  private async exclusive<T>(sourceKey: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sourceKey) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(sourceKey, tail);
    await previous;
    try {
      if (this.sealed) throw new RetainedLegacyLaunchRefusal('unavailable');
      return await operation();
    } finally {
      release();
      if (this.tails.get(sourceKey) === tail) this.tails.delete(sourceKey);
    }
  }

  private assertCurrent(scope: Scope): void {
    if (this.sealed || this.scopes.get(scope.choice.scopeId) !== scope)
      throw new RetainedLegacyLaunchRefusal('unavailable');
    if (this.candidateDebts.has(scope.authority.sourceKey))
      throw new RetainedLegacyLaunchRefusal('outcome-unknown');
    scope.authority.assertSourceCurrent();
    scope.authority.assertRuntimeCurrent();
    if (scope.choice.expiresAt <= this.ports.now() && scope.effects.size === 0)
      throw new RetainedLegacyLaunchRefusal('unavailable');
  }

  private async assertAbsent(authority: RetainedLegacyLaunchAuthority): Promise<void> {
    authority.assertSourceCurrent();
    const absence = await authority.readImportAbsence();
    authority.assertSourceCurrent();
    authority.assertRuntimeCurrent();
    if (absence !== 'absent') throw new RetainedLegacyLaunchRefusal('import-not-absent');
  }

  private async reclaimExpiredChoices(): Promise<void> {
    for (const scope of [...this.scopes.values()]) {
      if (scope.effects.size || scope.disposalUnknown || scope.choice.expiresAt > this.ports.now())
        continue;
      await this.exclusive(scope.authority.sourceKey, async () => {
        if (
          this.scopes.get(scope.choice.scopeId) !== scope ||
          scope.effects.size ||
          scope.disposalUnknown ||
          scope.choice.expiresAt > this.ports.now()
        )
          return;
        await this.closeScope(scope);
      });
    }
  }

  private async closeScope(scope: Scope): Promise<void> {
    if (scope.disposalUnknown) throw new RetainedLegacyLaunchRefusal('outcome-unknown');
    try {
      await scope.authority.close();
    } catch {
      scope.disposalUnknown = true;
      throw new RetainedLegacyLaunchRefusal('outcome-unknown');
    }
    this.scopes.delete(scope.choice.scopeId);
  }

  private async disposeCandidate(
    authority: RetainedLegacyLaunchAuthority,
    teamName: string,
    intentId: string
  ): Promise<void> {
    try {
      await authority.close();
    } catch {
      const debt = this.candidateDebts.get(authority.sourceKey) ?? [];
      debt.push({ authority, teamName, intentId });
      this.candidateDebts.set(authority.sourceKey, debt);
      throw new RetainedLegacyLaunchRefusal('outcome-unknown');
    }
  }

  private intentKey(teamName: string, intentId: string): string {
    return JSON.stringify([teamName, intentId]);
  }

  private beginChoice(teamName: string, intentId: string): PendingChoice {
    const key = this.intentKey(teamName, intentId);
    if (this.closedIntents.has(key)) throw new RetainedLegacyLaunchRefusal('unavailable');
    let done!: () => void;
    const entry: PendingChoice = {
      cancelled: false,
      done: new Promise<void>((resolve) => {
        done = resolve;
      }),
      finish: () => {
        this.pendingChoices.get(key)?.delete(entry);
        if (!this.pendingChoices.get(key)?.size) this.pendingChoices.delete(key);
        done();
      },
    };
    const pending = this.pendingChoices.get(key) ?? new Set<PendingChoice>();
    pending.add(entry);
    this.pendingChoices.set(key, pending);
    return entry;
  }

  private async closeIntent(
    teamName: string,
    intentId: string
  ): Promise<RetainedLegacyLaunchResult> {
    const key = this.intentKey(teamName, intentId);
    this.closedIntents.add(key);
    const pending = [...(this.pendingChoices.get(key) ?? [])];
    for (const entry of pending) entry.cancelled = true;
    await Promise.all(pending.map((entry) => entry.done));
    if (
      [...this.candidateDebts.values()]
        .flat()
        .some((debt) => debt.teamName === teamName && debt.intentId === intentId)
    )
      throw new RetainedLegacyLaunchRefusal('outcome-unknown');
    for (const scope of [...this.scopes.values()]) {
      if (scope.choice.teamName !== teamName || scope.intentId !== intentId) continue;
      await this.exclusive(scope.authority.sourceKey, async () => {
        if (this.scopes.get(scope.choice.scopeId) !== scope) return;
        if ([...scope.effects.values()].some((effect) => !effect.result?.ok))
          throw new RetainedLegacyLaunchRefusal('outcome-unknown');
        await this.closeScope(scope);
      });
    }
    // Bound cancellation history only. Eviction may admit a fresh zero-effect choice for an old
    // intent; consumed scope IDs, uncertain effects and physical cleanup debts remain independent.
    while (this.closedIntents.size > 512)
      this.closedIntents.delete(this.closedIntents.values().next().value!);
    return { ok: true, action: 'closeIntent', value: null };
  }

  private replayRebind(
    request: Extract<RetainedLegacyLaunchRequest, { action: 'rebind' }>
  ): RetainedLegacyLaunchResult | undefined {
    const recorded = this.rebindings.get(request.scopeId);
    if (!recorded) return;
    if (recorded.signature !== signature(request))
      throw new RetainedLegacyLaunchRefusal('intent-changed');
    const next = this.scopes.get(recorded.choice.scopeId);
    if (!next) throw new RetainedLegacyLaunchRefusal('unavailable');
    this.assertCurrent(next);
    return { ok: true, action: 'rebind', value: { ...recorded.choice } };
  }

  private async retainOpen(
    authority: RetainedLegacyLaunchAuthority,
    request: Extract<RetainedLegacyLaunchRequest, { action: 'open' }>,
    pending: PendingChoice,
    sourceKey: string
  ): Promise<RetainedLegacyLaunchResult> {
    let retainedAuthority = false;
    try {
      authority.assertSourceCurrent();
      authority.assertRuntimeCurrent();
      if (authority.sourceKey !== sourceKey || authority.teamName !== request.teamName)
        throw new RetainedLegacyLaunchRefusal('source-changed');
      if (this.candidateDebts.has(sourceKey))
        throw new RetainedLegacyLaunchRefusal('outcome-unknown');
      if (pending.cancelled) throw new RetainedLegacyLaunchRefusal('unavailable');
      const retained = [...this.scopes.values()].find(
        (scope) => scope.authority.sourceKey === sourceKey
      );
      if (retained) {
        this.assertCurrent(retained);
        if (retained.intentId !== request.intentId) throw new RetainedLegacyLaunchRefusal('busy');
        return { ok: true, action: 'open', value: { ...retained.choice } };
      }
      if (this.scopes.size >= 32) throw new RetainedLegacyLaunchRefusal('busy');
      await this.assertAbsent(authority);
      const eligible = await authority.readEligibility();
      authority.assertSourceCurrent();
      authority.assertRuntimeCurrent();
      if (eligible === 'other') throw new RetainedLegacyLaunchRefusal('not-eligible');
      if (pending.cancelled) throw new RetainedLegacyLaunchRefusal('unavailable');
      const choice: RetainedLegacyLaunchChoice = {
        scopeId: this.ports.createId(),
        teamName: authority.teamName,
        mode: 'original-runtime',
        projectPath: authority.projectPath,
        expiresAt: this.ports.now() + (this.ports.lifetimeMs ?? 30 * 60_000),
      };
      this.scopes.set(choice.scopeId, {
        choice,
        intentId: request.intentId,
        authority,
        effects: new Map(),
        readsInFlight: 0,
      });
      retainedAuthority = true;
      return { ok: true, action: 'open', value: { ...choice } };
    } finally {
      // This runs while the physical source queue is still held, including awaited cleanup.
      if (!retainedAuthority)
        await this.disposeCandidate(authority, request.teamName, request.intentId);
    }
  }

  private async rebind(
    scope: Scope,
    request: Extract<RetainedLegacyLaunchRequest, { action: 'rebind' }>,
    capture: typeof this.ports.capture,
    pending: PendingChoice
  ): Promise<RetainedLegacyLaunchResult> {
    this.assertCurrent(scope);
    if (scope.effects.size || scope.disposalUnknown || scope.readFailureUnknown)
      throw new RetainedLegacyLaunchRefusal(
        scope.disposalUnknown || scope.readFailureUnknown ? 'outcome-unknown' : 'intent-changed'
      );
    if (scope.readsInFlight) throw new RetainedLegacyLaunchRefusal('busy');
    await this.assertAbsent(scope.authority);
    const authority = await capture(scope.choice.teamName, request.projectPath);
    let retained = false;
    try {
      this.assertCurrent(scope);
      authority.assertSourceCurrent();
      authority.assertRuntimeCurrent();
      if (
        authority.sourceKey !== scope.authority.sourceKey ||
        authority.teamName !== scope.choice.teamName
      )
        throw new RetainedLegacyLaunchRefusal('source-changed');
      await this.assertAbsent(authority);
      if ((await authority.readEligibility()) === 'other')
        throw new RetainedLegacyLaunchRefusal('not-eligible');
      this.assertCurrent(scope);
      authority.assertSourceCurrent();
      authority.assertRuntimeCurrent();
      if (pending.cancelled) throw new RetainedLegacyLaunchRefusal('unavailable');
      // The same physical queue remains held while every old read helper closes.
      await this.closeScope(scope);
      authority.assertSourceCurrent();
      authority.assertRuntimeCurrent();
      if (pending.cancelled) throw new RetainedLegacyLaunchRefusal('unavailable');
      const choice: RetainedLegacyLaunchChoice = {
        scopeId: this.ports.createId(),
        teamName: authority.teamName,
        mode: 'original-runtime',
        projectPath: authority.projectPath,
        expiresAt: this.ports.now() + (this.ports.lifetimeMs ?? 30 * 60_000),
      };
      this.scopes.set(choice.scopeId, {
        choice,
        intentId: request.intentId,
        authority,
        effects: new Map(),
        readsInFlight: 0,
      });
      this.rebindings.set(request.scopeId, { signature: signature(request), choice });
      while (this.rebindings.size > 128)
        this.rebindings.delete(this.rebindings.keys().next().value!);
      retained = true;
      return { ok: true, action: 'rebind', value: { ...choice } };
    } finally {
      if (!retained)
        await this.disposeCandidate(authority, scope.choice.teamName, request.intentId);
    }
  }

  /** The caller must use the SAME physical source key captured for open(). */
  async import<T>(sourceKey: string, operation: () => Promise<T>): Promise<T> {
    return this.exclusive(sourceKey, async () => {
      if (this.candidateDebts.has(sourceKey))
        throw new RetainedLegacyLaunchRefusal('outcome-unknown');
      for (const scope of this.scopes.values()) {
        if (scope.authority.sourceKey !== sourceKey) continue;
        if (
          scope.effects.size ||
          scope.disposalUnknown ||
          scope.choice.expiresAt > this.ports.now()
        )
          throw new RetainedLegacyLaunchRefusal('busy');
        await this.closeScope(scope);
      }
      return operation();
    });
  }

  async request(
    request: RetainedLegacyLaunchRequest,
    capture = this.ports.capture,
    capturedSourceKey?: string
  ): Promise<RetainedLegacyLaunchResult> {
    let pending: PendingChoice | undefined;
    try {
      if (this.sealed) throw new RetainedLegacyLaunchRefusal('unavailable');
      if (request.action === 'closeIntent')
        return await this.closeIntent(request.teamName, request.intentId);
      if (request.action === 'open') {
        if (
          [...this.candidateDebts.values()]
            .flat()
            .some((debt) => debt.teamName === request.teamName)
        )
          throw new RetainedLegacyLaunchRefusal('outcome-unknown');
        pending = this.beginChoice(request.teamName, request.intentId);
        await this.reclaimExpiredChoices();
        // Main supplies the synchronously captured physical source before any runtime allocation.
        if (capturedSourceKey)
          return await this.exclusive(capturedSourceKey, async () => {
            if (this.candidateDebts.has(capturedSourceKey))
              throw new RetainedLegacyLaunchRefusal('outcome-unknown');
            const authority = await capture(request.teamName);
            return this.retainOpen(authority, request, pending!, capturedSourceKey);
          });
        const authority = await capture(request.teamName);
        let entered = false;
        try {
          return await this.exclusive(authority.sourceKey, async () => {
            entered = true;
            return this.retainOpen(authority, request, pending!, authority.sourceKey);
          });
        } finally {
          // Only shutdown can refuse before entering; the sealed owner admits no more effects.
          if (!entered) await this.disposeCandidate(authority, request.teamName, request.intentId);
        }
      }
      if (request.action === 'rebind') {
        const replay = this.replayRebind(request);
        if (replay) return replay;
      }
      const scope = this.scopes.get(request.scopeId);
      if (!scope) throw new RetainedLegacyLaunchRefusal('unavailable');
      if (request.action === 'cancelModels') {
        // Stop only: the private client's own request group cannot resolve or target another runtime.
        const value = await scope.authority.cancelModels(request);
        return { ok: true, action: 'cancelModels', value };
      }
      if (request.action === 'rebind' && scope.readsInFlight)
        throw new RetainedLegacyLaunchRefusal('busy');
      if (request.action === 'rebind')
        pending = this.beginChoice(scope.choice.teamName, request.intentId);
      const read = !['close', 'rebind', 'roster', 'launch'].includes(request.action);
      if (read) scope.readsInFlight++;
      try {
        return await this.exclusive(scope.authority.sourceKey, async () => {
          if (request.action === 'rebind') {
            const replay = this.replayRebind(request);
            if (replay) return replay;
          }
          if (this.scopes.get(request.scopeId) !== scope)
            throw new RetainedLegacyLaunchRefusal('unavailable');
          if (request.action === 'rebind') return this.rebind(scope, request, capture, pending!);
          if (request.action === 'close') {
            // An uncertain mutation keeps its reservation. Closing a dialog cannot certify absence.
            if ([...scope.effects.values()].some((effect) => !effect.result?.ok))
              throw new RetainedLegacyLaunchRefusal('outcome-unknown');
            await this.closeScope(scope);
            return { ok: true, action: 'close', value: null };
          }
          this.assertCurrent(scope);
          if (request.action === 'launch' && request.request.teamName !== scope.choice.teamName)
            throw new RetainedLegacyLaunchRefusal('source-changed');
          if (request.action === 'roster' || request.action === 'launch') {
            const original = scope.effects.get(request.action);
            const nextSignature = signature(request);
            if (original) {
              if (original.signature !== nextSignature)
                throw new RetainedLegacyLaunchRefusal('intent-changed');
              return (
                original.result ?? { ok: false, reason: 'outcome-unknown', outcome: 'unknown' }
              );
            }
            if (request.action === 'launch' && !scope.effects.get('roster')?.result?.ok)
              throw new RetainedLegacyLaunchRefusal('not-eligible');
            if (request.action === 'roster' && scope.effects.has('launch'))
              throw new RetainedLegacyLaunchRefusal('intent-changed');
            await this.assertAbsent(scope.authority);
            this.assertCurrent(scope);
            // Consume before the first effect await. A failed/lost response never permits a second dispatch.
            const effect: Effect = { signature: nextSignature };
            scope.effects.set(request.action, effect);
            try {
              const value = await scope.authority.run(request);
              this.assertCurrent(scope);
              const result = {
                ok: true,
                action: request.action,
                value,
              } as RetainedLegacyLaunchResult;
              effect.result = result;
              return result;
            } catch {
              return { ok: false, reason: 'outcome-unknown', outcome: 'unknown' };
            }
          }
          await this.assertAbsent(scope.authority);
          this.assertCurrent(scope);
          let value: RetainedLegacyLaunchValueMap[OperationRequest['action']];
          try {
            value = await scope.authority.run(request);
          } catch (error) {
            scope.readFailureUnknown = true;
            throw error;
          }
          this.assertCurrent(scope);
          return { ok: true, action: request.action, value } as RetainedLegacyLaunchResult;
        });
      } finally {
        if (read) scope.readsInFlight--;
      }
    } catch (error) {
      const reason = error instanceof RetainedLegacyLaunchRefusal ? error.reason : 'unavailable';
      return {
        ok: false,
        reason,
        outcome: reason === 'outcome-unknown' ? 'unknown' : 'not-dispatched',
      };
    } finally {
      pending?.finish();
    }
  }

  async shutdown(): Promise<void> {
    this.sealed = true;
    await Promise.allSettled([...this.tails.values()]);
    await Promise.allSettled([...this.scopes.values()].map((scope) => scope.authority.close()));
    await Promise.allSettled(
      [...this.candidateDebts.values()].flat().map((debt) => debt.authority.close())
    );
    this.scopes.clear();
    this.rebindings.clear();
    this.closedIntents.clear();
    this.candidateDebts.clear();
  }
}
