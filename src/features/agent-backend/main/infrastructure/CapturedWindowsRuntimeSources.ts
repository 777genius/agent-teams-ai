import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import {
  assertRuntimeSourceQualification,
  captureWindowsLauncher,
  encodeLaunch,
  matchesCapturedWindowsLauncher,
  readPreparedRuntimeSourcePublication,
  readRetainedRuntimeSourceSelections,
  readRuntimeSourceConfigurationVersion,
  runtimeSourceProcessContextSchema,
  runtimeSourceProcessOriginSchema,
  runtimeSourceVersionProfile,
  sameRuntimeSourceGrantAuthority,
  selectRuntimeSourceSeed,
  windowsBrokerReference,
  windowsLaunchSpec,
} from '@agent-teams/legacy-agent-host/owned-process';
import { publishRuntimeSourceRequestSchema, refreshRuntimeConfigurationSchema,
  runtimeSourceGrantSchema } from '@agent-teams/legacy-agent-host/runtime-sources';

import { matchesWindowsSourceAssociation } from './capturedWindowsSourceAssociation';

import type { WindowsOriginalSourceAssociation } from './capturedWindowsSourceAssociation';
import type {
  CapturedWindowsLauncher,
  NativeProcessProfile,
  ResolvedLaunchSpec,
  RetainedWindowsCustody,
  RuntimeSourceProcessContext,
  RuntimeSourceProcessOrigin,
} from '@agent-teams/legacy-agent-host/owned-process';
import type { RuntimeConfigurationRefreshIntent, RuntimeSourceCandidate, RuntimeSourceGrant,
  RuntimeSourcePublishIntent } from '@agent-teams/legacy-agent-host/runtime-sources';

export type SelectedWindowsProcessProfile = NativeProcessProfile & {
  provider: 'claude' | 'codex' | 'opencode';
  nativeGeneration?: 'v1' | undefined;
  association?: WindowsOriginalSourceAssociation;
};
export interface WindowsLaunchAdmission {
  capability: string;
  phase: 'prepare' | 'resume' | 'service';
  runtimeSourceOrigin?: RuntimeSourceProcessOrigin | undefined;
}
export interface WindowsSourceLaunchSelection {
  profile: NativeProcessProfile;
  launcher: CapturedWindowsLauncher;
  assertCurrent(): void;
}
interface Probe {
  profile: NativeProcessProfile;
  launcher: CapturedWindowsLauncher;
  specDigest: string;
}
interface PendingSource {
  fingerprint: string;
  current(): boolean;
  deadline: number;
  references: number;
  probes: readonly Probe[];
  capabilities: Map<string, string>;
}

const unavailable = (): never => { throw new Error('Captured Main source custody unavailable'); };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const specDigest = (spec: ResolvedLaunchSpec) => createHash('sha256').update(encodeLaunch(spec)).digest('hex');
const owners = new WeakMap<RetainedWindowsCustody, CapturedWindowsRuntimeSources>();

/** Main-only lifetime sidecar; neither a renderer nor the replaceable Host can add an admission. */
export function bindMainWindowsRuntimeSources(owner: RetainedWindowsCustody, source: CapturedWindowsRuntimeSources): void {
  if (owners.has(owner)) unavailable();
  owners.set(owner, source);
}
export function prepareMainWindowsRuntimeSource(owner: RetainedWindowsCustody, grant: RuntimeSourceGrant,
  input: RuntimeSourcePublishIntent, current: () => boolean): () => void {
  return (owners.get(owner) ?? unavailable()).prepare(grant, input, current);
}
export function prepareMainWindowsRuntimeSourceRecovery(owner: RetainedWindowsCustody,
  grant: RuntimeSourceGrant, current: () => boolean): () => void {
  return (owners.get(owner) ?? unavailable()).prepareRecovery(grant, current);
}
export function prepareMainWindowsRuntimeConfiguration(owner: RetainedWindowsCustody,
  grant: RuntimeSourceGrant, input: RuntimeConfigurationRefreshIntent, current: () => boolean): () => void {
  return (owners.get(owner) ?? unavailable()).prepareConfiguration(grant, input, current);
}

/** Exact pending version reads and independently validated original published source history. */
export class CapturedWindowsRuntimeSources {
  private readonly context: RuntimeSourceProcessContext;
  private readonly grants: readonly RuntimeSourceGrant[];
  private readonly profiles: readonly SelectedWindowsProcessProfile[];
  private readonly pending = new Map<string, PendingSource>();
  private readonly recipes = new Map<string, { profile: NativeProcessProfile; launcher: CapturedWindowsLauncher }>();

  constructor(source: unknown, grants: readonly RuntimeSourceGrant[], profiles: readonly SelectedWindowsProcessProfile[],
    private readonly assertOriginal: () => void) {
    this.context = runtimeSourceProcessContextSchema.parse(source);
    if (grants.length > 256) unavailable();
    this.grants = structuredClone(grants.map(grant => runtimeSourceGrantSchema.parse(grant)));
    if (new Set(this.grants.map(grant => grant.targetId)).size !== this.grants.length) unavailable();
    this.profiles = structuredClone(profiles);
  }

  /** A V2 selector may use an explicitly captured broker for --version only; its engine is not admitted. */
  versionBrokers(): NonNullable<NativeProcessProfile['windowsBroker']>[] {
    const brokers: NonNullable<NativeProcessProfile['windowsBroker']>[] = [];
    for (const grant of this.grants) {
      let seed;
      try { seed = selectRuntimeSourceSeed(this.context, grant); }
      catch { continue; } // An unavailable management binding must not disable unrelated original Teams.
      if (seed.windowsBroker?.arch === process.arch) brokers.push({ ...seed.windowsBroker });
    }
    return brokers;
  }

  private assertPending(key: string, pending: PendingSource): void {
    this.assertOriginal();
    let current = false;
    try { current = pending.current(); } catch { /* A failing original guard never admits native work. */ }
    if (this.pending.get(key) !== pending || pending.references < 1 || !current ||
      performance.now() >= pending.deadline) unavailable();
  }

  private originalGrant(raw: RuntimeSourceGrant): RuntimeSourceGrant {
    const parsed = runtimeSourceGrantSchema.parse(raw);
    return this.grants.find(value => sameRuntimeSourceGrantAuthority(value, parsed)) ?? unavailable();
  }

  prepareRecovery(rawGrant: RuntimeSourceGrant, current: () => boolean): () => void {
    const grant = this.originalGrant(rawGrant);
    const original = readPreparedRuntimeSourcePublication(this.context, grant, () => {
      this.assertOriginal(); if (!current()) unavailable();
    });
    return original ? this.prepare(original.grant, original, current) : () => {};
  }

  prepareConfiguration(rawGrant: RuntimeSourceGrant, rawInput: RuntimeConfigurationRefreshIntent,
    current: () => boolean): () => void {
    const grant = this.originalGrant(rawGrant);
    const input = refreshRuntimeConfigurationSchema.parse(structuredClone({ ...rawInput, grant }));
    const original = readRuntimeSourceConfigurationVersion(this.context, grant, input, () => {
      this.assertOriginal(); if (!current()) unavailable();
    });
    return original ? this.prepare(original.grant, original, current) : () => {};
  }

  prepare(rawGrant: RuntimeSourceGrant, rawInput: RuntimeSourcePublishIntent, current: () => boolean): () => void {
    this.assertOriginal();
    if (!current()) unavailable();
    const input = publishRuntimeSourceRequestSchema.parse(structuredClone({ ...rawInput, grant: rawGrant }));
    const grant = this.originalGrant(input.grant);
    input.grant = grant;
    const seed = selectRuntimeSourceSeed(this.context, grant);
    const candidate: RuntimeSourceCandidate = 'candidate' in input ? input.candidate : {
      sourceKind: input.nativeSelection.sourceKind,
      executable: seed.provider === 'opencode' && seed.nativeGeneration === 'v2'
        ? seed.executable : input.nativeSelection.nativeCli.executable,
      nativeCli: input.nativeSelection.nativeCli,
      ...(input.nativeSelection.embedded ? { embedded: input.nativeSelection.embedded } : {}),
    };
    assertRuntimeSourceQualification(seed, candidate);
    // Same-byte/config-only publication needs no temporary native authority.
    if (!candidate.nativeCli) return () => {};
    if (!seed.windowsBroker) unavailable();
    const key = digest([grant.targetId, input.commandId]), fingerprint = digest(input);
    let pending = this.pending.get(key);
    if (pending) {
      this.assertPending(key, pending);
      if (pending.fingerprint !== fingerprint || pending.references >= 8) unavailable();
      pending.references++;
    } else {
      if (this.pending.size >= 256) unavailable();
      const executables = [candidate.nativeCli.executable];
      if (seed.provider === 'claude' && candidate.nativeCli.executable.sha256 !== seed.executable.sha256)
        executables.unshift(seed.executable);
      const probes = executables.map(executable => {
        const profile = runtimeSourceVersionProfile(seed, executable), launcher = captureWindowsLauncher(profile);
        return { profile, launcher, specDigest: specDigest(windowsLaunchSpec(profile, ['--version'], launcher)) };
      });
      pending = { fingerprint, current, deadline: performance.now() + 30_000, references: 1,
        probes, capabilities: new Map() };
      this.pending.set(key, pending);
    }
    const original = pending;
    let closed = false;
    return () => {
      if (closed) return; closed = true;
      if (--original.references === 0 && this.pending.get(key) === original) this.pending.delete(key);
    };
  }

  select(spec: ResolvedLaunchSpec, sha256: string, broker: NonNullable<NativeProcessProfile['windowsBroker']>,
    admission: WindowsLaunchAdmission): WindowsSourceLaunchSelection | undefined {
    this.assertOriginal();
    const reference = windowsBrokerReference(broker);
    const origin = admission.runtimeSourceOrigin === undefined ? undefined :
      runtimeSourceProcessOriginSchema.parse(structuredClone(admission.runtimeSourceOrigin));
    const history = readRetainedRuntimeSourceSelections(this.context, this.grants, this.assertOriginal);
    for (const selected of history) {
      const { record, seed } = selected;
      if (!origin || origin.sourceId !== record.grant.targetId || origin.revision !== record.revision) continue;
      if (seed.provider === 'opencode' && seed.nativeGeneration === 'v2') continue;
      for (const original of this.profiles) {
        if (original.provider !== seed.provider || original.executable.sha256 !== seed.executable.sha256 ||
          !original.windowsBroker || windowsBrokerReference(original.windowsBroker) !== reference ||
          !matchesWindowsSourceAssociation(this.context, selected, original, spec, origin)) continue;
        const key = digest([record.revision, original]);
        let recipe = this.recipes.get(key);
        if (!recipe) {
          const profile = { ...original, executable: { ...record.candidate.executable } };
          try { recipe = { profile, launcher: captureWindowsLauncher(profile) }; }
          catch { continue; } // Missing historical bytes do not substitute another source or block a different exact image.
          this.recipes.set(key, recipe);
        }
        if (recipe.launcher.executable.sha256 !== sha256 || !matchesCapturedWindowsLauncher(recipe.launcher, spec)) continue;
        return { ...recipe, assertCurrent: () => {
          const fresh = readRetainedRuntimeSourceSelections(this.context, this.grants, this.assertOriginal);
          if (!fresh.some(value => value.record.revision === record.revision &&
            digest(value.seed) === digest(seed) &&
            matchesWindowsSourceAssociation(this.context, value, original, spec, origin))) unavailable();
        } };
      }
    }
    // A dynamic source witness cannot borrow the separate finite pending-version admission.
    if (origin || !this.pending.size) return undefined;
    const selectedDigest = specDigest(spec);
    for (const [key, pending] of this.pending) {
      const probe = pending.probes.find(value => value.specDigest === selectedDigest &&
        value.launcher.executable.sha256 === sha256 && value.profile.windowsBroker &&
        windowsBrokerReference(value.profile.windowsBroker) === reference);
      if (!probe) continue;
      this.assertPending(key, pending);
      if (admission.phase === 'service') unavailable();
      const bound = pending.capabilities.get(admission.capability);
      if (bound === undefined) {
        if (admission.phase !== 'prepare' || [...pending.capabilities.values()].includes(selectedDigest)) unavailable();
        pending.capabilities.set(admission.capability, selectedDigest);
      } else if (bound !== selectedDigest) unavailable();
      return { ...probe, assertCurrent: () => this.assertPending(key, pending) };
    }
    return undefined;
  }
}
