import { projectLaunchSnapshot } from './projectLaunchSnapshot';

import type {
  BackendLaunchConfigurationView,
  BackendLaunchModelConfigurationView,
  BackendLaunchOption,
} from '../../../contracts/launch';

function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid launch configuration');
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0'))
    throw new Error('Invalid launch configuration');
  return value;
}
function choice<const T extends string>(value: unknown, values: readonly T[]): T {
  if (!values.includes(value as T)) throw new Error('Invalid launch configuration');
  return value as T;
}

/** Only selected user choices and the contextual workspace; no credential/process configuration. */
export function projectLaunchConfiguration(value: unknown): BackendLaunchConfigurationView {
  if (Buffer.byteLength(JSON.stringify(value)) > 256 * 1024)
    throw new Error('Oversized launch configuration');
  const source = row(value),
    launch = projectLaunchSnapshot(source.launch);
  const members = projectMembers(
    source.members,
    launch.members.map((member) => member.memberId)
  );
  return { launch, members };
}

/** Explicit model source identities only; never synthesize a launch observation. */
export function projectLaunchModelConfiguration(
  value: unknown
): BackendLaunchModelConfigurationView {
  if (Buffer.byteLength(JSON.stringify(value)) > 256 * 1024)
    throw new Error('Oversized model configuration');
  const source = row(value),
    identity = row(source.source);
  return {
    source: { sourceId: text(identity.sourceId), rosterRevision: text(identity.rosterRevision) },
    members: projectMembers(source.members),
  };
}

function projectMembers(
  value: unknown,
  expectedIds?: string[]
): BackendLaunchConfigurationView['members'] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 256 ||
    (expectedIds && value.length !== expectedIds.length)
  )
    throw new Error('Invalid launch roster');
  const members = value.map((value) => {
    const member = row(value),
      memberId = text(member.memberId),
      label = text(member.label);
    const role = choice(member.role, ['lead', 'member']);
    if (expectedIds && !expectedIds.includes(memberId)) throw new Error('Wrong launch member');
    if (member.selected === null) return { memberId, label, role, selected: null };
    const selected = row(member.selected);
    if (!Array.isArray(selected.capabilities) || selected.capabilities.length > 5)
      throw new Error('Invalid launch capabilities');
    const capabilities = selected.capabilities.map((value) =>
      choice<BackendLaunchOption>(value, ['model', 'effort', 'fastMode', 'permissions', 'context'])
    );
    if (new Set(capabilities).size !== capabilities.length || !capabilities.includes('model'))
      throw new Error('Invalid launch capabilities');
    const options: NonNullable<BackendLaunchConfigurationView['members'][number]['selected']> = {
      provider: choice(selected.provider, ['claude', 'codex', 'opencode']),
      model: text(selected.model),
      workspace: text(selected.workspace, 8192),
      capabilities,
    };
    if (selected.workspaceInherited !== undefined) {
      if (typeof selected.workspaceInherited !== 'boolean')
        throw new Error('Invalid workspace source');
      options.workspaceInherited = selected.workspaceInherited;
    }
    if (selected.effort !== undefined)
      options.effort = choice(selected.effort, [
        'none',
        'minimal',
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
        'ultra',
      ]);
    if (selected.fastMode !== undefined) {
      if (typeof selected.fastMode !== 'boolean') throw new Error('Invalid fast mode');
      options.fastMode = selected.fastMode;
    }
    if (selected.permissions !== undefined)
      options.permissions = choice(selected.permissions, ['manual', 'bypass']);
    if (selected.context !== undefined)
      options.context = choice(selected.context, ['model-default', 'one-million']);
    for (const key of ['effort', 'fastMode', 'permissions', 'context'] as const)
      if (options[key] !== undefined && !capabilities.includes(key))
        throw new Error('Unadvertised launch option');
    return { memberId, label, role, selected: options };
  });
  if (new Set(members.map((member) => member.memberId)).size !== members.length)
    throw new Error('Duplicate launch member');
  if (
    members.filter((member) => member.role === 'lead').length !== 1 ||
    new Set(members.map((member) => member.label)).size !== members.length
  )
    throw new Error('Invalid launch roles');
  return members;
}
