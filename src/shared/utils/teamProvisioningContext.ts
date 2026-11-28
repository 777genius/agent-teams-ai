import { captureCreatedTeamDraft } from './createdTeamReadiness';
import { isTeamProviderId } from './teamProvider';

import type { TeamsAPI } from '../types/api';
import type {
  TeamCreateRequest,
  TeamProvisioningModelCheckRequest,
  TeamProvisioningModelTarget,
  TeamProvisioningPrepareContext,
} from '../types/team';

/** Keep the original Team/default-create intent across all provider/model stages. */
export function bindTeamProvisioningContext(
  prepare: TeamsAPI['prepareProvisioning'],
  context: TeamProvisioningPrepareContext
): TeamsAPI['prepareProvisioning'] {
  const captured = Object.freeze(parseTeamProvisioningContext(context)!);
  return (cwd, providerId, providerIds, models, limitContext, mode, checks) =>
    prepare(cwd, providerId, providerIds, models, limitContext, mode, checks, captured);
}

export function parseTeamProvisioningContext(
  value: unknown
): TeamProvisioningPrepareContext | undefined {
  if (value === undefined) return undefined;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const input = value as Record<string, unknown>;
    if (
      input.kind === 'create' &&
      Object.hasOwn(input, 'kind') &&
      Object.keys(input).every((key) => ['kind', 'preparationId', 'draft'].includes(key))
    ) {
      if (Object.keys(input).length === 1) return { kind: 'create' };
      if (
        !Object.hasOwn(input, 'preparationId') ||
        !Object.hasOwn(input, 'draft') ||
        typeof input.preparationId !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.preparationId) ||
        !input.draft ||
        typeof input.draft !== 'object' ||
        Array.isArray(input.draft) ||
        Object.keys(input.draft).some((key) =>
          ['command', 'savedSettingsFingerprint', 'createdTeamReadiness'].includes(key)
        ) ||
        JSON.stringify(input.draft).length > 512 * 1024
      )
        throw new Error('Invalid provisioning context');
      return {
        kind: 'create',
        preparationId: input.preparationId,
        draft: captureCreatedTeamDraft(input.draft as TeamCreateRequest),
      };
    }
    if (
      input.kind === 'team' &&
      Object.keys(input).every((key) =>
        ['kind', 'teamName', 'selectedModelChecks', 'preparationId'].includes(key)
      ) &&
      Object.hasOwn(input, 'kind') &&
      Object.hasOwn(input, 'teamName') &&
      typeof input.teamName === 'string' &&
      input.teamName.length > 0 &&
      input.teamName.length <= 8192 &&
      !/[\0\r\n]/u.test(input.teamName)
    ) {
      if (Object.hasOwn(input, 'selectedModelChecks') && input.selectedModelChecks === undefined)
        throw new Error('Invalid provisioning context');
      if (input.selectedModelChecks !== undefined && !Object.hasOwn(input, 'selectedModelChecks'))
        throw new Error('Invalid provisioning context');
      if (
        'preparationId' in input &&
        (!Object.hasOwn(input, 'preparationId') ||
          typeof input.preparationId !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.preparationId))
      )
        throw new Error('Invalid provisioning context');
      const checks =
        input.selectedModelChecks === undefined
          ? undefined
          : captureChecks(input.selectedModelChecks);
      return {
        kind: 'team',
        teamName: input.teamName,
        ...(checks === undefined ? {} : { selectedModelChecks: checks }),
        ...(input.preparationId === undefined
          ? {}
          : { preparationId: input.preparationId as string }),
      };
    }
  }
  throw new Error('Invalid provisioning context');
}

function captureChecks(value: unknown): TeamProvisioningModelCheckRequest[] {
  if (!Array.isArray(value) || value.length > 256) throw new Error('Invalid provisioning context');
  let targetCount = 0;
  const checks = Array.from(value, (entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('Invalid provisioning context');
    const row = entry as Record<string, unknown>;
    if (
      !Object.hasOwn(row, 'providerId') ||
      !Object.hasOwn(row, 'model') ||
      !isTeamProviderId(row.providerId) ||
      typeof row.model !== 'string' ||
      !row.model.trim() ||
      row.model.length > 256 ||
      /[\0\r\n]/u.test(row.model) ||
      Object.keys(row).some((key) => !['providerId', 'model', 'effort', 'targets'].includes(key)) ||
      (row.effort !== undefined && !Object.hasOwn(row, 'effort')) ||
      (Object.hasOwn(row, 'effort') &&
        !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(
          String(row.effort)
        ))
    )
      throw new Error('Invalid provisioning context');
    if (
      'targets' in row &&
      (!Object.hasOwn(row, 'targets') ||
        !Array.isArray(row.targets) ||
        row.targets.length === 0 ||
        row.targets.length > 256)
    )
      throw new Error('Invalid provisioning context');
    const targets =
      row.targets === undefined ? undefined : Array.from(row.targets as unknown[], captureTarget);
    targetCount += targets?.length ?? 0;
    if (targetCount > 256) throw new Error('Invalid provisioning context');
    if (targets) Object.freeze(targets);
    return Object.freeze({
      providerId: row.providerId,
      model: row.model.trim(),
      ...(row.effort === undefined
        ? {}
        : { effort: row.effort as TeamProvisioningModelCheckRequest['effort'] }),
      ...(targets === undefined ? {} : { targets }),
    });
  });
  Object.freeze(checks);
  return checks;
}

function captureTarget(value: unknown): TeamProvisioningModelTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid provisioning context');
  const row = value as Record<string, unknown>;
  if (!Object.hasOwn(row, 'kind')) throw new Error('Invalid provisioning context');
  if (row.kind === 'lead' && Object.keys(row).length === 1) return Object.freeze({ kind: 'lead' });
  const name = (value: unknown): value is string =>
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 256 &&
    !/[\0\r\n]/u.test(value);
  if (
    row.kind !== 'member' ||
    !Object.hasOwn(row, 'name') ||
    !name(row.name) ||
    Object.keys(row).some((key) => !['kind', 'name', 'originalName'].includes(key)) ||
    ('originalName' in row && (!Object.hasOwn(row, 'originalName') || !name(row.originalName)))
  )
    throw new Error('Invalid provisioning context');
  return Object.freeze({
    kind: 'member',
    name: row.name.trim(),
    ...(row.originalName === undefined
      ? {}
      : { originalName: (row.originalName as string).trim() }),
  });
}
