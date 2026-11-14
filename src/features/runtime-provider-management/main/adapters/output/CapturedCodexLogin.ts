import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { BackendRoutingError } from '@features/agent-backend/main';

import { managementValue } from './capturedManagementCatalog';

import type {
  CodexAuthIntent,
  CodexAuthIntentStore,
} from '../../infrastructure/FileCodexAuthIntentStore';
import type { CapturedCodexTarget } from './capturedCodexMetadata';
import type { ProviderOAuthSnapshot } from '@agent-teams/legacy-agent-host/management/contracts';
import type { CapturedProviderManagement } from '@features/agent-backend/main';
import type { CodexChatgptLoginMode, CodexLoginStateDto } from '@features/codex-account/contracts';

const unavailable = 'Unable to confirm the original Codex sign-in. No new login was started.';
const rejected = 'Codex did not complete sign-in. You can try signing in again.';
const idle = (): CodexLoginStateDto => ({ status: 'idle', error: null, startedAt: null });
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(unavailable);
  return value as Record<string, unknown>;
};
const terminal = (phase: ProviderOAuthSnapshot['phase']) =>
  ['completed', 'cancelled', 'failed', 'held'].includes(phase);

interface Login {
  intent: CodexAuthIntent;
  target: CapturedProviderManagement;
  presentationTarget: CapturedProviderManagement;
  state: CodexLoginStateDto;
  receipt?: ProviderOAuthSnapshot;
  settled: boolean;
  observing?: boolean;
  retirement?: { state: CodexLoginStateDto; pending?: Promise<void> };
}

/** Private original intent and UI observation; the Host alone owns native login/completion. */
export class CapturedCodexLogin {
  private active?: Login;
  private admission?: Promise<void>;
  private recovery?: Promise<void>;
  private reconciling?: Promise<void>;
  private readonly abort = new AbortController();

  constructor(
    private readonly intents: CodexAuthIntentStore,
    private readonly restore: (
      targetId: string,
      contextId: string
    ) => Promise<CapturedProviderManagement>,
    private readonly changed: (target: CapturedProviderManagement, terminal: boolean) => void
  ) {}

  state(target: CapturedProviderManagement): CodexLoginStateDto {
    return this.active?.intent.targetId === target.targetId && target.isCurrent()
      ? { ...this.active.state }
      : idle();
  }

  async observe(target: CapturedProviderManagement): Promise<void> {
    this.abort.signal.throwIfAborted();
    const recovered = this.recovery !== undefined;
    await this.ensureRecovered();
    if (this.active?.intent.targetId === target.targetId && target.isCurrent())
      this.active.presentationTarget = target;
    const entry = this.active;
    if (recovered && entry?.retirement) {
      try {
        await this.retire(entry);
      } catch {
        this.fail(entry);
      }
      return;
    }
    if (
      recovered &&
      entry &&
      !entry.settled &&
      !entry.observing &&
      entry.state.status === 'failed'
    ) {
      this.reconciling ??= this.reconcile(entry);
      try {
        await this.reconciling;
      } finally {
        this.reconciling = undefined;
      }
    }
  }

  private async ensureRecovered(): Promise<void> {
    const pending = (this.recovery ??= this.recover());
    try {
      await pending;
    } catch (error) {
      if (this.recovery === pending) this.recovery = undefined;
      throw error;
    }
  }

  private async reconcile(entry: Login): Promise<void> {
    try {
      await this.accept(
        entry,
        await entry.target.request('oauth.read', { operationId: entry.intent.commandId })
      );
      if (!entry.settled) void this.watch(entry);
    } catch {
      this.fail(entry);
    }
  }

  private async recover(): Promise<void> {
    const intent = await this.intents.pendingLogin();
    if (!intent) return;
    // A legacy/incomplete login row has no authority to borrow the current context.
    if (!intent.contextId)
      throw new Error(
        'The original Codex sign-in context is unavailable; its intent was retained.'
      );
    const target = await this.restore(intent.targetId, intent.contextId);
    if (target.targetId !== intent.targetId) throw new Error(unavailable);
    const entry: Login = {
      intent,
      target,
      presentationTarget: target,
      settled: false,
      state: { status: 'starting', error: null, startedAt: null },
    };
    this.active = entry;
    // Recovery is lookup only, including a missing/held receipt. Never replay oauth.start.
    try {
      await this.accept(
        entry,
        await target.request('oauth.read', { operationId: intent.commandId })
      );
      if (!entry.settled) void this.watch(entry);
    } catch {
      this.fail(entry);
    }
  }

  async start(target: CapturedCodexTarget, mode: CodexChatgptLoginMode): Promise<void> {
    if (!['browser', 'device_code'].includes(mode)) throw new Error('Invalid Codex sign-in mode.');
    const before = this.active;
    const recovering = before?.retirement || (before?.state.status === 'failed' && !before.settled);
    await this.observe(target);
    if ((this.active && this.active !== before) || recovering) return;
    if (this.admission) return this.admission;
    const pending = this.admit(target, mode);
    this.admission = pending;
    try {
      await pending;
    } finally {
      if (this.admission === pending) this.admission = undefined;
    }
  }

  private async admit(target: CapturedCodexTarget, mode: CodexChatgptLoginMode): Promise<void> {
    const previous = this.active;
    if (previous && !previous.settled) {
      if (previous.intent.targetId !== target.targetId) throw new Error(unavailable);
      return; // A second click, including another mode, observes the original login.
    }
    if (
      !target.isCurrent() ||
      !target.originalContextId ||
      (await this.intents.pendingLogin()) ||
      (await this.intents.read(target.targetId))
    )
      throw new Error(unavailable);
    const intent: CodexAuthIntent = {
      schemaVersion: 1,
      targetId: target.targetId,
      contextId: target.originalContextId,
      commandId: 'codex-auth-' + randomUUID(),
      kind: `login.${mode}`,
    };
    if (!(await this.intents.create(intent))) throw new Error(unavailable);
    const entry: Login = {
      intent,
      target,
      presentationTarget: target,
      settled: false,
      state: { status: 'starting', error: null, startedAt: new Date().toISOString() },
    };
    this.active = entry;
    this.notify(entry, false);
    try {
      const result = await target.request('oauth.start', {
        operationId: intent.commandId,
        providerId: 'codex',
        methodIndex: mode === 'browser' ? 0 : 1,
      });
      const reply = object(result);
      if (
        reply.ok === false &&
        ['busy', 'invalid', 'conflict'].includes(String(reply.code)) &&
        Object.keys(reply).length === 2
      ) {
        await this.settle(entry, {
          status: 'failed',
          error: unavailable,
          startedAt: entry.state.startedAt,
        });
        return;
      }
      await this.accept(entry, result);
      if (!entry.settled) void this.watch(entry);
    } catch (error) {
      if (error instanceof BackendRoutingError && error.outcome === 'not-dispatched') {
        try {
          await this.settle(entry, {
            status: 'failed',
            error: unavailable,
            startedAt: entry.state.startedAt,
          });
          return;
        } catch {
          // No native receipt exists. A later observation retries only the original local retirement.
        }
      }
      // An unknown dispatch remains available to cancel/read with the original ID.
      this.fail(entry);
    }
  }

  private decode(entry: Login, raw: unknown): ProviderOAuthSnapshot {
    const value = object(managementValue(raw));
    if (
      value.operationId !== entry.intent.commandId ||
      value.providerId !== 'codex' ||
      value.profileId !== entry.target.profileId ||
      value.configRevision !== entry.target.configRevision ||
      value.methodIndex !== (entry.intent.kind === 'login.browser' ? 0 : 1) ||
      ![
        'authorizing',
        'waiting-for-browser',
        'completing',
        'cancelling',
        'completed',
        'cancelled',
        'failed',
        'held',
      ].includes(String(value.phase)) ||
      (value.phase === 'failed' && value.reason !== 'native-rejected') ||
      ![null, 'auto'].includes(value.completionMethod as 'auto' | null) ||
      !Number.isSafeInteger(value.sequence) ||
      Number(value.sequence) < 1 ||
      !Number.isSafeInteger(value.expiresAt) ||
      Number(value.expiresAt) < 1 ||
      Object.keys(value).some(
        (key) =>
          ![
            'operationId',
            'providerId',
            'profileId',
            'configRevision',
            'methodIndex',
            'phase',
            'completionMethod',
            'sequence',
            'expiresAt',
            'reason',
          ].includes(key)
      )
    )
      throw new Error(unavailable);
    return value as unknown as ProviderOAuthSnapshot;
  }

  private async accept(entry: Login, raw: unknown): Promise<void> {
    const receipt = this.decode(entry, raw);
    if (entry.receipt && receipt.sequence < entry.receipt.sequence) return;
    if (entry.receipt?.sequence === receipt.sequence && entry.receipt.phase !== receipt.phase)
      throw new Error(unavailable);
    if (entry.receipt?.sequence === receipt.sequence && entry.settled && !entry.retirement) return;
    const previous = entry.receipt?.sequence;
    entry.receipt = receipt;
    if (terminal(receipt.phase)) {
      const state: CodexLoginStateDto = {
        status:
          receipt.phase === 'completed'
            ? 'idle'
            : receipt.phase === 'cancelled'
              ? 'cancelled'
              : 'failed',
        error:
          receipt.phase === 'held' ? unavailable : receipt.phase === 'failed' ? rejected : null,
        startedAt: entry.state.startedAt,
      };
      if (receipt.phase !== 'held') {
        await this.settle(entry, state);
        return;
      }
      entry.state = state;
      entry.settled = true;
    } else {
      entry.state = {
        ...entry.state,
        status: receipt.phase === 'authorizing' ? 'starting' : 'pending',
        error: null,
      };
    }
    if (previous !== receipt.sequence) this.notify(entry, terminal(receipt.phase));
  }

  private settle(entry: Login, state: CodexLoginStateDto): Promise<void> {
    entry.settled = true; // The known native outcome must never be dispatched again.
    entry.state = state;
    entry.retirement ??= { state };
    return this.retire(entry);
  }

  private async retire(entry: Login): Promise<void> {
    const retirement = entry.retirement;
    if (!retirement) return;
    if (retirement.pending) return retirement.pending;
    const pending = this.intents.retire(entry.intent).then(() => {
      if (entry.retirement !== retirement) return;
      entry.retirement = undefined;
      entry.state = retirement.state;
      this.notify(entry, true);
    });
    retirement.pending = pending;
    try {
      await pending;
    } finally {
      if (retirement.pending === pending) retirement.pending = undefined;
    }
  }

  private async authorization(entry: Login): Promise<void> {
    if (entry.state.authUrl || entry.receipt?.phase !== 'waiting-for-browser') return;
    const target = entry.presentationTarget;
    if (!target.isCurrent()) return;
    const raw = managementValue(
      await target.request('oauth.authorization', { operationId: entry.intent.commandId })
    );
    if (raw === null) return; // Completion/cancel may have won before this private read.
    const value = object(raw);
    if (typeof value.authorizationUrl !== 'string' || value.authorizationUrl.length > 16384)
      throw new Error(unavailable);
    const url = new URL(value.authorizationUrl);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error(unavailable);
    const code = value.userCode;
    if (
      entry.intent.kind === 'login.device_code' &&
      (typeof code !== 'string' ||
        !code.trim() ||
        code.length > 256 ||
        Array.from(code).some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
        ))
    )
      throw new Error(unavailable);
    if (!target.isCurrent() || entry.settled) return;
    entry.state = {
      ...entry.state,
      authUrl: url.href,
      userCode: typeof code === 'string' ? code : null,
    };
    this.notify(entry, false); // Existing UI owns explicit open/copy; observation never opens a browser.
  }

  private async watch(entry: Login): Promise<void> {
    if (entry.observing) return;
    entry.observing = true;
    try {
      while (!entry.settled && !this.abort.signal.aborted) {
        await this.authorization(entry);
        await delay(250, undefined, { signal: this.abort.signal, ref: false });
        if (entry.settled) break;
        await this.accept(
          entry,
          await entry.target.request('oauth.read', { operationId: entry.intent.commandId })
        );
      }
    } catch {
      if (!this.abort.signal.aborted) this.fail(entry);
    } finally {
      entry.observing = false;
    }
  }

  private fail(entry: Login): void {
    entry.state = { status: 'failed', error: unavailable, startedAt: entry.state.startedAt };
    this.notify(entry, false);
  }

  private notify(entry: Login, completed: boolean): void {
    if (this.active !== entry || this.abort.signal.aborted) return;
    try {
      this.changed(entry.presentationTarget, completed);
    } catch {
      /* Presentation cannot alter native ownership. */
    }
  }

  async cancel(): Promise<void> {
    const recovered = this.recovery !== undefined;
    await this.ensureRecovered();
    await this.admission;
    const entry = this.active;
    if (entry?.retirement) {
      if (recovered) {
        try {
          await this.retire(entry);
        } catch {
          this.fail(entry);
        }
      }
      return;
    }
    if (!entry || entry.settled) return;
    try {
      await this.accept(
        entry,
        await entry.target.request('oauth.cancel', { operationId: entry.intent.commandId })
      );
    } catch {
      this.fail(entry);
    }
  }

  async dispose(): Promise<void> {
    if (this.abort.signal.aborted) return;
    try {
      await this.cancel();
    } finally {
      this.abort.abort();
    }
  }
}
