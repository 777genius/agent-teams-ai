import type { OpenCodeInstallGeneration, OpenCodeRuntimeInstallOptions } from '../../contracts';

/** Keep updates in their installed generation; fresh installs default to stable V1. */
export function chooseOpenCodeInstallGeneration(
  requested: OpenCodeInstallGeneration | undefined,
  installedVersion: string | undefined,
  _qualifiedV2Version: string | null
): OpenCodeInstallGeneration {
  if (requested) return requested;
  if (installedVersion?.startsWith('2.')) return 'v2';
  if (installedVersion?.startsWith('1.')) return 'v1';
  return 'v1';
}

export function parseOpenCodeInstallOptions(value: unknown): OpenCodeRuntimeInstallOptions {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid OpenCode install options');
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => key !== 'generation' && key !== 'supportOnly') ||
    (record.supportOnly !== undefined && typeof record.supportOnly !== 'boolean') ||
    (record.supportOnly === true && record.generation === 'v1') ||
    (record.generation !== undefined && record.generation !== 'v1' && record.generation !== 'v2')
  )
    throw new Error('Invalid OpenCode install generation');
  return {
    ...(record.generation === undefined ? {} : { generation: record.generation }),
    ...(record.supportOnly === undefined ? {} : { supportOnly: record.supportOnly }),
  };
}
