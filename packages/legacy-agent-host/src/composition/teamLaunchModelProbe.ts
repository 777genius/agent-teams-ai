import { z } from 'zod';

import { captureReadinessPreparation, originalReadinessSubset } from '../adapters/providers/OpenCodeReadinessOrigin.js';
import type { LocalModelReadinessPreparation } from '../management/commandRecords.js';
import { TeamLaunchError } from '../team-launch/contracts.js';
import { actualCaptureReadinessCommandId, modelReadinessMechanismDigest } from '../team-launch/launchReadiness.js';
import { runtimeDigest } from '../runtime/identity.js';
import { isNativeProfilePath } from './nativeProcessProfile.js';
import {
  resolveTeamModelProbeRecipe,
  applyTeamModelProbeSelection,
} from './teamModelProbeRecipe.js';

import type { MemberEntry } from './MemberEntry.js';
import type { RuntimeMemberProfile, RuntimeProfile } from './runtimeProfile.js';
import type { TeamLaunchOwner } from '../team-launch/TeamLaunchOwner.js';
import type { ProviderManagementProfile } from '../management/profile.js';
import type { ProviderManagementCoordinator } from './ProviderManagementCoordinator.js';
import type { RuntimeTeamCoordinator } from './RuntimeTeamCoordinator.js';

const id = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/[\0\r\n]/u.test(value));
export const teamModelProbeSelectionSchema = z
  .object({
    launchId: id,
    rosterRevision: id,
    memberId: id,
    model: id,
    effort: z
      .enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
      .optional(),
    context: z.enum(['model-default', 'one-million']).optional(),
    draft: z
      .object({
        providerId: z.enum(['anthropic', 'codex', 'opencode']),
        target: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('lead') }).strict(),
          z.object({ kind: z.literal('member'), name: id, originalName: id.optional() }).strict(),
        ]),
        workspace: z
          .string()
          .min(1)
          .max(8192)
          .refine((value) => !/[\0\r\n]/u.test(value))
          .optional(),
      })
      .strict()
      .superRefine((value, context) => {
        // Native OS comes from this Host; the captured profile still owns the
        // executable, broker and directory identity before any allocation.
        if (value.workspace !== undefined &&
          !isNativeProfilePath(value.workspace)) {
          context.addIssue({ code: 'custom', path: ['workspace'],
            message: 'Model probe workspace must match the selected native platform' });
        }
      })
      .optional(),
  })
  .strict();
export type TeamModelProbeSelection = z.infer<typeof teamModelProbeSelectionSchema>;

/** Native mechanism config is derived from the exact private Runtime selection, never a global default. */
export function teamModelProbeProfile(base: RuntimeMemberProfile): ProviderManagementProfile {
  // Old externally supplied V2 sessions have no finite owned model-probe path.
  if (base.provider === 'opencode' && base.nativeGeneration === 'v2' &&
      (base.protocolRevision !== '2.1.4' || !base.embedded))
    throw new TeamLaunchError('invalid', 'probe-v2-unsupported');
  const key = `team-probe-${runtimeDigest(base)}`;
  const common = {
    profileId: key,
    configRevision: key,
    cwd: base.cwd,
    executable: { ...base.executable },
    environment: { ...base.environment },
    ...(base.windowsBroker ? { windowsBroker: { ...base.windowsBroker } } : {}),
    accountBinding: base.accountBinding,
    timeoutMs: Math.min(base.limits.timeoutMs, 30000),
    modelProbeTimeoutMs: 90000,
  };
  if (base.provider === 'codex')
    return {
      ...common,
      provider: 'codex',
      protocolRevision: base.protocolRevision,
      ...(base.nativeOptions.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: base.nativeOptions.reasoningEffort }),
      ...(base.nativeOptions.fastMode === undefined
        ? {}
        : { fastMode: base.nativeOptions.fastMode }),
      ...(base.nativeOptions.modelProvider === undefined
        ? {}
        : { modelProvider: base.nativeOptions.modelProvider }),
    };
  if (base.provider === 'opencode')
    return {
      ...common,
      provider: 'opencode',
      endpoint: base.endpoint,
      ...(base.managedPreferences ? { managedPreferences: structuredClone(base.managedPreferences) } : {}),
      ...(base.nativeOptions.variant === undefined ? {} : { variant: base.nativeOptions.variant }),
      ...(base.nativeGeneration === 'v2' ? {
        nativeGeneration: 'v2' as const, protocolRevision: '2.1.4' as const,
        embedded: structuredClone(base.embedded!),
        nativeModel: { providerId: base.nativeOptions.providerId, modelId: base.model },
      } : {}),
    };
  return {
    ...common,
    provider: 'claude',
    sdkRevision: '0.3.305',
    configNamespace: base.configNamespace ?? 'custom-directory',
    ...(base.nativeOptions?.settingSources
      ? { settingSources: [...base.nativeOptions.settingSources] }
      : {}),
  };
}

export const teamModelProbeContext = (teamId: string, input: TeamModelProbeSelection) =>
  runtimeDigest({ teamId, input });

/** Product publication is committed only by the original retained prospective admission. */
export const teamModelProbeActionDigest = (commandId: string, context: string, productRosterRevision?: string) =>
  runtimeDigest(productRosterRevision === undefined
    ? { commandId, context } : { commandId, context, productRosterRevision });

export function teamModelProbeEffort(
  profile: RuntimeMemberProfile
): TeamModelProbeSelection['effort'] {
  const value =
    profile.provider === 'claude'
      ? profile.nativeOptions?.effort
      : profile.provider === 'codex'
        ? profile.nativeOptions.reasoningEffort
        : profile.nativeOptions.variant;
  const parsed = teamModelProbeSelectionSchema.shape.effort.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function probeOptions(profile: RuntimeMemberProfile) {
  return {
    providerId:
      profile.provider === 'claude'
        ? 'anthropic'
        : profile.provider === 'codex'
          ? 'codex'
          : profile.nativeOptions.providerId,
    effort: teamModelProbeEffort(profile),
    modelContext: profile.provider === 'claude' ? profile.nativeOptions?.context : undefined,
  };
}

/** No product or runtime mutation. Rechecks current Team authority before native handoff and result. */
export function captureTeamModelProbe(options: {
  launch: TeamLaunchOwner;
  entries: readonly MemberEntry[];
  team: import('./MemberEntry.js').HostedTeam;
  runtime: RuntimeProfile | undefined;
  sources?: import('./runtimeSourceContracts.js').RuntimeRecipeSources;
  sourceReference?: import('./runtimeSourceContracts.js').RuntimeSourceReference | undefined;
  input: TeamModelProbeSelection;
  action: 'start' | 'read' | 'cancel';
  principalId: string;
  assertCurrent(): void;
}) {
  const { input, launch } = options;
  const entry = options.entries.find((row) => row.profile.memberId === input.memberId);
  if (!entry && !input.draft) throw new TeamLaunchError('invalid', 'probe-member');
  const recipe = () =>
    resolveTeamModelProbeRecipe({
      runtime: options.runtime,
      team: options.team,
      input,
      saved: entry?.baseProfile,
      ...(options.sources ? { sources: options.sources } : {}),
      sourceReference: options.sourceReference,
    });
  const selected = recipe();
  const source = runtimeDigest({ entry: entry?.profile, recipe: selected });
  const profile = applyTeamModelProbeSelection(selected, input);
  const productRosterRevision = input.draft && profile.provider === 'opencode'
    ? options.team.connection.readRoster().revision : undefined;
  const authority = () => ({
    operator: options.team.owner.withLaunchAuthority(
      options.principalId,
      options.action === 'start' ? 'control' : 'read',
      (revision) => revision
    ),
    member:
      options.action === 'cancel' || input.draft
        ? null
        : options.team.owner.withLaunchAuthority(
            entry!.profile.principalId,
            'read',
            (revision) => revision
          ),
  });
  const admittedAuthority = authority();
  const assertSelection = () => {
    options.assertCurrent();
    const current = launch.readModelProbeSelection(
      options.action === 'start' ? 'control' : 'read'
    );
    if (options.action === 'cancel') return;
    if (
      !input.draft &&
      !entry!.team.owner.authorizeRuntimeAccess(
        entry!.profile.principalId,
        entry!.binding,
        'control'
      )
    )
      throw new TeamLaunchError('forbidden', 'probe-member');
    if (
      current.launchId !== input.launchId ||
      current.rosterRevision !== input.rosterRevision ||
      (productRosterRevision !== undefined && options.team.connection.readRoster().revision !== productRosterRevision) ||
      (!input.draft && !current.memberIds.includes(input.memberId)) ||
      runtimeDigest({ entry: entry?.profile, recipe: recipe() }) !== source ||
      runtimeDigest(authority()) !== runtimeDigest(admittedAuthority)
    )
      throw new TeamLaunchError('conflict', 'probe-selection');
  };
  assertSelection();
  return {
    profile: teamModelProbeProfile(profile.provider === 'claude' ? selected : profile),
    ...(productRosterRevision === undefined ? {} : { productRosterRevision }),
    provenance: { teamBindingDigest: runtimeDigest(options.team.definition.binding),
      selectionDigest: runtimeDigest(input), sourceRevision: input.launchId, rosterRevision: input.rosterRevision,
      destinationKeys: [runtimeDigest(input.draft?.target ?? { launchId: input.launchId, memberId: input.memberId })] },
    readinessCapture: !input.draft && profile.provider === 'opencode' ? launch.readModelReadinessAdmission() : undefined,
    assertReadinessCapture: () => launch.assertModelReadinessCapture(input.memberId),
    context: input.draft
      ? teamModelProbeContext(options.team.definition.binding.teamId, input)
      : runtimeDigest({
          input,
          source: runtimeDigest(entry!.profile),
          authority: admittedAuthority,
        }),
    model: profile.model,
    ...probeOptions(profile),
    isCurrent: () => {
      try {
        assertSelection();
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Uses the existing model-probe journal/fence; this is not another lifecycle owner. */
export async function executeTeamModelProbe(options: {
  runtime: Pick<RuntimeTeamCoordinator, 'captureLaunchModelProbe'>;
  management: Pick<ProviderManagementCoordinator, 'admitTeamProbeProfile' | 'probes'>;
  teamId: string;
  action: 'start' | 'read' | 'cancel';
  commandId: string;
  payload: unknown;
  readiness?: { preparation: LocalModelReadinessPreparation; owner: unknown; handleId: string; scope: unknown };
}) {
  const admittedAt = Date.now();
  const input = teamModelProbeSelectionSchema.parse(options.payload);
  const captured = options.runtime.captureLaunchModelProbe(options.teamId, input, options.action);
  const owner = options.management.probes;
  if (captured.profile === null) {
    if (options.action !== 'cancel') throw new TeamLaunchError('invalid', 'probe-cleanup');
    const value = await owner.cancelContextual(options.commandId, captured.context);
    if (
      (!input.draft &&
        value.modelId !== input.model &&
        input.model !== `${value.providerId}/${value.modelId}`) ||
      (input.effort !== undefined && value.effort !== input.effort) ||
      (input.context !== undefined && value.modelContext !== input.context)
    )
      throw new TeamLaunchError('conflict', 'probe-selection');
    return {
      ...input,
      commandId: options.commandId,
      phase: value.phase,
      ok: false,
      expiresAt: value.expiresAt,
    };
  }
  options.management.admitTeamProbeProfile(captured.profile);
  const identity = {
    commandId: options.commandId,
    profileId: captured.profile.profileId,
    configRevision: captured.profile.configRevision,
  };
  const retained = captured.profile.provider === 'opencode' && options.action === 'start' && owner.read(identity)
    ? owner.readRetainedProbe(options.commandId, captured.context) : undefined;
  const prepared = options.action === 'start' && options.readiness ? captureReadinessPreparation(
    options.readiness.preparation, {
      kind: 'team', owner: options.readiness.owner,
      // Main's context ID is trusted composition provenance; scope is independently Host-authorized.
      contextId: options.readiness.preparation.origin.contextId, commandId: options.commandId,
      selection: { handleId: options.readiness.handleId, scope: options.readiness.scope, payload: input },
      workspaces: [captured.profile.cwd], anchorCommandId: options.commandId,
      targets: [{ workspace: captured.profile.cwd, providerId: captured.providerId }],
      original: owner.readPreparation(options.commandId), admittedAt,
    }
  ) : undefined;
  if (prepared && captured.profile.provider !== 'opencode') throw new TeamLaunchError('invalid', 'probe-origin');
  const capture = captured.readinessCapture;
  const parent = capture && options.commandId ===
    actualCaptureReadinessCommandId(capture.preparationId, capture.commandId, input.memberId) ? capture : undefined;
  if (parent && options.action === 'start') {
    const target = parent.targets.find(row => row.memberId === input.memberId);
    if (!prepared || parent.phase !== 'captured' || !target || target.retired || target.originalWorkspace === captured.profile.cwd ||
        options.commandId !== actualCaptureReadinessCommandId(parent.preparationId, parent.commandId, input.memberId) ||
        Date.now() >= parent.cutoff)
      throw new TeamLaunchError('hold', 'probe-capture-continuation');
    if (!captured.assertReadinessCapture) throw new TeamLaunchError('hold', 'probe-capture-continuation');
    captured.assertReadinessCapture();
    prepared.anchor.expiresAt = Math.min(prepared.anchor.expiresAt, parent.cutoff);
  }
  const origin = prepared ? originalReadinessSubset(prepared.origin, captured.profile.cwd, captured.providerId) : undefined;
  const legacyActionDigest = teamModelProbeActionDigest(options.commandId, captured.context);
  const productRosterRevision = 'productRosterRevision' in captured ? captured.productRosterRevision : undefined;
  const privateScope = captured.profile.provider === 'opencode' && (!retained || retained.readinessScope) ? {
    schemaVersion: 1 as const, kind: 'team' as const, ...captured.provenance,
    actionDigest: retained?.readinessScope?.actionDigest === legacyActionDigest ? legacyActionDigest
      : teamModelProbeActionDigest(options.commandId, captured.context, productRosterRevision),
    mechanismDigest: modelReadinessMechanismDigest(captured.profile), workspace: captured.profile.cwd,
    cutoff: retained?.readinessScope?.cutoff ?? Math.min(prepared?.anchor.expiresAt ?? admittedAt + (captured.profile.modelProbeTimeoutMs ?? 90000),
      parent?.cutoff ?? Infinity),
  } : undefined;
  const value =
    options.action === 'start'
      ? owner.startPrepared(
          {
            ...identity,
            providerId: captured.providerId,
            modelId: captured.model,
            ...(captured.effort === undefined ? {} : { effort: captured.effort }),
            ...(captured.modelContext === undefined ? {} : { modelContext: captured.modelContext }),
            context: captured.context,
          },
          () => {
            if (parent) captured.assertReadinessCapture!();
            return captured.isCurrent();
          },
          prepared && origin ? { anchor: prepared.anchor, origin } : undefined,
          privateScope
        )
      : options.action === 'cancel'
        ? await owner.cancel(identity)
        : owner.readCurrent(identity);
  // Durable absence under the current owner is distinct from a stale selection.
  // Callers may then submit the same original ID; UNKNOWN is never absence.
  if (value === null && options.action === 'read') return null;
  if (
    !value ||
    value.modelId !== captured.model ||
    value.effort !== captured.effort ||
    value.modelContext !== captured.modelContext ||
    (options.action !== 'cancel' && (value.context !== captured.context || !captured.isCurrent()))
  )
    throw new TeamLaunchError('conflict', 'probe-selection');
  return {
    commandId: options.commandId,
    launchId: input.launchId,
    rosterRevision: input.rosterRevision,
    memberId: input.memberId,
    model: input.model,
    ...(input.draft === undefined ? {} : { draft: input.draft }),
    ...(captured.effort === undefined ? {} : { effort: captured.effort }),
    ...(captured.modelContext === undefined ? {} : { context: captured.modelContext }),
    phase: value.phase,
    ok: value.ok && Date.now() < value.expiresAt,
    expiresAt: value.expiresAt,
  };
}
