import { randomUUID } from 'node:crypto';
import { FileRuntimeStore } from '../adapters/runtime/FileRuntimeStore.js';
import { TeamOwnerStore } from '../adapters/team/TeamOwnerStore.js';
import { createScheduledRunProvider } from '../adapters/providers/ScheduledRunProvider.js';
import { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import { RuntimeOwnerError } from '../runtime/contracts.js';
import { runtimeDigest } from '../runtime/identity.js';
import { effectId } from '../team/identity.js';
import { capturedMcpSourceCurrent } from '../mcp-catalog/capturedSource.js';
import { captureRuntimeMcp } from './captureRuntimeMcp.js';
import { captureScheduledProcessOrigin } from './captureRuntimeProcessOrigin.js';
import { createCapturedClaudeSubagents } from './createClaudeSubagents.js';
import { loadCapturedRuntimeMcpRecipe, prepareCapturedRuntimeMcpRecipes } from './capturedRuntimeMcpRecipes.js';
import { scheduledRunInputSchema } from './scheduledRunContracts.js';
import { captureScheduledRun, readScheduledRunCapture, scheduledRunIdentity, scheduledRunProfile } from './scheduledRunCapture.js';
import { projectScheduledRun } from './scheduledRunProjection.js';
import type { ScheduledRunSelection } from './scheduledRunCapture.js';
import type { ScheduledRunSnapshot } from './scheduledRunContracts.js';
import type { ScheduledRunProvider, ScheduledRunProviderContext } from '../adapters/providers/ScheduledRunProvider.js';
import type { TeamHostProfile } from './TeamHost.js';
import type { HostedTeam } from './MemberEntry.js';
import type { RuntimeRecipeSources } from './runtimeSourceContracts.js';
import type { ProcessCustody } from './processCustody.js';
import type { RuntimeBinding } from '../runtime/contracts.js';
import type { HostWindowsLaunch } from '../owned-process/HostWindowsLaunch.js';

interface ActiveRun extends ScheduledRunSelection {
  cancelled: boolean;
  running: boolean;
  cleanupConfirmed?: boolean;
  pending?: Promise<void>;
  wake?: () => void;
  provider?: ScheduledRunProvider;
}

/** Scheduling policy stays in Main. This composition uses the existing Runtime effect ledger. */
export class HostScheduledRuns {
  private readonly runtime: RuntimeOwner;
  private readonly store: FileRuntimeStore;
  private readonly active = new Map<string, ActiveRun>();
  private readonly selected = new Map<string, ScheduledRunSelection>();
  private sealed = false;

  constructor(private readonly options: {
    profile: TeamHostProfile;
    sources?: RuntimeRecipeSources;
    assertWriter(): void;
    processCustody?: ProcessCustody;
    retainedWindowsLaunch?: HostWindowsLaunch;
    /** Controlled Session test seam; ordinary Host composition always selects real D. */
    createProvider?(context: ScheduledRunProviderContext): ScheduledRunProvider;
  }) {
    const store = this.store = new FileRuntimeStore(options.profile.owner.storageRoot);
    this.runtime = new RuntimeOwner({ store, events: store, profileId: options.profile.owner.profileId,
      hostIncarnation: randomUUID(), maxQueuedInputs: 1, maxInputBytes: 64 * 1024,
      driverFactory: { open: async request => {
        const entries = [...this.active.values()].filter(entry => runtimeDigest(entry.config) === runtimeDigest(request));
        const entry = entries[0];
        if (entries.length !== 1 || !entry) throw new RuntimeOwnerError('hold');
        const current = () => this.current(entry);
        this.assert(entry);
        const base = scheduledRunProfile(options.profile, entry.team, entry.capture, options.sources);
        const processOrigin = captureScheduledProcessOrigin(options.profile, entry.team, entry.capture, options.sources);
        const selected = captureRuntimeMcp({ recipes: [base], savedCwd: base.cwd,
          members: [{ role: 'lead', settings: {} }] });
        const [reference] = await prepareCapturedRuntimeMcpRecipes({ store: entry.store,
          commandId: entry.capture.input.runId, baseRecipes: [base], selectedRecipes: selected,
          ...(options.retainedWindowsLaunch ? { retainedWindowsLaunch: options.retainedWindowsLaunch } : {}),
          processOrigin: () => processOrigin,
          assertCurrent: () => this.assert(entry),
          withAuthority: action => entry.team.owner.withLaunchAuthority(options.profile.principalId, 'control', () => {
            this.assert(entry); return action();
          }) });
        if (!reference) throw new RuntimeOwnerError('hold');
        this.assert(entry);
        const profile = loadCapturedRuntimeMcpRecipe(entry.store, entry.capture.input.runId, base, reference);
        if (Buffer.byteLength(entry.capture.input.config.prompt) > profile.limits.inputBytes)
          throw new RuntimeOwnerError('invalid');
        const subagents = createCapturedClaudeSubagents({ profile, binding: entry.binding, isCurrent: current,
          allowsInput: intent => current() && intent.inputId === entry.capture.input.runId,
          readRuntime: binding => this.runtime.readCapturedSession(binding),
          observe: (binding, session, activity) => this.runtime.observeProviderActivity(binding, session, activity) });
        const provider = (options.createProvider ?? createScheduledRunProvider)({ profile, request, binding: entry.binding,
          ...(processOrigin ? { processOrigin } : {}),
          ...(subagents ? { subagents } : {}),
          ...(entry.capture.input.config.disallowedTools !== undefined ?
            { disallowedTools: [...entry.capture.input.config.disallowedTools] } : {}),
          ...(options.processCustody ? { processCustody: options.processCustody } : {}),
          ...(options.retainedWindowsLaunch ? { retainedWindowsLaunch: options.retainedWindowsLaunch } : {}),
          isCurrent: () => current() && capturedMcpSourceCurrent(profile),
          onProgress: () => { setImmediate(() => entry.wake?.()); } });
        entry.provider = provider; // Retain physical custody before awaiting native open/readiness.
        return provider.factory.open(request);
      } },
      authorize: (binding, action) => {
        const entry = this.selected.get(runtimeDigest(binding));
        if (!entry) return false;
        try {
          options.assertWriter();
          entry.team.owner.withLaunchAuthority(options.profile.principalId, action === 'read' ? 'read' : 'control', revision => {
            if (action !== 'read' && (this.sealed || revision !== entry.capture.authorityRevision))
              throw new RuntimeOwnerError('hold');
          });
          return true;
        } catch { return false; }
      },
      canDispatch: binding => {
        const entry = this.active.get(runtimeDigest(binding));
        return !!entry && this.current(entry);
      },
    });
  }

  start(team: HostedTeam, raw: unknown): ScheduledRunSnapshot {
    this.options.assertWriter();
    if (this.sealed) throw new RuntimeOwnerError('hold');
    const input = scheduledRunInputSchema.parse(structuredClone(raw));
    const capture = captureScheduledRun({ profile: this.options.profile, team, input,
      ...(this.options.sources ? { sources: this.options.sources } : {}) });
    const entry = this.select(team, capture.input.runId)!, key = runtimeDigest(entry.binding);
    if (this.active.has(key) || this.runtime.readCapturedSession(entry.binding).record)
      return this.snapshot(entry);
    const running: ActiveRun = { ...entry, cancelled: false, running: true };
    this.active.set(key, running);
    // Publication precedes allocation and makes a concurrent same-ID start a read of this occurrence.
    running.pending = Promise.resolve().then(() => this.execute(running)).finally(() => {
      running.running = false;
      const state = this.runtime.readCapturedSession(running.binding).record;
      if (this.active.get(key) === running && running.cleanupConfirmed && state?.phase === 'closed' && state.custody === 'released')
        this.active.delete(key);
      running.wake?.();
    });
    void running.pending.catch(() => {}); // RPC lookup reports the original Runtime state, never a second run.
    return this.snapshot(entry);
  }

  read(team: HostedTeam, runId: string, scheduleId: string): ScheduledRunSnapshot | null {
    this.options.assertWriter();
    const entry = this.select(team, runId);
    if (entry && entry.capture.input.scheduleId !== scheduleId) throw new RuntimeOwnerError('conflict');
    return entry ? this.snapshot(entry) : null;
  }

  async cancel(team: HostedTeam, runId: string, scheduleId: string): Promise<ScheduledRunSnapshot> {
    this.options.assertWriter();
    team.owner.withLaunchAuthority(this.options.profile.principalId, 'control', () => undefined);
    const entry = this.select(team, runId);
    if (entry && entry.capture.input.scheduleId !== scheduleId) throw new RuntimeOwnerError('conflict');
    const binding = entry?.binding ?? this.binding(team, runId, scheduleId);
    const key = runtimeDigest(binding), active = this.active.get(key);
    if (active) { active.cancelled = true; active.wake?.(); }
    // An unseen cancellation seals the original binding before a delayed start can arrive.
    await this.runtime.stopCapturedSession(binding);
    active?.provider?.seal();
    if (active) await this.confirmCleanup(active);
    await Promise.allSettled([active?.pending]);
    const cleanup = active ? await this.confirmCleanup(active) : true;
    const stopped = await this.runtime.stopCapturedSession(binding);
    const clean = stopped.phase === 'closed' && stopped.custody === 'released';
    if (clean && cleanup && this.active.get(key) === active) this.active.delete(key);
    return entry ? this.snapshot(entry) : { runId, phase: clean ? 'interrupted' : 'held',
      cleanup: clean ? 'confirmed' : 'unresolved' };
  }

  seal(): void {
    this.sealed = true;
    for (const entry of this.active.values()) { entry.cancelled = true; entry.provider?.seal(); entry.wake?.(); }
  }

  async close(): Promise<void> {
    this.seal();
    const entries = [...this.active.values()];
    await Promise.allSettled(entries.map(entry => this.runtime.stopCapturedSession(entry.binding)));
    // The first cleanup releases pending native opens; settlement alone cannot do that.
    await Promise.allSettled(entries.map(entry => this.confirmCleanup(entry)));
    await Promise.allSettled(entries.map(entry => entry.pending));
    const cleanup = await Promise.allSettled(entries.map(entry => this.confirmCleanup(entry)));
    const records = await Promise.all(entries.map(entry => this.runtime.stopCapturedSession(entry.binding)));
    if (cleanup.some(result => result.status === 'rejected' || result.value === false) ||
      records.some(record => record.phase !== 'closed' || record.custody !== 'released'))
      throw new RuntimeOwnerError('hold');
    for (const entry of entries) {
      const key = runtimeDigest(entry.binding);
      if (this.active.get(key) === entry) this.active.delete(key);
    }
  }

  private async confirmCleanup(entry: ActiveRun): Promise<boolean> {
    entry.cleanupConfirmed = false;
    entry.cleanupConfirmed = (await entry.provider?.cleanup()) ?? true;
    return entry.cleanupConfirmed;
  }

  private binding(team: HostedTeam, runId: string, scheduleId: string): RuntimeBinding {
    return { backendId: team.definition.binding.backendId, teamId: team.definition.binding.teamId,
      runId: 'scheduled-standalone', memberId: effectId('scheduled-member', scheduleId), generation: runId };
  }

  private select(team: HostedTeam, runId: string): ScheduledRunSelection | undefined {
    return team.owner.withLaunchAuthority(this.options.profile.principalId, 'read', () => {
      const store = new TeamOwnerStore(this.options.profile.owner.storageRoot, team.definition.binding.teamName),
        capture = readScheduledRunCapture(store, runId);
      if (!capture) return undefined;
      if (capture.teamScope !== runtimeDigest(team.definition.scope)) throw new RuntimeOwnerError('forbidden');
      const entry = { team, store, capture, ...scheduledRunIdentity(this.options.profile, team, capture) };
      this.selected.set(runtimeDigest(entry.binding), entry);
      return entry;
    });
  }

  private snapshot(entry: ScheduledRunSelection): ScheduledRunSnapshot {
    const record = this.runtime.readSession(entry.binding).record;
    const active = this.active.get(runtimeDigest(entry.binding));
    if (active && active.cleanupConfirmed !== true && record?.phase === 'closed')
      return { runId: entry.capture.input.runId, phase: active.running ? 'running' : 'held', cleanup: 'unresolved' };
    return projectScheduledRun(entry.capture, record, this.runtime.readActivitySnapshot(entry.binding),
      active?.running === true);
  }

  private current(entry: ActiveRun): boolean {
    try { this.assert(entry); return true; } catch { return false; }
  }
  private assert(entry: ActiveRun): void {
    this.options.assertWriter();
    if (this.sealed || entry.cancelled) throw new RuntimeOwnerError('hold');
    entry.team.owner.withLaunchAuthority(this.options.profile.principalId, 'control', revision => {
      if (revision !== entry.capture.authorityRevision) throw new RuntimeOwnerError('forbidden');
    });
  }

  private async execute(entry: ActiveRun): Promise<void> {
    try {
      this.assert(entry);
      const prior = this.store.fenced(entry.binding, tx => tx.siblings().find(value =>
        runtimeDigest(value.binding) !== runtimeDigest(entry.binding)));
      // A later cron occurrence is a distinct intent. It still requires every original native owner
      // to be closed/released; it never replays an uncertain input from an earlier occurrence.
      const opened = prior
        ? await this.runtime.openFreshMemberSession({ sourceBinding: prior.binding,
            binding: entry.binding, config: entry.config }, () => this.assert(entry))
        : await this.runtime.openSession({ binding: entry.binding, config: entry.config }, () => this.assert(entry));
      if (opened.phase !== 'allocated' || !opened.nativeReady) return;
      this.assert(entry);
      const inputId = entry.capture.input.runId;
      const admitted = await this.runtime.admitDelivery({ binding: entry.binding, inputId,
        deliveryId: inputId, messageId: inputId, content: entry.capture.input.config.prompt });
      if (admitted.outcome !== 'admitted') return;
      this.assert(entry);
      await this.runtime.dispatchNext(entry.binding);
      for (;;) {
        const state = this.runtime.readCapturedSession(entry.binding).record;
        const input = state?.inputs.find(value => value.intent.inputId === inputId);
        if (!state || !this.current(entry) || state.phase !== 'allocated' ||
          input?.phase !== 'consumed' && input?.phase !== 'claimed' ||
          state.interactions.some(value => value.phase === 'pending') || state.diagnostic === 'observe-ended' ||
          state.diagnostic === 'observe-failed') break;
        await new Promise<void>(resolve => {
          // Provider operation deadlines remain intact; a one-shot has no new app wall-clock cap.
          const timer = setTimeout(wake, 1000);
          function wake() { clearTimeout(timer); if (entry.wake === wake) delete entry.wake; resolve(); }
          entry.wake = wake;
        });
      }
    } finally {
      await this.runtime.stopCapturedSession(entry.binding);
      entry.provider?.seal();
      await this.confirmCleanup(entry);
    }
  }
}
