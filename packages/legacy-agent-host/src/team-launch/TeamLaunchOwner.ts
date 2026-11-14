import { appendNativeLaunchMember, validateNativeLaunchAdditions } from './nativeLaunchAddition.js';
import type { NativeLaunchAddition } from './nativeLaunchAddition.js';
import { retryLaunchMember, readNativeRetry } from './launchRetry.js';
import type { NativeLaunchRetryAuthority, LaunchRetryInput } from './launchRetry.js';
import type { MemberActionAuthority } from './memberActions.js';
import {
  createLaunchMemberActions,
  memberActionBlocksStart,
  memberActionBlocksSelection,
} from './memberActions.js';
import { projectLaunchRestorations } from './projectLaunchRestorations.js';
import { runtimeDigest } from '../runtime/identity.js';
import { canFinalizeWorktreeLaunch, finalizedWorktreeCapture } from './worktreePreparation.js';
import { validateLaunchRecord } from './validateLaunchRecord.js';
import { publishLaunchPreparation } from './launchPreparation.js';
import { createLiveRosterLaunch, liveRosterValidationRecord, liveRosterMemberBlocked,
  liveRosterStartAllowed, liveRosterHistoryFull } from './liveRosterMembership.js';
import { TeamLaunchError } from './contracts.js';
import { readReadinessCapture, selectedReadiness, attachLaunchReadiness, consumeLaunchReadiness,
  retireLaunchReadiness, finishReadinessCapture, canFinalizeReadinessCapture,
  assertLiveReadinessCapture, readFreshMemberSource, selectedReadinessSource } from './launchReadiness.js';
import type { LocalModelReadinessCapture, LaunchReadinessCaptureAdmission, LiveReadinessCapture } from './launchReadiness.js';
import { prepareResume, requestResumeMember, refuseResumeMember } from './launchResume.js';
import type {
  ResumeJournal,
  ResumePreparation,
  ResumeChoice,
  ResumeVerifier,
  ResumeRefusal,
} from './launchResume.js';
import type {
  NativeContextEvidence,
  ExpectedLaunchMember,
  LaunchAttempt,
  RuntimeLaunchObservation,
  TeamLaunchOptions,
  TeamLaunchRecord,
  TeamLaunchSummary,
  LaunchPreparation,
} from './contracts.js';

/** Static captured roster bootstrap; Runtime remains the only native allocation/input owner. */
export class TeamLaunchOwner {
  private readonly path: string;
  private fingerprint: string;
  private pendingPublication: Readonly<{ fingerprint: string; memberCount: number }> | undefined;
  private readonly active = new Map<string, Promise<void>>();
  private readonly deadlines = new Map<string, ReturnType<typeof setTimeout>>();
  private sealed = false;
  private liveReadinessCapture: LiveReadinessCapture | undefined;
  constructor(private readonly options: TeamLaunchOptions) {
    options.definition = structuredClone(options.definition);
    const definition = options.definition;
    if (
      !definition.launchId ||
      definition.launchId.length > 256 ||
      !definition.rosterRevision ||
      definition.rosterRevision.length > 256 ||
      definition.members.length > 256 ||
      new Set(definition.members.map((item) => item.memberId)).size !== definition.members.length
    )
      throw new TeamLaunchError('invalid', 'roster');
    for (const member of definition.members)
      if (
        !member.memberId ||
        member.memberId.length > 256 ||
        !Number.isSafeInteger(member.timeoutMs) ||
        member.timeoutMs < 1 ||
        member.timeoutMs > 300000
      )
        throw new TeamLaunchError('invalid', 'roster');
    this.fingerprint = runtimeDigest(definition);
    this.path = `launches/${runtimeDigest(definition.launchId)}.json`;
    options.store.fenced(() => {
      const prior = options.store.read<TeamLaunchRecord>(this.path);
      const finalizing = prior && canFinalizeWorktreeLaunch(prior, definition);
      const finalizingReadiness = prior && canFinalizeReadinessCapture(prior, definition, options.hostIncarnation);
      if (prior?.readiness?.capture && (finalizing || finalizingReadiness) &&
          prior.readiness.capture.hostIncarnation !== options.hostIncarnation)
        throw new TeamLaunchError('hold', 'capture-readiness-continuation-lost');
      if (prior && !finalizing && !finalizingReadiness) {
        this.validate(prior);
        return;
      }
      const record: TeamLaunchRecord = {
        ...(finalizing ? finalizedWorktreeCapture(prior, definition) : finalizingReadiness ? prior : {}),
        schemaVersion: 1,
        definition: structuredClone(definition),
        fingerprint: this.fingerprint,
        members: definition.members.map((member) => {
          const attemptId = `initial-${runtimeDigest({ launchId: definition.launchId, memberId: member.memberId })}`;
          return {
            memberId: member.memberId,
            currentAttemptId: attemptId,
            attempts: [this.initial(member, attemptId)],
          };
        }),
        retries: [],
      };
      this.write(record.readiness?.capture ? finishReadinessCapture(record) : record);
    });
  }
  /** Private native-add admission; actual original Team authority is supplied by its receipt owner. */
  appendExpectedNativeMember(input: Omit<NativeLaunchAddition, 'fingerprint'>, authorized: <T>(operation: () => T) => T): boolean {
    if (this.sealed) throw new TeamLaunchError('hold', 'sealed');
    return authorized(() => {
      const result = appendNativeLaunchMember({ record: this.load(), input,
        initial: (member, attemptId) => this.initial(member, attemptId) });
      if (!result.fresh) return false;
      this.publishSelection(result.record); // Expected target precedes the first provider factory allocation.
      return true;
    });
  }

  seal(): void {
    this.sealed = true;
    this.liveReadinessCapture = undefined;
    for (const timer of this.deadlines.values()) clearTimeout(timer);
    this.deadlines.clear();
    this.options.store.fenced(() => {
      const record = this.load(true);
      if (record.readiness) this.write(retireLaunchReadiness(record));
    });
  }

  readModelReadinessCapture(input: LocalModelReadinessCapture) {
    return this.options.authorized('read', () => readReadinessCapture(this.load(), input, this.now()));
  }
  readModelReadinessAdmission(): LaunchReadinessCaptureAdmission | undefined {
    return this.options.authorized('read', () => structuredClone(this.load().readiness?.capture));
  }
  /** Only the original capture invocation installs this ephemeral continuation fence. */
  admitModelReadinessCapture(input: LiveReadinessCapture): void {
    if (this.sealed) throw new TeamLaunchError('hold', 'sealed');
    this.options.authorized('control', () => {
      assertLiveReadinessCapture(this.load(), input, this.options.hostIncarnation);
      this.liveReadinessCapture = structuredClone(input);
    });
  }
  assertModelReadinessCapture(memberId?: string): void {
    if (this.sealed) throw new TeamLaunchError('hold', 'sealed');
    this.options.authorized('control', () =>
      assertLiveReadinessCapture(this.load(), this.liveReadinessCapture, this.options.hostIncarnation, memberId));
  }
  readModelReadinessGroup(commandId: string) {
    return this.options.authorized('read', () => structuredClone(
      this.load().readiness?.groups.find(row => row.commandId === commandId)));
  }
  readModelReadinessAction(actionId: string, memberId: string) {
    return this.options.store.fenced(() => structuredClone(this.load().readiness?.consumers
      .find(row => row.actionId === actionId && row.memberId === memberId)));
  }
  attachModelReadiness(input: Parameters<typeof attachLaunchReadiness>[1],
    authorized: <T>(operation: () => T) => T = operation => this.options.authorized('control', operation)): void {
    if (this.sealed) throw new TeamLaunchError('hold', 'sealed');
    authorized(() => this.write(attachLaunchReadiness(this.load(), input)));
  }
  readModelReadiness(input: Parameters<typeof selectedReadiness>[1]) {
    return this.options.store.fenced(() => selectedReadiness(this.load(), input));
  }
  readModelReadinessSource(input: Parameters<typeof selectedReadinessSource>[1]) {
    return this.options.store.fenced(() => selectedReadinessSource(this.load(), input));
  }
  consumeModelReadiness(consumerId: string): void {
    if (this.sealed) throw new TeamLaunchError('hold', 'sealed');
    this.options.store.fenced(() => this.write(consumeLaunchReadiness(this.load(), consumerId)));
  }
  retireModelReadiness(memberId?: string): void {
    this.options.store.fenced(() => this.write(retireLaunchReadiness(this.load(), memberId)));
  }
  start(
    commandId: string,
    preparationFingerprint?: string,
    beforeOpen?: () => void,
    initialPrompt?: string | null
  ): TeamLaunchSummary {
    if (this.sealed) throw new TeamLaunchError('hold', 'sealed');
    this.id(commandId);
    if (initialPrompt !== undefined && initialPrompt !== null &&
      (typeof initialPrompt !== 'string' || !initialPrompt.trim() || initialPrompt.includes('\0') || initialPrompt.length > 100_000))
      throw new TeamLaunchError('invalid', 'launch-prompt');
    const members = this.options.authorized('control', () => {
      const record = this.load();
      if (record.preparation?.fingerprint !== preparationFingerprint)
        throw new TeamLaunchError('conflict', 'launch-configuration');
      if (record.preparation && record.preparation.commandId !== commandId)
        throw new TeamLaunchError('conflict', 'launch-command');
      if (record.startCommandId && record.startCommandId !== commandId)
        throw new TeamLaunchError('conflict', 'launch-command');
      if (record.startCommandId && record.initialPrompt !== initialPrompt)
        throw new TeamLaunchError('conflict', 'launch-prompt');
      if (!record.startCommandId) {
        record.startCommandId = commandId;
        record.sourceRosterRevision = record.definition.rosterRevision;
        record.startedAtMs = this.now();
        if (initialPrompt !== undefined) record.initialPrompt = initialPrompt;
        this.write(record);
      }
      return record.members.filter(row => !liveRosterMemberBlocked(record, row.memberId)).map(row => row.memberId);
    });
    beforeOpen?.();
    for (const memberId of members) this.startMember(memberId);
    return this.read();
  }

  /** Publish selected settings in the existing launch record before any factory can run. */
  prepare(input: Omit<LaunchPreparation, 'fingerprint'>): boolean {
    if (this.sealed) throw new TeamLaunchError('hold', 'sealed');
    this.id(input.commandId);
    return publishLaunchPreparation({ input, authorized: this.options.authorized,
      runtime: this.options.runtime, load: () => this.load(), commit: record => this.publishSelection(record) });
  }
  restoreSelection(
    commandId: string,
    memberId: string,
    reference: string
  ): ExpectedLaunchMember | undefined {
    this.id(commandId);
    return this.options.authorized('read', () => {
      const previous = this.load().restorations?.find((item) => item.commandId === commandId);
      if (!previous) return undefined;
      if (previous.fingerprint !== runtimeDigest({ memberId, reference }))
        throw new TeamLaunchError('conflict', 'restore-command');
      return structuredClone(previous.member);
    });
  }

  /** Original selected targets only; no native opening or reconciliation. */
  readRestorations() {
    return this.options.authorized('read', () => projectLaunchRestorations(this.load()));
  }

  liveMembership(authorized: <T>(operation: () => T) => T) {
    return createLiveRosterLaunch({ authorized, read: () => this.load(),
      write: record => this.publishSelection(record), initial: (member, id) => this.initial(member, id) });
  }

  memberActions(authority?: MemberActionAuthority) {
    return createLaunchMemberActions({
      authorized: (action, callback) => {
        if (action === 'control' && this.sealed) throw new TeamLaunchError('hold', 'sealed');
        // The actual Team authority owns this fence; a separate launch store must not lock it twice.
        return (authority?.authorized ?? this.options.authorized)(action, callback);
      },
      read: () => this.load(),
      observe: (memberId) => this.options.runtime.read(memberId),
      captureActor: () => {
        if (authority) return authority.captureActor();
        if (!this.options.captureActor) throw new TeamLaunchError('hold', 'member-action-actor');
        return this.options.captureActor();
      },
      write: (record) => this.publishSelection(record),
      initial: (member, attemptId) => this.initial(member, attemptId),
    });
  }

  prepareResume(raw: unknown, verify: ResumeVerifier): ResumePreparation {
    if (this.sealed) throw new TeamLaunchError('hold', 'sealed');
    return prepareResume(this.resumeJournal(), raw, verify);
  }
  requestResumeMember(resumeId: string | undefined, member: ResumeChoice): void {
    if (this.sealed) throw new TeamLaunchError('hold', 'sealed');
    requestResumeMember(this.resumeJournal(), resumeId, member);
  }
  refuseResumeMember(input: ResumeRefusal, prove: () => boolean): void {
    refuseResumeMember(this.resumeJournal(), input.resumeId, input.commandId, input.code, prove);
  }
  private resumeJournal(): ResumeJournal {
    return {
      read: () => this.load(),
      write: (record) => this.write(record),
      authorized: (fn) => this.options.authorized('control', fn),
    };
  }

  /** One atomic launch publication also changes Team's active technical binding projection. */
  selectRestore(
    input: { commandId: string; member: ExpectedLaunchMember },
    verifySource: () => void
  ): ExpectedLaunchMember {
    if (this.sealed) throw new TeamLaunchError('hold', 'sealed');
    const next = structuredClone(input.member),
      restore = next.restore;
    this.id(input.commandId);
    if (
      !restore ||
      restore.commandId !== input.commandId ||
      !/^cp1-[a-f0-9]{64}$/.test(restore.reference)
    )
      throw new TeamLaunchError('invalid', 'restore-selection');
    const known = this.restoreSelection(input.commandId, next.memberId, restore.reference);
    if (!known) {
      // Runtime observations take its own fence outside Team's authority lock.
      // No await intervenes; allocation revalidates the same source after publication.
      const observed = this.options.runtime.read(next.memberId).record;
      if (observed?.phase !== 'closed' || observed.custody !== 'released')
        throw new TeamLaunchError('hold', 'restore-source-custody');
      verifySource();
    }
    return this.options.authorized('control', () => {
      const record = this.load(),
        fingerprint = runtimeDigest({
          memberId: next.memberId,
          reference: restore.reference,
        });
      const previous = record.restorations?.find((item) => item.commandId === input.commandId);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new TeamLaunchError('conflict', 'restore-command');
        return structuredClone(previous.member);
      }
      if (memberActionBlocksSelection(record, next.memberId))
        throw new TeamLaunchError('hold', 'member-action-unresolved');
      const source = record.definition.members.find((item) => item.memberId === next.memberId);
      const member = record.members.find((item) => item.memberId === next.memberId);
      if (
        !source?.binding ||
        !member ||
        !next.binding ||
        next.skipped ||
        runtimeDigest(source.binding) !== runtimeDigest(restore.sourceBinding) ||
        source.binding.generation === next.binding.generation ||
        ['backendId', 'teamId', 'runId', 'memberId'].some(
          (key) => source.binding![key as 'memberId'] !== next.binding![key as 'memberId']
        ) ||
        next.contextDigest !== source.contextDigest ||
        next.configRevision !== source.configRevision ||
        next.timeoutMs !== source.timeoutMs ||
        !next.configurationDigest ||
        next.baseConfigurationDigest !==
          (source.baseConfigurationDigest ?? source.configurationDigest) ||
        !Number.isSafeInteger(next.runtimeGeneration) ||
        next.runtimeGeneration! <= (source.runtimeGeneration ?? -1) ||
        (record.restorations?.length ?? 0) >= 64 || liveRosterHistoryFull(record) ||
        member.attempts.length >= 65
      )
        throw new TeamLaunchError('conflict', 'restore-binding');
      // Existing Runtime digests preserve JSON field order. Keep the original
      // descriptor shape so a reopened captured composition hashes identically.
      const published = { ...source, ...next };
      record.definition.members[record.definition.members.indexOf(source)] = published;
      record.definition.rosterRevision = runtimeDigest({
        scope: record.definition.rosterScope ?? record.definition.launchId,
        members: record.definition.members,
      });
      record.fingerprint = runtimeDigest(record.definition);
      member.currentAttemptId = `restore-${runtimeDigest(input.commandId)}`;
      member.attempts.push(this.initial(next, member.currentAttemptId));
      record.restorations ??= [];
      record.restorations.push({
        commandId: input.commandId,
        fingerprint,
        member: published,
      });
      this.publishSelection(record); // Durable selection precedes Runtime opening/native allocation.
      return structuredClone(published);
    });
  }

  /** Private immutable source lookup; caller still supplies current effect authority. No RPC/MCP method. */
  readFreshMemberSource(binding: import('../runtime/contracts.js').RuntimeBinding) {
    return this.options.store.fenced(() => readFreshMemberSource(this.load(), binding));
  }

  /** Trusted individual runtime.open also records its attempt before allocation; no whole-team launch. */
  startMember(
    memberId: string,
    assertAuthority?: () => void,
    memberActionCommandId?: string
  ): Promise<void> | undefined {
    if (this.sealed) throw new TeamLaunchError('hold', 'sealed');
    const selected = this.options.definition.members.find((item) => item.memberId === memberId);
    if (!selected) throw new TeamLaunchError('invalid', 'member');
    if (selected.binding) assertAuthority ??= this.options.runtime.captureAuthority?.(memberId);
    assertAuthority?.();
    const before = this.options.store.fenced(() => this.current(this.load().members.find(row => row.memberId === memberId)!));
    if (!selected.skipped && !before.claimed) this.options.runtime.assertModelReadiness?.(memberId);
    const claimed = this.options.store.fenced(() => {
      const record = this.load(),
        member = record.members.find((item) => item.memberId === memberId)!,
        attempt = this.current(member);
      const addition = record.nativeAdditions?.find(row => row.member.memberId === memberId);
      if (addition && member.currentAttemptId.startsWith('native-add-') && !attempt.claimed &&
        (memberActionCommandId !== addition.commandId || !assertAuthority))
        throw new TeamLaunchError('hold', 'native-add-original-required');
      const selectedAction = record.memberActions?.find(
        (a) =>
          a.phase === 'selected' &&
          a.input.action === 'restart' &&
          member.currentAttemptId === `action-${runtimeDigest(a.input.commandId)}`
      );
      if (
        selectedAction &&
        !attempt.claimed &&
        (memberActionCommandId !== selectedAction.input.commandId || !assertAuthority)
      )
        throw new TeamLaunchError('hold', 'member-action-original-required');
      if (memberActionBlocksStart(record, memberId))
        throw new TeamLaunchError('hold', 'member-action-unresolved');
      if (!liveRosterStartAllowed(record, memberId, memberActionCommandId, !!assertAuthority))
        throw new TeamLaunchError('hold', 'live-roster-original-required');
      if (selected.skipped || (attempt.status === 'failed' && !selected.restore)) return undefined;
      if (
        attempt.claimed &&
        (!selected.restore || this.active.has(`${memberId}:${attempt.attemptId}`))
      )
        return undefined;
      attempt.claimed = true;
      attempt.hostIncarnation = this.options.hostIncarnation;
      attempt.startedAtMs = this.now();
      attempt.deadlineMs = attempt.startedAtMs + selected.timeoutMs;
      attempt.status = 'pending-bootstrap';
      attempt.reason = 'opening';
      attempt.noAllocation = false;
      this.write(record);
      return attempt.attemptId;
    });
    if (!claimed) return undefined;
    const existingTimer = this.deadlines.get(`${memberId}:${claimed}`);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => {
      this.deadlines.delete(`${memberId}:${claimed}`);
      if (!this.sealed) {
        try {
          if (!this.sealed) this.refresh();
        } catch {
          /* Original journal remains held. */
        }
        this.options.onProgress?.();
      }
    }, selected.timeoutMs);
    timer.unref();
    this.deadlines.set(`${memberId}:${claimed}`, timer);
    const pending = Promise.resolve()
      .then(() => {
        assertAuthority?.();
        return this.options.runtime.open(memberId, assertAuthority);
      })
      .then(
        () => {},
        () => {}
      )
      .then(() => {
        this.active.delete(`${memberId}:${claimed}`);
        try {
          if (!this.sealed) this.refresh();
        } catch {
          /* Corrupt/unavailable journal remains HOLD on the original launch. */
        }
        this.options.onProgress?.();
      });
    this.active.set(`${memberId}:${claimed}`, pending);
    return pending;
  }
  /** Private model selection only; public reads still project original Runtime observations. */
  readModelProbeSelection(action: 'read' | 'control') {
    return this.options.authorized(action, () => {
      const record = this.load();
      return {
        launchId: record.definition.launchId,
        rosterRevision: record.definition.rosterRevision,
        memberIds: record.members.filter(row => !liveRosterMemberBlocked(record, row.memberId)).map(({ memberId }) => memberId),
      };
    });
  }

  read(action: 'read' | 'control' = 'read'): TeamLaunchSummary {
    const record = this.options.authorized(action, () => structuredClone(this.load()));
    return this.summary(this.project(record));
  }
  /** Durable original admission is readable even after its finite model proof expires. */
  readOriginalStart(commandId: string): TeamLaunchSummary | null {
    this.id(commandId);
    const record = this.options.authorized('read', () => structuredClone(this.load()));
    if (!record.startCommandId) return null;
    if (record.startCommandId !== commandId)
      throw new TeamLaunchError('conflict', 'launch-command');
    return this.summary(this.project(record));
  }
  /** Native/control continuations capture facts even if the original business grant was revoked. */
  refresh(): void {
    const record = this.options.store.fenced(() => structuredClone(this.load()));
    const projected = this.project(record); // Never hold Team's authority fence while reading Runtime/provider facts.
    this.options.store.fenced(() => {
      const current = this.load();
      for (const member of projected.members) {
        // Historical attempts are projected for reads, never republished by a replacement Host.
        if (this.current(member).hostIncarnation !== this.options.hostIncarnation) continue;
        const target = current.members.find((item) => item.memberId === member.memberId)!;
        if (target.currentAttemptId !== member.currentAttemptId) continue; // Late old attempt cannot improve its replacement.
        target.attempts[target.attempts.length - 1] = this.current(member);
      }
      if (runtimeDigest(current) !== runtimeDigest(this.load())) this.write(current);
    });
  }
  canWork(memberId: string, proof?: NativeContextEvidence): boolean {
    return this.options.store.fenced(() => {
      const record = this.load(), member = record.members.find((item) => item.memberId === memberId);
      if (!member || liveRosterMemberBlocked(record, memberId)) return false;
      const attempt = this.current(member);
      const expected = this.options.definition.members.find((item) => item.memberId === memberId)!;
      return (
        attempt.hostIncarnation === this.options.hostIncarnation &&
        attempt.usable &&
        !!proof &&
        proof.kind === 'native-configuration' &&
        proof.contextDigest === expected.contextDigest &&
        proof.generation === expected.binding?.generation &&
        proof.configRevision === expected.configRevision
      );
    });
  }
  retry(input: LaunchRetryInput, native?: NativeLaunchRetryAuthority): TeamLaunchSummary {
    if (this.sealed) throw new TeamLaunchError('hold', 'sealed');
    return retryLaunchMember(
      {
        definition: this.options.definition,
        load: () => this.load(),
        write: (record) => this.write(record),
        authorized: this.options.authorized,
        project: (record) => this.project(record),
        current: (member) => this.current(member),
        initial: (member, id) => this.initial(member, id),
        start: (member, authority) => this.startMember(member, authority),
        summary: (record) => this.summary(record),
        ...(this.options.runtime.assertModelReadiness
          ? { assertModelReadiness: this.options.runtime.assertModelReadiness } : {}),
      },
      input,
      native
    );
  }
  readNativeRetry(commandId: string, memberId: string, authority: NativeLaunchRetryAuthority) {
    return authority.authorized('read', () =>
      readNativeRetry(this.load(), commandId, memberId, authority.captureActor())
    );
  }
  private project(record: TeamLaunchRecord): TeamLaunchRecord {
    for (const member of record.members) {
      const definition = record.definition.members.find(
          (item) => item.memberId === member.memberId
        )!,
        attempt = this.current(member);
      if (definition.skipped) {
        attempt.status = 'skipped';
        attempt.usable = false;
        continue;
      }
      if (!definition.binding || !definition.configurationDigest || !definition.contextDigest) {
        attempt.status = 'failed';
        attempt.reason = 'runtime-unconfigured';
        attempt.noAllocation = true;
        attempt.usable = false;
        continue;
      }
      if (!attempt.claimed) continue;
      attempt.nativeReady = false;
      attempt.usable = false;
      attempt.controlAvailable = false;
      let observation: RuntimeLaunchObservation;
      try {
        observation = this.options.runtime.read(member.memberId);
      } catch {
        attempt.status = 'unknown';
        attempt.reason = 'observation-unavailable';
        attempt.usable = false;
        continue;
      }
      const source = observation.record;
      attempt.nativeReady = false;
      attempt.usable = false;
      attempt.controlAvailable = false;
      if (!source) {
        // Runtime persists opening before factory effects. Durable absence proves no native allocation.
        attempt.status =
          attempt.hostIncarnation === this.options.hostIncarnation &&
          this.active.has(`${member.memberId}:${attempt.attemptId}`)
            ? 'pending-bootstrap'
            : 'failed';
        attempt.reason = attempt.status === 'failed' ? 'no-allocation' : 'opening';
        attempt.noAllocation = attempt.status === 'failed';
        continue;
      }
      attempt.noAllocation = false;
      if (source.phase === 'closed' && source.custody === 'released') {
        attempt.status = 'failed';
        attempt.reason = 'stopped';
        continue;
      }
      if (
        runtimeDigest(source.binding) !== runtimeDigest(definition.binding) ||
        source.config?.configRevision !== definition.configRevision
      ) {
        attempt.status = 'unknown';
        attempt.reason = 'binding-mismatch';
        continue;
      }
      // The original factory is still running; unknown custody grants no work/control authority.
      // A cold, completed or expired open continues through the existing UNKNOWN projection below.
      if (
        source.phase === 'opening' &&
        !source.sealed &&
        source.hostIncarnation === this.options.hostIncarnation &&
        attempt.hostIncarnation === this.options.hostIncarnation &&
        this.active.has(`${member.memberId}:${attempt.attemptId}`) &&
        this.now() < attempt.deadlineMs &&
        !source.interactions.some((item) => item.phase !== 'resolved')
      ) {
        attempt.status = 'pending-bootstrap';
        attempt.reason = 'opening';
        continue;
      }
      if (
        !observation.attached ||
        source.hostIncarnation !== this.options.hostIncarnation ||
        source.custody === 'unknown'
      ) {
        attempt.status = 'unknown';
        attempt.reason = source.interactions.some((item) => item.phase !== 'resolved')
          ? 'retained-interaction-unavailable'
          : 'custody-unresolved';
        continue;
      }
      attempt.nativeReady =
        source.nativeReady && observation.nativeReady && source.phase === 'allocated';
      const proof = observation.context;
      if (
        proof &&
        proof.kind === 'native-configuration' &&
        proof.contextDigest === definition.contextDigest &&
        proof.generation === definition.binding.generation &&
        proof.configRevision === definition.configRevision
      )
        attempt.contextApplied = true;
      const permission = source.interactions.some(
        (item) => item.phase === 'pending' || item.phase === 'responding'
      );
      attempt.controlAvailable =
        observation.attached &&
        source.hostIncarnation === this.options.hostIncarnation &&
        !source.sealed;
      if (permission) {
        attempt.controlAvailable =
          source.interactions.some(
            (item) => item.phase === 'pending' && item.expiresAt > this.now()
          ) && !source.sealed;
        attempt.status = 'pending-human';
        attempt.reason = source.interactions.some(
          (item) => item.phase === 'pending' && item.expiresAt <= this.now()
        )
          ? 'interaction-expired'
          : 'human-decision';
        continue;
      }
      if (source.phase === 'closed' || source.sealed) {
        attempt.status = 'failed';
        attempt.reason = 'stopped';
        continue;
      }
      if (attempt.status === 'failed' && attempt.reason === 'bootstrap-timeout') continue;
      attempt.usable = attempt.nativeReady && attempt.contextApplied;
      if (attempt.usable) {
        attempt.status = 'ready';
        attempt.reason = 'context-applied';
        attempt.everReady = true;
      } else if (!attempt.everReady && this.now() >= attempt.deadlineMs) {
        attempt.status = 'failed';
        attempt.reason = 'bootstrap-timeout';
      } else {
        attempt.status = 'pending-bootstrap';
        attempt.reason = attempt.contextApplied ? 'dependency-unavailable' : 'context-unconfirmed';
      }
    }
    return record;
  }
  private summary(record: TeamLaunchRecord): TeamLaunchSummary {
    const members = record.members.map((member) => ({
      memberId: member.memberId,
      binding: record.definition.members.find((item) => item.memberId === member.memberId)!.binding,
      attempt: this.publicAttempt(this.current(member)),
    }));
    const ready = members.filter((member) => member.attempt.usable).length;
    const memberStarts = record.members.flatMap((member) =>
      member.attempts.filter((attempt) => attempt.claimed).map((attempt) => attempt.startedAtMs)
    );
    return {
      launchId: record.definition.launchId,
      rosterRevision: record.definition.rosterRevision,
      startedAtMs: record.startedAtMs ?? (memberStarts.length ? Math.min(...memberStarts) : null),
      observedAtMs: this.now(),
      status:
        ready > 0 && members.every((item) => ['ready', 'skipped'].includes(item.attempt.status))
          ? 'ready'
          : ready > 0
            ? 'partial'
            : members.some((item) => item.attempt.status === 'failed')
              ? 'failed'
              : 'pending',
      ready,
      expected: members.length,
      retryCapability: 'same-binding-no-allocation-only',
      ...(record.preparation
        ? {
            admission: {
              commandId: record.preparation.commandId,
              sourceRosterRevision: record.preparation.sourceRosterRevision,
              members: record.preparation.members.map(({ memberId, configuration }) => ({
                memberId,
                configuration,
              })),
            },
          }
        : record.startCommandId && record.sourceRosterRevision
          ? {
              admission: {
                commandId: record.startCommandId,
                sourceRosterRevision: record.sourceRosterRevision,
                members: [],
              },
            }
          : {}),
      members,
    };
  }
  private publicAttempt(attempt: LaunchAttempt): LaunchAttempt {
    return {
      attemptId: attempt.attemptId,
      hostIncarnation: attempt.hostIncarnation,
      startedAtMs: attempt.startedAtMs,
      deadlineMs: attempt.deadlineMs,
      claimed: attempt.claimed,
      status: attempt.status,
      reason: attempt.reason,
      nativeReady: attempt.nativeReady,
      contextApplied: attempt.contextApplied,
      everReady: attempt.everReady,
      usable: attempt.usable,
      controlAvailable: attempt.controlAvailable,
      noAllocation: attempt.noAllocation,
    };
  }
  private initial(member: ExpectedLaunchMember, attemptId: string): LaunchAttempt {
    const missing = !member.binding || !member.configurationDigest || !member.contextDigest;
    return {
      attemptId,
      hostIncarnation: this.options.hostIncarnation,
      startedAtMs: 0,
      deadlineMs: 0,
      claimed: false,
      status: member.skipped ? 'skipped' : missing ? 'failed' : 'not-started',
      reason: member.skipped ? 'launch-policy' : missing ? 'runtime-unconfigured' : 'not-started',
      nativeReady: false,
      contextApplied: false,
      everReady: false,
      usable: false,
      controlAvailable: false,
      noAllocation: missing,
    };
  }
  private current(member: TeamLaunchRecord['members'][number]): LaunchAttempt {
    const attempt = member.attempts.find((item) => item.attemptId === member.currentAttemptId);
    if (!attempt) throw new TeamLaunchError('hold', 'attempt-corrupt');
    return attempt;
  }
  private load(sealing = false): TeamLaunchRecord {
    const record = this.options.store.read<TeamLaunchRecord>(this.path);
    if (!record) throw new TeamLaunchError('hold', 'record-missing');
    this.validate(record, sealing);
    return record;
  }
  private validate(record: TeamLaunchRecord, sealing = false): void {
    const pending = sealing && record.fingerprint !== this.fingerprint &&
      record.fingerprint === this.pendingPublication?.fingerprint ? this.pendingPublication : undefined;
    validateLaunchRecord(liveRosterValidationRecord(record), pending?.fingerprint ?? this.fingerprint,
      pending?.memberCount ?? this.options.definition.members.length);
    validateNativeLaunchAdditions(record);
  }
  private publishSelection(record: TeamLaunchRecord): void {
    this.pendingPublication = { fingerprint: record.fingerprint, memberCount: record.definition.members.length };
    this.write(record);
    this.options.definition = structuredClone(record.definition);
    this.fingerprint = record.fingerprint;
    this.pendingPublication = undefined;
  }
  private write(record: TeamLaunchRecord): void {
    if (Buffer.byteLength(JSON.stringify(record)) > 1024 * 1024)
      throw new TeamLaunchError('hold', 'record-budget');
    this.options.store.write(this.path, record);
  }
  private id(value: string): void {
    if (typeof value !== 'string' || !value || value.length > 256)
      throw new TeamLaunchError('invalid', 'identity');
  }
  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}
