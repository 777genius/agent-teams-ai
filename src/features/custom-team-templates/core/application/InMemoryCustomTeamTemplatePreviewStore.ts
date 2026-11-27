import type { CustomTeamTemplateSourceAdmission } from './ports';

/**
 * Bounded in-memory store for prepared previews.
 *
 * Preview state is deliberately never persisted: it is a short-lived handshake
 * between a preview the user reviewed and the save that confirms it. The store
 * is the only place that knows the source team, the stable template id and the
 * canonical projection behind a token, so a caller can never assert any of
 * those independently.
 *
 * Expiration is explicit, entries are evicted oldest-first once the capacity is
 * reached, and expired entries are dropped on access. Clocks and token
 * generation are injected so this module stays environment-free.
 */
export const DEFAULT_CUSTOM_TEMPLATE_PREVIEW_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_CUSTOM_TEMPLATE_PREVIEW_CAPACITY = 32;

/** Bounded attempts used to avoid ever reusing a live token. */
const TOKEN_COLLISION_ATTEMPTS = 8;

/** Every retained operation may still commit; new previews must not destroy its re-check token. */
export class CustomTemplatePreviewCapacityError extends Error {}

export interface CustomTeamTemplatePreviewStateInput {
  /** Team the projection was read from; a token can never be re-pointed at another team. */
  sourceTeamName: string;
  /** Original trusted owner/context; equal portable content cannot replace this source. */
  sourceAdmission?: CustomTeamTemplateSourceAdmission;
  /** Stable id shared by the confirmed create and every retry of it. */
  templateId: string;
  /** Validated display name, capitalization preserved. */
  name: string;
  /** Uniqueness key for `name`; display capitalization is never identity. */
  nameKey: string;
  description?: string;
  /** Exact canonical serialization that a confirm-save must reproduce. */
  canonicalContent: string;
  contentHash: string;
}

export interface CustomTeamTemplatePreviewState extends CustomTeamTemplatePreviewStateInput {
  token: string;
  createdAtMs: number;
  expiresAtMs: number;
  /**
   * Frozen identity of the save operation this token confirmed, once any.
   *
   * Set by the first successful `confirmSave` and never changed afterwards:
   * the reviewed preview fields above are rewritten to match it (so a later
   * re-check reconciles the operation that was actually attempted), while this
   * record is what lets the store reject a different identity for the same
   * token.
   */
  confirmedSave?: CustomTeamTemplateConfirmedSaveIdentity;
  /**
   * True when a previous save attempt for this token returned
   * `unresolvedWriteOutcome` and no later attempt has established a definitive
   * outcome. While set, a subsequent `not_started` failure must not be
   * reported as definitively not saved, because the earlier writer may still
   * commit. Cleared when a save or re-check establishes a definitive outcome.
   */
  hasUnresolvedWrite?: boolean;
}

/**
 * Identity a confirm-save resolved for its retained operation.
 *
 * A confirmed save may legitimately change the display name or description
 * before writing, so the retained operation must describe the identity that was
 * actually attempted. Recording it here is what lets a later re-check reconcile
 * the very same operation instead of a fresh one.
 */
export interface CustomTeamTemplateConfirmedSaveIdentity {
  templateId: string;
  name: string;
  nameKey: string;
  description?: string;
}

/**
 * Outcome of binding one identity to a live token.
 *
 * `recorded` is the first confirmation, which freezes the operation identity;
 * `alreadyRecorded` is the safe exact-identity retry of the same idempotent
 * create; `identityMismatch` means a write may already have been dispatched
 * under the original identity, so this request must be rejected instead of
 * rebinding the token; `unavailable` means the token no longer retains a
 * preview (never issued, expired or invalidated).
 */
export type CustomTeamTemplateConfirmSaveOutcome =
  | { status: 'recorded' }
  | { status: 'alreadyRecorded' }
  | { status: 'identityMismatch'; recorded: CustomTeamTemplateConfirmedSaveIdentity }
  | { status: 'unavailable' };

/** Exact identity equality; display identity is frozen field by field. */
function isSameConfirmedSaveIdentity(
  left: CustomTeamTemplateConfirmedSaveIdentity,
  right: CustomTeamTemplateConfirmedSaveIdentity
): boolean {
  return (
    left.templateId === right.templateId &&
    left.name === right.name &&
    left.nameKey === right.nameKey &&
    (left.description ?? null) === (right.description ?? null)
  );
}

/**
 * Token resolution outcomes.
 *
 * `unknown` and `expired` are distinct so a caller can tell a token that was
 * never issued (or was already replaced by a refreshed preview) from one that
 * simply aged out. Neither is ever reinterpreted as another team's preview.
 *
 * When `status === 'expired'` and `state` is present, the token had a confirmed
 * save before expiring. The `state.confirmedSave` is preserved for re-check,
 * but the preview data is no longer valid for new saves.
 */
export type CustomTeamTemplatePreviewResolution =
  | { status: 'found'; state: CustomTeamTemplatePreviewState }
  | { status: 'unknown' }
  | { status: 'expired'; state?: CustomTeamTemplatePreviewState };

export interface InMemoryCustomTeamTemplatePreviewStoreOptions {
  now(): number;
  /** Must not repeat values; composition injects `randomUUID`. */
  createToken(): string;
  ttlMs?: number;
  capacity?: number;
}

export class InMemoryCustomTeamTemplatePreviewStore {
  private readonly entries = new Map<string, CustomTeamTemplatePreviewState>();
  /** Only one confirmation may dispatch a write for a token at a time. */
  private readonly inFlightSaves = new Set<string>();
  /** A failed worker can settle after the bounded save wait has timed out. */
  private readonly unsettledWriters = new Map<string, Set<Promise<void>>>();
  private readonly trackedWriterTokens = new Set<string>();
  private readonly ttlMs: number;
  private readonly capacity: number;

  constructor(private readonly options: InMemoryCustomTeamTemplatePreviewStoreOptions) {
    this.ttlMs = options.ttlMs ?? DEFAULT_CUSTOM_TEMPLATE_PREVIEW_TTL_MS;
    this.capacity = options.capacity ?? DEFAULT_CUSTOM_TEMPLATE_PREVIEW_CAPACITY;
    if (!Number.isInteger(this.capacity) || this.capacity < 1)
      throw new RangeError('Invalid preview capacity');
  }

  /** Retains one preview and returns the state (including its opaque token). */
  issue(input: CustomTeamTemplatePreviewStateInput): CustomTeamTemplatePreviewState {
    const createdAtMs = this.options.now();
    this.dropExpired(createdAtMs);
    while (this.entries.size >= this.capacity) {
      // Settled submissions no longer need a re-check token. Never evict an
      // unresolved operation, even if it has expired or is the oldest entry.
      const entries = [...this.entries];
      const candidate =
        entries.find(
          ([token, state]) =>
            state.confirmedSave && !state.hasUnresolvedWrite && !this.inFlightSaves.has(token)
        ) ??
        entries.find(([token, state]) => !state.confirmedSave && !this.inFlightSaves.has(token));
      if (!candidate) {
        throw new CustomTemplatePreviewCapacityError('All retained template saves are unresolved');
      }
      this.entries.delete(candidate[0]);
    }

    const token = this.allocateToken();
    const state: CustomTeamTemplatePreviewState = {
      ...input,
      token,
      createdAtMs,
      expiresAtMs: createdAtMs + this.ttlMs,
    };
    this.entries.set(token, state);
    return state;
  }

  /** Resolves a token, dropping it when it has expired. */
  resolve(token: string): CustomTeamTemplatePreviewResolution {
    const state = this.entries.get(token);
    if (!state) {
      return { status: 'unknown' };
    }
    if (state.expiresAtMs <= this.options.now()) {
      if (state.confirmedSave) {
        // Preserve the confirmed save identity for re-check, but mark as expired
        // so no new save can be confirmed against this preview.
        return { status: 'expired', state: { ...state, confirmedSave: state.confirmedSave } };
      }
      this.entries.delete(token);
      return { status: 'expired' };
    }
    return { status: 'found', state };
  }

  /**
   * Records the identity a confirm-save resolved for one live token.
   *
   * The first successful call freezes the operation identity: the reviewed
   * preview fields are rewritten to describe the attempted write (so a later
   * re-check reconciles that exact operation), and every later call for the
   * same token is answered from the frozen record instead of rebinding it. A
   * write may already have been dispatched under the recorded identity, so a
   * different identity is rejected (`identityMismatch`) and a missing, expired
   * or invalidated token is reported as `unavailable`; neither ever creates
   * another template. Only the display identity and the derived stable id
   * change here: the reviewed canonical content and its digest are fixed by
   * the preview itself.
   */
  confirmSave(
    token: string,
    identity: CustomTeamTemplateConfirmedSaveIdentity
  ): CustomTeamTemplateConfirmSaveOutcome {
    const state = this.entries.get(token);
    if (!state || state.expiresAtMs <= this.options.now()) {
      return { status: 'unavailable' };
    }
    const recorded = state.confirmedSave;
    if (recorded) {
      return isSameConfirmedSaveIdentity(recorded, identity)
        ? { status: 'alreadyRecorded' }
        : { status: 'identityMismatch', recorded };
    }
    this.entries.set(token, {
      ...state,
      templateId: identity.templateId,
      name: identity.name,
      nameKey: identity.nameKey,
      description: identity.description,
      confirmedSave: {
        templateId: identity.templateId,
        name: identity.name,
        nameKey: identity.nameKey,
        ...(identity.description === undefined ? {} : { description: identity.description }),
      },
    });
    return { status: 'recorded' };
  }

  /**
   * Forgets one token for new saves, but preserves confirmed save identity.
   *
   * Used when the confirmed projection no longer matches the source: the old
   * token must not be able to save the refreshed data, so the next attempt has
   * to start from a fresh preview. However, if a save was already confirmed
   * for this token, its operation identity is preserved so re-check can still
   * reconcile the operation that was actually attempted.
   */
  invalidate(token: string): void {
    const state = this.entries.get(token);
    if (state?.confirmedSave) {
      // Preserve the full submitted-operation state for re-check. New saves
      // remain blocked: SaveUseCase re-reads the source and rejects a changed
      // projection as stale, and confirmSave rejects a rebound identity.
      // Clearing contentHash here would break re-check reconciliation, so the
      // entry is kept intact.
      return;
    }
    this.entries.delete(token);
  }

  /**
   * Marks a token's operation as having an unresolved write outcome.
   *
   * Called when a save returns `unresolvedWriteOutcome`: a later `not_started`
   * failure must not clear that uncertainty, because the earlier writer may
   * still commit. The flag is cleared when a save or re-check establishes a
   * definitive outcome.
   */
  /** Atomically fences a save against concurrent confirmations and unresolved writers. */
  tryBeginSave(token: string): boolean {
    if (
      !this.entries.has(token) ||
      this.inFlightSaves.has(token) ||
      this.hasUnresolvedWrite(token)
    ) {
      return false;
    }
    this.inFlightSaves.add(token);
    return true;
  }

  finishSave(token: string): void {
    this.inFlightSaves.delete(token);
  }

  isSaveInFlight(token: string): boolean {
    return this.inFlightSaves.has(token);
  }

  markUnresolvedWrite(token: string, settled?: Promise<void>): void {
    const state = this.entries.get(token);
    if (!state) return;
    this.entries.set(token, { ...state, hasUnresolvedWrite: true });
    if (!settled) return;
    this.trackedWriterTokens.add(token);
    const pending = this.unsettledWriters.get(token) ?? new Set<Promise<void>>();
    pending.add(settled);
    this.unsettledWriters.set(token, pending);
    const onSettled = (): void => {
      const active = this.unsettledWriters.get(token);
      active?.delete(settled);
      if (active?.size === 0) this.unsettledWriters.delete(token);
    };
    // Rejection also signals the worker has stopped; consume it to avoid
    // an unhandled rejection after the bounded wait has already returned.
    void settled.then(onSettled, onSettled);
  }

  /** Absence is authoritative only after every previously unknown writer exited. */
  canConfirmAbsenceAfterUnresolvedWrite(token: string): boolean {
    return this.trackedWriterTokens.has(token) && !this.unsettledWriters.has(token);
  }

  /** Clears a previously marked unresolved write once the outcome is definitive. */
  clearUnresolvedWrite(token: string): void {
    this.unsettledWriters.delete(token);
    this.trackedWriterTokens.delete(token);
    const state = this.entries.get(token);
    if (state?.hasUnresolvedWrite) {
      const { hasUnresolvedWrite: _removed, ...rest } = state;
      this.entries.set(token, rest);
    }
  }

  /** Whether a previous save for this token left an unresolved write. */
  hasUnresolvedWrite(token: string): boolean {
    return this.entries.get(token)?.hasUnresolvedWrite === true;
  }

  /** Drops every retained preview and confirmed operation (used on shutdown). */
  clear(): void {
    this.entries.clear();
    this.inFlightSaves.clear();
    this.unsettledWriters.clear();
    this.trackedWriterTokens.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private dropExpired(nowMs: number): void {
    for (const [token, state] of this.entries) {
      if (state.expiresAtMs <= nowMs) {
        // A submitted operation whose outcome is still unresolved must survive
        // expiry so re-check can reconcile it. Once the outcome is settled the
        // entry is dropped, so it stops occupying capacity: re-check already
        // reported the definitive result and will not be offered again.
        if (this.inFlightSaves.has(token) || (state.confirmedSave && state.hasUnresolvedWrite)) {
          continue;
        }
        this.entries.delete(token);
      }
    }
  }

  private allocateToken(): string {
    for (let attempt = 0; attempt < TOKEN_COLLISION_ATTEMPTS; attempt++) {
      const token = this.options.createToken();
      if (!this.entries.has(token)) {
        return token;
      }
    }
    // Never silently re-point an existing token at a different preview.
    throw new Error('custom team template preview token generation is not unique');
  }
}
