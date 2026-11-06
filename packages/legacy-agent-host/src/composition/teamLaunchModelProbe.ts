import { z } from 'zod';

import { TeamLaunchError } from '../team-launch/contracts.js';
import { runtimeDigest } from '../runtime/identity.js';
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
          .startsWith('/')
          .refine((value) => !/[\0\r\n]/u.test(value))
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type TeamModelProbeSelection = z.infer<typeof teamModelProbeSelectionSchema>;

/** Native mechanism config is derived from the exact private Runtime selection, never a global default. */
export function teamModelProbeProfile(base: RuntimeMemberProfile): ProviderManagementProfile {
  const key = `team-probe-${runtimeDigest(base)}`;
  const common = {
    profileId: key,
    configRevision: key,
    cwd: base.cwd,
    executable: { ...base.executable },
    environment: { ...base.environment },
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
      ...(base.nativeOptions.variant === undefined ? {} : { variant: base.nativeOptions.variant }),
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
    });
  const selected = recipe();
  const source = runtimeDigest({ entry: entry?.profile, recipe: selected });
  const profile = applyTeamModelProbeSelection(selected, input);
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
    const current = launch.read(options.action === 'start' ? 'control' : 'read');
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
      (!input.draft && !current.members.some((row) => row.memberId === input.memberId)) ||
      runtimeDigest({ entry: entry?.profile, recipe: recipe() }) !== source ||
      runtimeDigest(authority()) !== runtimeDigest(admittedAuthority)
    )
      throw new TeamLaunchError('conflict', 'probe-selection');
  };
  assertSelection();
  return {
    profile: teamModelProbeProfile(profile.provider === 'claude' ? selected : profile),
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
}) {
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
  const value =
    options.action === 'start'
      ? owner.start(
          {
            ...identity,
            providerId: captured.providerId,
            modelId: captured.model,
            ...(captured.effort === undefined ? {} : { effort: captured.effort }),
            ...(captured.modelContext === undefined ? {} : { modelContext: captured.modelContext }),
            context: captured.context,
          },
          captured.isCurrent
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
