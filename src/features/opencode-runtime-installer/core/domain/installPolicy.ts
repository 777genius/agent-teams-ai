import type { OpenCodeInstallGeneration, OpenCodeRuntimeInstallOptions } from '../../contracts';

/** Updates stay in their selected generation; fresh installs prefer qualified V2. */
export function chooseOpenCodeInstallGeneration(
  requested: OpenCodeInstallGeneration | undefined,
  installedVersion: string | undefined,
  qualifiedV2Version: string | null
): OpenCodeInstallGeneration {
  if (requested) return requested;
  if (installedVersion?.startsWith('2.')) return 'v2';
  if (installedVersion?.startsWith('1.')) return 'v1';
  return qualifiedV2Version ? 'v2' : 'v1';
}

export function parseOpenCodeInstallOptions(value: unknown): OpenCodeRuntimeInstallOptions {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid OpenCode install options');
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => key !== 'generation') ||
    (record.generation !== undefined && record.generation !== 'v1' && record.generation !== 'v2')
  )
    throw new Error('Invalid OpenCode install generation');
  return record.generation === undefined ? {} : { generation: record.generation };
}
